"""Read datasets and snapshots through the TrueNAS middleware WebSocket API.

* TrueNAS 25.04+ : JSON-RPC 2.0 on wss://<host>/api/current
* TrueNAS 24.10  : legacy DDP-style protocol on wss://<host>/websocket (fallback)

Two ways to authenticate:

* Middleware socket (preferred when mounted): /var/run/middleware/middlewared.sock
  is world-connectable and TrueNAS authenticates the caller by its UID - root gets
  full access, other UIDs get the roles of the matching TrueNAS user. No key needed.
* API key over wss://. Keys are never sent over an unencrypted connection:
  TrueNAS revokes keys that are used over plain ws://.

Only read-only query methods are called.
"""

from __future__ import annotations

import asyncio
import ipaddress
import itertools
import json
import logging
import os
import ssl
import stat
from urllib.parse import urlsplit

import aiohttp

from ..model import Dataset, Snapshot, SnapshotReport, ensure_datasets
from .zfs_cli import _num, _time

log = logging.getLogger("snapviz.truenas")

SNAPSHOT_PROPS = ["used", "referenced", "written", "creation", "userrefs"]
DATASET_PROPS = ["used", "usedbysnapshots", "usedbydataset", "usedbychildren", "available", "referenced"]
CALL_TIMEOUT = 900  # snapshot queries on big systems can take minutes
DEFAULT_SOCKET = "/run/middleware/middlewared.sock"


class TrueNASError(RuntimeError):
    pass


class RpcError(TrueNASError):
    def __init__(self, method: str, message: str, code: int | None = None, errname: str | None = None):
        super().__init__(f"{method}: {message}")
        self.method = method
        self.reason = message or ""
        self.code = code
        self.errname = errname

    @property
    def method_missing(self) -> bool:
        r = self.reason.lower()
        return self.code == -32601 or "does not exist" in r or "method not found" in r

    @property
    def not_authorized(self) -> bool:
        return self.errname in ("EACCES", "EPERM") or "not authorized" in self.reason.lower()


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name, "")
    if not value:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def parse_host(host: str) -> tuple[str, str]:
    """Turn 'nas', '10.0.0.5:8443', 'https://nas/' ... into ('wss://nas', 'nas')."""
    host = (host or "").strip().rstrip("/")
    if not host:
        host = "host.docker.internal"
    if "://" not in host:
        host = "wss://" + host
    parts = urlsplit(host)
    scheme = {"http": "ws", "https": "wss", "ws": "ws", "wss": "wss"}.get(parts.scheme.lower())
    if not scheme or not parts.netloc:
        raise TrueNASError(f"Invalid TrueNAS host {host!r}")
    return f"{scheme}://{parts.netloc}{parts.path.rstrip('/')}", parts.hostname or ""


def _is_loopback(hostname: str) -> bool:
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


# ---------------------------------------------------------------- value parsing

def to_int(v) -> int | None:
    """Parse a ZFS property as returned by the various middleware versions."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v)
    if isinstance(v, str):
        return _num(v)
    if isinstance(v, dict):
        for key in ("rawvalue", "raw"):
            raw = v.get(key)
            if isinstance(raw, str) and raw.strip().isdigit():
                return int(raw)
            if isinstance(raw, int) and not isinstance(raw, bool):
                return raw
        parsed = v.get("parsed")
        if isinstance(parsed, (int, float)) and not isinstance(parsed, bool):
            return int(parsed)
        value = v.get("value")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return int(value)
        if isinstance(value, str):
            return _num(value)
    return None


def to_timestamp(v) -> int | None:
    """Parse the 'creation' property into unix seconds."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v / 1000) if v > 100_000_000_000 else int(v)
    if isinstance(v, str):
        return int(v) if v.strip().isdigit() else _time(v)
    if isinstance(v, dict):
        if "$date" in v:
            return int(v["$date"] / 1000)
        for key in ("rawvalue", "raw"):
            raw = v.get(key)
            if raw is not None:
                ts = to_timestamp(raw)
                if ts is not None:
                    return ts
        for key in ("parsed", "value"):
            if v.get(key) is not None:
                ts = to_timestamp(v[key])
                if ts is not None:
                    return ts
    return None


def parse_snapshot(row: dict) -> Snapshot:
    full = row.get("name") or row.get("id") or ""
    ds, _, snap = full.partition("@")
    props = row.get("properties") or {}
    holds = to_int(props.get("userrefs"))
    if holds is None and isinstance(row.get("holds"), dict):
        holds = len(row["holds"])
    return Snapshot(
        dataset=row.get("dataset") or ds,
        name=row.get("snapshot_name") or snap,
        used=to_int(props.get("used")),
        referenced=to_int(props.get("referenced")),
        written=to_int(props.get("written")),
        creation=to_timestamp(props.get("creation")),
        holds=holds or 0,
    )


def parse_dataset(row: dict) -> Dataset:
    nested = row.get("properties") if isinstance(row.get("properties"), dict) else {}

    def prop(name):
        return to_int(row[name] if name in row else nested.get(name))

    dtype = row.get("type")
    if isinstance(dtype, dict):
        dtype = dtype.get("value")
    return Dataset(
        name=row.get("name") or row.get("id"),
        type=(dtype or "FILESYSTEM").upper(),
        used=prop("used"),
        usedbysnapshots=prop("usedbysnapshots"),
        usedbydataset=prop("usedbydataset"),
        usedbychildren=prop("usedbychildren"),
        available=prop("available"),
        referenced=prop("referenced"),
    )


# ---------------------------------------------------------------- protocols

class _JsonRpc:
    """JSON-RPC 2.0 over WebSocket (TrueNAS 25.04+)."""

    legacy = False

    def __init__(self, ws: aiohttp.ClientWebSocketResponse):
        self.ws = ws
        self._ids = itertools.count(1)

    async def call(self, method: str, params: list | None = None):
        msg_id = next(self._ids)
        await self.ws.send_str(json.dumps({"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or []}))
        while True:
            data = await _receive_json(self.ws)
            if data.get("id") != msg_id:
                continue  # event notifications
            err = data.get("error")
            if err:
                info = err.get("data") if isinstance(err.get("data"), dict) else {}
                raise RpcError(
                    method,
                    info.get("reason") or err.get("message") or str(err),
                    code=err.get("code"),
                    errname=info.get("errname"),
                )
            return data.get("result")


class _Legacy:
    """DDP-style protocol of TrueNAS 24.10 on /websocket."""

    legacy = True

    def __init__(self, ws: aiohttp.ClientWebSocketResponse):
        self.ws = ws
        self._ids = itertools.count(1)

    async def handshake(self) -> None:
        await self.ws.send_str(json.dumps({"msg": "connect", "version": "1", "support": ["1"]}))
        while True:
            data = await _receive_json(self.ws)
            if data.get("msg") == "connected":
                return
            if data.get("msg") == "failed":
                raise TrueNASError("TrueNAS rejected the WebSocket protocol handshake")

    async def call(self, method: str, params: list | None = None):
        msg_id = str(next(self._ids))
        await self.ws.send_str(json.dumps({"id": msg_id, "msg": "method", "method": method, "params": params or []}))
        while True:
            data = await _receive_json(self.ws)
            if data.get("msg") != "result" or data.get("id") != msg_id:
                continue
            err = data.get("error")
            if err:
                if not isinstance(err, dict):
                    raise RpcError(method, str(err))
                raise RpcError(method, err.get("reason") or str(err), errname=err.get("errname"))
            return data.get("result")


async def _receive_json(ws: aiohttp.ClientWebSocketResponse) -> dict:
    try:
        msg = await ws.receive(timeout=CALL_TIMEOUT)
    except asyncio.TimeoutError:
        raise TrueNASError("Timed out waiting for TrueNAS") from None
    if msg.type == aiohttp.WSMsgType.TEXT:
        return json.loads(msg.data)
    if msg.type == aiohttp.WSMsgType.BINARY:
        return json.loads(msg.data.decode())
    if msg.type == aiohttp.WSMsgType.ERROR:
        raise TrueNASError(f"WebSocket error: {ws.exception()}")
    raise TrueNASError(f"TrueNAS closed the connection ({msg.type.name}{f', code {ws.close_code}' if ws.close_code else ''})")


# ---------------------------------------------------------------- source

class SocketNotAuthorized(TrueNASError):
    pass


class TrueNASSource:
    name = "truenas"

    def __init__(
        self,
        host: str,
        api_key: str,
        verify_tls: bool = False,
        username: str | None = None,
        socket_path: str | None = None,
    ):
        self.base_url, self.hostname = parse_host(host)
        self.api_key = (api_key or "").strip()
        self.verify_tls = verify_tls
        self.username = (username or "").strip() or None
        self.socket_path = socket_path or None

    @classmethod
    def from_env(cls) -> "TrueNASSource":
        return cls(
            host=os.environ.get("TRUENAS_HOST") or os.environ.get("TRUENAS_URL") or "host.docker.internal",
            api_key=os.environ.get("TRUENAS_API_KEY", ""),
            verify_tls=_env_bool("TRUENAS_VERIFY_TLS", False),
            username=os.environ.get("TRUENAS_USERNAME"),
            socket_path=os.environ.get("TRUENAS_SOCKET", DEFAULT_SOCKET)
            if _env_bool("TRUENAS_USE_SOCKET", True) else None,
        )

    def _socket_available(self) -> bool:
        if not self.socket_path:
            return False
        try:
            return stat.S_ISSOCK(os.stat(self.socket_path).st_mode)
        except OSError:
            return False

    def _ssl(self):
        if not self.base_url.startswith("wss://") or self.verify_tls:
            # plain ws:// (loopback only) ignores this; True = default verification
            return ssl.create_default_context()
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx

    def _check_config(self) -> None:
        if not self.api_key:
            raise TrueNASError(
                "No access to TrueNAS configured. Either mount the middleware socket "
                f"(/var/run/middleware -> {os.path.dirname(DEFAULT_SOCKET)}) or create an API key in TrueNAS "
                "(user menu > My API Keys) and enter it in the app settings."
            )
        if self.base_url.startswith("ws://") and not _is_loopback(self.hostname):
            raise TrueNASError(
                f"Refusing to send the API key over unencrypted {self.base_url}: TrueNAS revokes API keys "
                "used over plain HTTP. Use https:// (the default)."
            )

    async def _connect(self, session: aiohttp.ClientSession, base_url: str, ssl_ctx, label: str):
        kwargs = dict(ssl=ssl_ctx, max_msg_size=0, autoping=True, heartbeat=None)
        url = f"{base_url}/api/current"
        try:
            ws = await session.ws_connect(url, **kwargs)
            return _JsonRpc(ws)
        except aiohttp.WSServerHandshakeError as exc:
            if exc.status not in (400, 404, 405):
                raise TrueNASError(f"WebSocket handshake with {label} failed: HTTP {exc.status} {exc.message}") from None
            log.info("%s/api/current not available (HTTP %s), trying legacy /websocket (TrueNAS 24.10)", label, exc.status)
        except aiohttp.ClientConnectorCertificateError as exc:
            raise TrueNASError(
                f"TLS certificate of {self.hostname} could not be verified ({exc.certificate_error}). "
                "Disable 'Verify TLS Certificate' for the default self-signed certificate."
            ) from None
        except aiohttp.ClientConnectorError as exc:
            raise TrueNASError(f"Cannot connect to TrueNAS at {label}: {exc.os_error or exc}") from None
        except aiohttp.ClientError as exc:
            raise TrueNASError(f"Cannot connect to TrueNAS at {label}: {exc}") from None

        try:
            ws = await session.ws_connect(f"{base_url}/websocket", **kwargs)
        except aiohttp.ClientError as exc:
            raise TrueNASError(f"Cannot connect to TrueNAS at {label}: {exc}") from None
        conn = _Legacy(ws)
        await conn.handshake()
        return conn

    async def _login(self, conn) -> None:
        revoked_hint = (
            " If the key was ever used over plain HTTP, TrueNAS has revoked it; create a new one."
        )
        if self.username and not conn.legacy:
            res = await conn.call(
                "auth.login_ex",
                [{"mechanism": "API_KEY_PLAIN", "username": self.username, "api_key": self.api_key,
                  "login_options": {"user_info": False}}],
            )
            rtype = (res or {}).get("response_type")
            if rtype == "SUCCESS":
                return
            if rtype == "EXPIRED":
                raise TrueNASError("The TrueNAS API key is expired or was revoked." + revoked_hint)
            if rtype == "DENIED":
                raise TrueNASError(
                    "The API key's user lacks API access: add it to a group with the Read-Only Administrator role."
                )
            raise TrueNASError(f"TrueNAS login failed ({rtype}). Check API key and user name.")
        try:
            ok = await conn.call("auth.login_with_api_key", [self.api_key])
        except RpcError as exc:
            if exc.method_missing:
                raise TrueNASError(
                    "This TrueNAS version requires the user name that owns the API key: set TRUENAS_USERNAME."
                ) from None
            raise
        if not ok:
            # auth.login_with_api_key hides the reason; TrueNAS writes it to System > Audit
            raise TrueNASError(
                "TrueNAS rejected the API key. Common causes: the key's user is not in a group with a role "
                "such as Read-Only Administrator ('User lacks API access'), the key was copied incompletely "
                "(format <id>-<key>), or it expired / was revoked." + revoked_hint
                + " The exact reason is listed in TrueNAS under System > Audit (Authentication events)."
            )

    async def _socket_identity(self, conn) -> str:
        """TrueNAS authenticates socket connections by the caller's UID; check that it worked."""
        try:
            me = await conn.call("auth.me")
        except RpcError:
            me = None
        if not isinstance(me, dict):
            uid = os.getuid() if hasattr(os, "getuid") else "?"
            raise SocketNotAuthorized(
                f"Connected to the TrueNAS middleware socket, but the container user (UID {uid}) has no TrueNAS "
                "privileges. Run the container as root (user: \"0:0\") or as the UID of a TrueNAS user in a group "
                "with the Read-Only Administrator role - or configure an API key."
            )
        return me.get("pw_name") or me.get("username") or "?"

    async def _query_snapshots(self, conn) -> list[dict]:
        props = list(SNAPSHOT_PROPS)
        methods = ["pool.snapshot.query", "zfs.snapshot.query"]
        last: Exception | None = None
        for _ in range(2):
            opts = {"extra": {"properties": props, "holds": False, "retention": False}}
            for method in list(methods):
                try:
                    return await conn.call(method, [[], opts]) or []
                except RpcError as exc:
                    last = exc
                    if exc.method_missing:
                        methods.remove(method)
                        continue
                    if exc.not_authorized:
                        raise TrueNASError(
                            f"Not allowed to call {method}. The TrueNAS user needs the Read-Only Administrator role."
                        ) from None
                    break
            # retry once without the optional hold count, in case a version rejects it
            if "userrefs" not in props:
                break
            props.remove("userrefs")
            log.warning("Snapshot query failed (%s); retrying without 'userrefs'", last)
        raise last or TrueNASError("Snapshot query failed")

    async def _query_datasets(self, conn, warnings: list[str]) -> list[dict]:
        extra = {"flat": True, "retrieve_children": True, "properties": DATASET_PROPS}
        if not conn.legacy:
            extra["retrieve_user_props"] = False
        select = ["id", "name", "pool", "type", *DATASET_PROPS]
        attempts = [{"extra": extra, "select": select}, {"extra": extra}, {"extra": {"flat": True}}]
        for opts in attempts:
            try:
                return await conn.call("pool.dataset.query", [[], opts]) or []
            except RpcError as exc:
                log.warning("pool.dataset.query %s failed: %s", list(opts), exc)
                if exc.not_authorized:
                    break
        warnings.append("Dataset details unavailable (pool.dataset.query failed) - shared snapshot space cannot be shown.")
        return []

    async def _collect(self, conn, report: SnapshotReport) -> None:
        try:
            info = await conn.call("system.info")
            if isinstance(info, dict) and info.get("hostname"):
                report.host = info["hostname"]
        except RpcError:
            pass
        snaps = await self._query_snapshots(conn)
        datasets = await self._query_datasets(conn, report.warnings)

        seen: set[str] = set()
        for row in datasets:
            d = parse_dataset(row)
            if d.name and d.name not in seen:
                seen.add(d.name)
                report.datasets.append(d)
        report.snapshots = [parse_snapshot(r) for r in snaps if (r.get("name") or r.get("id"))]
        ensure_datasets(report)

    async def _fetch_socket(self) -> SnapshotReport:
        report = SnapshotReport(source="truenas", host="localhost")
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=None)
        connector = aiohttp.UnixConnector(path=self.socket_path)
        async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
            conn = await self._connect(session, "ws://localhost", True, self.socket_path)
            try:
                user = await self._socket_identity(conn)
                report.connection = f"socket ({user})"
                await self._collect(conn, report)
            finally:
                await conn.ws.close()
        return report

    async def _fetch_api_key(self) -> SnapshotReport:
        self._check_config()
        report = SnapshotReport(source="truenas", host=self.hostname, connection="API key")
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=None)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            conn = await self._connect(session, self.base_url, self._ssl(), self.base_url)
            try:
                await self._login(conn)
                await self._collect(conn, report)
            finally:
                await conn.ws.close()
        return report

    async def fetch(self) -> SnapshotReport:
        if self._socket_available():
            try:
                return await self._fetch_socket()
            except SocketNotAuthorized as exc:
                if not self.api_key:
                    raise
                log.warning("%s Falling back to the API key.", exc)
        return await self._fetch_api_key()

    async def close(self) -> None:
        pass
