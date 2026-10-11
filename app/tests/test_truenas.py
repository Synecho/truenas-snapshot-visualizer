"""Tests for the TrueNAS API client against a fake middleware server."""

import json

import pytest
from aiohttp import web

from snapviz.sources.truenas import (
    TrueNASError, TrueNASSource, parse_dataset, parse_host, parse_snapshot, to_int, to_timestamp,
)

KEY = "1-abcdef"


def prop(raw, value=None):
    return {"parsed": int(raw), "rawvalue": str(raw), "value": value or str(raw), "source": "NONE"}


SNAPSHOTS = [
    {
        "id": "tank/data@auto-1", "name": "tank/data@auto-1", "dataset": "tank/data", "snapshot_name": "auto-1",
        "pool": "tank", "type": "SNAPSHOT", "createtxg": "100",
        "properties": {
            "used": prop(1000, "1000B"), "referenced": prop(5000), "written": prop(1200),
            "creation": {"parsed": {"$date": 1790000000000}, "rawvalue": "1790000000", "value": "Fri ...", "source": "NONE"},
            "userrefs": prop(1),
        },
    },
    {
        # TrueNAS 27 style: plain ints, no rawvalue
        "id": "tank/data@manual", "name": "tank/data@manual", "dataset": "tank/data", "snapshot_name": "manual",
        "properties": {"used": {"value": 2000, "raw": "2000"}, "creation": {"raw": "1780000000", "value": 1780000000}},
    },
]

DATASETS = [
    {"id": "tank", "name": "tank", "pool": "tank", "type": "FILESYSTEM", "used": prop(9000), "usedbysnapshots": prop(0),
     "usedbydataset": prop(100), "usedbychildren": prop(8900), "available": prop(100000)},
    {"id": "tank/data", "name": "tank/data", "pool": "tank", "type": "FILESYSTEM", "used": prop(8900),
     "usedbysnapshots": prop(3500), "usedbydataset": prop(5400), "usedbychildren": prop(0), "available": prop(100000)},
]


def make_app(*, legacy=False, has_pool_snapshot=True, key_ok=True):
    calls = []

    def dispatch(method, params):
        calls.append((method, params))
        if method == "auth.login_with_api_key":
            return params[0] == KEY and key_ok
        if method == "system.info":
            return {"hostname": "truenas-test", "version": "TrueNAS-25.10.1"}
        if method == "pool.snapshot.query" and has_pool_snapshot:
            assert params[1]["extra"]["properties"]
            return SNAPSHOTS
        if method == "zfs.snapshot.query" and not has_pool_snapshot:
            return SNAPSHOTS
        if method == "pool.dataset.query":
            return DATASETS
        raise LookupError(method)

    async def jsonrpc(request):
        if legacy:
            raise web.HTTPNotFound()
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        async for msg in ws:
            req = json.loads(msg.data)
            # an unrelated notification first, like real middleware event subscriptions
            await ws.send_str(json.dumps({"jsonrpc": "2.0", "method": "collection_update", "params": {}}))
            try:
                result = dispatch(req["method"], req.get("params", []))
                await ws.send_str(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}))
            except LookupError:
                await ws.send_str(json.dumps({"jsonrpc": "2.0", "id": req["id"],
                                              "error": {"code": -32601, "message": "Method not found"}}))
        return ws

    async def ddp(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        async for msg in ws:
            req = json.loads(msg.data)
            if req.get("msg") == "connect":
                await ws.send_str(json.dumps({"msg": "connected", "session": "x"}))
                continue
            try:
                result = dispatch(req["method"], req.get("params", []))
                await ws.send_str(json.dumps({"msg": "result", "id": req["id"], "result": result}))
            except LookupError:
                await ws.send_str(json.dumps({"msg": "result", "id": req["id"],
                                              "error": {"error": 89, "errname": "ENOSYS", "reason": "Method does not exist"}}))
        return ws

    app = web.Application()
    app.router.add_get("/api/current", jsonrpc)
    app.router.add_get("/websocket", ddp)
    app["calls"] = calls
    return app


@pytest.mark.parametrize("variant", [
    dict(),                                # 25.10 / 27
    dict(has_pool_snapshot=False),         # 25.04: only zfs.snapshot.query
    dict(legacy=True, has_pool_snapshot=False),  # 24.10: DDP protocol
])
async def test_fetch_variants(aiohttp_server, variant):
    server = await aiohttp_server(make_app(**variant))
    src = TrueNASSource(f"ws://127.0.0.1:{server.port}", KEY)
    report = await src.fetch()
    assert report.host == "truenas-test"
    assert [s.name for s in report.snapshots] == ["auto-1", "manual"]
    s = report.snapshots[0]
    assert (s.used, s.referenced, s.written, s.creation, s.holds) == (1000, 5000, 1200, 1790000000, 1)
    assert report.snapshots[1].used == 2000
    assert report.snapshots[1].creation == 1780000000
    ds = {d.name: d for d in report.datasets}
    assert ds["tank/data"].usedbysnapshots == 3500
    assert not report.warnings


async def test_self_signed_tls(aiohttp_server):
    trustme = pytest.importorskip("trustme")
    import ssl

    ca = trustme.CA()
    server_ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ca.issue_cert("truenas.local").configure_cert(server_ctx)
    server = await aiohttp_server(make_app(), ssl=server_ctx)

    report = await TrueNASSource(f"https://127.0.0.1:{server.port}", KEY, verify_tls=False).fetch()
    assert len(report.snapshots) == 2

    with pytest.raises(TrueNASError, match="Verify TLS"):
        await TrueNASSource(f"127.0.0.1:{server.port}", KEY, verify_tls=True).fetch()


async def test_rejected_key(aiohttp_server):
    server = await aiohttp_server(make_app(key_ok=False))
    with pytest.raises(TrueNASError, match="rejected"):
        await TrueNASSource(f"ws://127.0.0.1:{server.port}", KEY).fetch()


async def test_refuses_plain_ws_to_remote_host():
    src = TrueNASSource("http://192.168.1.10", KEY)
    with pytest.raises(TrueNASError, match="unencrypted"):
        await src.fetch()


async def test_missing_key():
    with pytest.raises(TrueNASError, match="No TrueNAS API key"):
        await TrueNASSource("nas.local", "").fetch()


def test_parse_host():
    assert parse_host("") == ("wss://host.docker.internal", "host.docker.internal")
    assert parse_host("10.0.0.5") == ("wss://10.0.0.5", "10.0.0.5")
    assert parse_host("https://nas.local:8443/") == ("wss://nas.local:8443", "nas.local")
    assert parse_host("http://127.0.0.1") == ("ws://127.0.0.1", "127.0.0.1")


def test_value_parsing():
    assert to_int(prop(42)) == 42
    assert to_int({"value": "1.5K"}) == 1536
    assert to_int(None) is None
    assert to_timestamp({"$date": 1790000000000}) == 1790000000
    assert to_timestamp({"parsed": 1790000000}) == 1790000000
    assert to_timestamp(1790000000000) == 1790000000
    snap = parse_snapshot({"name": "a/b@c", "properties": {}})
    assert (snap.dataset, snap.name, snap.used) == ("a/b", "c", None)
    ds = parse_dataset({"id": "a", "type": "VOLUME", "properties": {"used": prop(5)}})
    assert (ds.name, ds.type, ds.used) == ("a", "VOLUME", 5)
