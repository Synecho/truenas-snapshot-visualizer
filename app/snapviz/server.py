"""HTTP server: serves the static UI and a small JSON API backed by a cached source."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import web

from . import __version__
from .model import SnapshotReport
from .sources.zfs_cli import parse_listing

log = logging.getLogger("snapviz")

STATIC_DIR = Path(os.environ.get("SNAPVIZ_STATIC_DIR", Path(__file__).resolve().parent.parent / "static"))
MAX_IMPORT_BYTES = 64 * 1024 * 1024


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


# Datasets that are TrueNAS internals rather than user data; hidden in the UI by default (toggleable).
DEFAULT_EXCLUDE = ["*/.system*", "*/.ix-apps/docker*", "*/ix-applications/docker*", "*/ix-applications/k3s*"]


def _env_list(name: str, default: list[str]) -> list[str]:
    value = os.environ.get(name)
    if value is None:
        return list(default)
    return [p.strip() for p in value.split(",") if p.strip()]


def _report_json(request: web.Request, report) -> web.StreamResponse:
    body = report.to_json()
    body["exclude_patterns"] = request.app["exclude_patterns"]
    resp = web.json_response(body)
    resp.enable_compression()
    return resp


def make_source():
    kind = os.environ.get("SNAPVIZ_SOURCE", "truenas").strip().lower()
    if kind == "demo":
        from .sources.demo import DemoSource

        return DemoSource()
    if kind == "zfs":
        from .sources.zfs_cli import ZfsCliSource

        return ZfsCliSource()
    if kind == "truenas":
        from .sources.truenas import TrueNASSource

        return TrueNASSource.from_env()
    raise RuntimeError(f"Unknown SNAPVIZ_SOURCE={kind!r} (expected truenas, demo or zfs)")


class Cache:
    """Keeps the last report; refreshes at most once concurrently."""

    def __init__(self, source, ttl: int) -> None:
        self.source = source
        self.ttl = ttl
        self.report: SnapshotReport | None = None
        self.error: str | None = None
        self._lock = asyncio.Lock()

    async def get(self, force: bool = False) -> SnapshotReport:
        fresh = self.report and (time.time() - self.report.fetched_at) < self.ttl
        if fresh and not force:
            return self.report
        async with self._lock:
            # another request may have refreshed while we waited
            if self.report and not force and (time.time() - self.report.fetched_at) < self.ttl:
                return self.report
            start = time.monotonic()
            try:
                report = await self.source.fetch()
            except Exception as exc:
                self.error = str(exc) or exc.__class__.__name__
                if isinstance(exc, RuntimeError):  # expected errors (config, connection, auth)
                    log.error("Fetching snapshots failed: %s", self.error)
                else:
                    log.exception("Fetching snapshots failed")
                raise
            report.fetched_at = time.time()
            report.duration = time.monotonic() - start
            self.report, self.error = report, None
            log.info(
                "Fetched %d snapshots / %d datasets in %.1fs",
                len(report.snapshots), len(report.datasets), report.duration,
            )
            return report

    def invalidate(self) -> None:
        if self.report:
            self.report.fetched_at = 0.0


def _json_error(status: int, message: str) -> web.Response:
    return web.json_response({"error": message}, status=status)


async def handle_snapshots(request: web.Request) -> web.StreamResponse:
    cache: Cache = request.app["cache"]
    force = request.query.get("refresh") in ("1", "true")
    try:
        report = await cache.get(force=force)
    except Exception as exc:  # surfaced to the UI
        return _json_error(502, str(exc) or exc.__class__.__name__)
    return _report_json(request, report)


async def handle_import(request: web.Request) -> web.StreamResponse:
    if not request.app["allow_import"]:
        return _json_error(403, "Import is disabled")
    if request.content_length and request.content_length > MAX_IMPORT_BYTES:
        return _json_error(413, "File too large")
    text = (await request.read()).decode("utf-8", errors="replace")
    report = parse_listing(text, source="import")
    if not report.snapshots:
        return _json_error(400, "No snapshots found in the uploaded text")
    report.fetched_at = time.time()
    return _report_json(request, report)


MAX_DELETE = 5000


def _same_origin(request: web.Request) -> bool:
    """Reject cross-site requests: the UI has no login, so a foreign page must not trigger deletions."""
    origin = request.headers.get("Origin")
    if origin is None:
        return True  # non-browser clients; the custom header check below still applies
    return urlsplit(origin).netloc == request.host


async def handle_delete(request: web.Request) -> web.Response:
    cache: Cache = request.app["cache"]
    if not delete_enabled(request.app):
        return _json_error(403, "Deleting snapshots is disabled. Set SNAPVIZ_ALLOW_DELETE=true to enable it.")
    # A custom header and a JSON body force a CORS preflight, which we never answer -> no CSRF
    if request.headers.get("X-Snapviz-Action") != "delete" or request.content_type != "application/json":
        return _json_error(400, "Missing X-Snapviz-Action header or JSON body")
    if not _same_origin(request):
        return _json_error(403, "Cross-origin request rejected")
    try:
        body = await request.json()
        ids = body["snapshots"]
        assert isinstance(ids, list) and all(isinstance(i, str) for i in ids)
    except Exception:
        return _json_error(400, 'Expected {"snapshots": ["pool/dataset@snapshot", ...]}')
    ids = list(dict.fromkeys(ids))  # de-duplicate, keep order
    if not ids:
        return _json_error(400, "No snapshots given")
    if len(ids) > MAX_DELETE:
        return _json_error(400, f"At most {MAX_DELETE} snapshots per request")
    # only snapshots that exist in the data the user is looking at
    known = {s.full_name for s in cache.report.snapshots} if cache.report else set()
    unknown = [i for i in ids if "@" not in i or i not in known]
    if unknown:
        return _json_error(400, f"Unknown snapshot(s), reload the data first: {', '.join(unknown[:5])}")

    log.info("Deleting %d snapshot(s) on request from %s", len(ids), request.remote)
    try:
        results = await cache.source.delete(ids)
    except Exception as exc:
        return _json_error(502, str(exc) or exc.__class__.__name__)
    finally:
        cache.invalidate()
    ok = sum(1 for r in results if r["ok"])
    return web.json_response({"deleted": ok, "failed": len(results) - ok, "results": results})


def delete_enabled(app: web.Application) -> bool:
    return app["allow_delete"] and hasattr(app["cache"].source, "delete")


async def handle_status(request: web.Request) -> web.Response:
    cache: Cache = request.app["cache"]
    return web.json_response(
        {
            "version": __version__,
            "source": getattr(cache.source, "name", "?"),
            "cache_seconds": cache.ttl,
            "allow_import": request.app["allow_import"],
            "allow_delete": delete_enabled(request.app),
            "delete_supported": hasattr(cache.source, "delete"),
            "last_fetch": cache.report.fetched_at if cache.report else None,
            "last_error": cache.error,
        }
    )


async def handle_health(request: web.Request) -> web.Response:
    return web.Response(text="ok")


async def handle_index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@web.middleware
async def security_headers(request: web.Request, handler):
    resp = await handler(request)
    if request.path.startswith("/static/"):
        # revalidate via ETag/Last-Modified so app updates show up immediately
        resp.headers["Cache-Control"] = "no-cache"
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'",
    )
    return resp


def create_app() -> web.Application:
    app = web.Application(middlewares=[security_headers], client_max_size=MAX_IMPORT_BYTES)
    source = make_source()
    app["cache"] = Cache(source, ttl=int(os.environ.get("SNAPVIZ_CACHE_SECONDS", "300")))
    app["allow_import"] = _env_bool("SNAPVIZ_ALLOW_IMPORT", True)
    app["exclude_patterns"] = _env_list("SNAPVIZ_EXCLUDE_DATASETS", DEFAULT_EXCLUDE)
    app["allow_delete"] = _env_bool("SNAPVIZ_ALLOW_DELETE", False)
    if app["allow_delete"]:
        log.warning("Deleting snapshots via the web UI is ENABLED (SNAPVIZ_ALLOW_DELETE)")

    app.router.add_get("/", handle_index)
    app.router.add_get("/api/snapshots", handle_snapshots)
    app.router.add_post("/api/import", handle_import)
    app.router.add_post("/api/delete", handle_delete)
    app.router.add_get("/api/status", handle_status)
    app.router.add_get("/healthz", handle_health)
    app.router.add_static("/static/", STATIC_DIR)

    async def warm_up(app: web.Application) -> None:
        # fetch in the background so the first page load is fast
        async def _warm():
            try:
                await app["cache"].get()
            except Exception:
                pass

        app["warm_task"] = asyncio.create_task(_warm())

    async def close(app: web.Application) -> None:
        await app["cache"].source.close()

    app.on_startup.append(warm_up)
    app.on_cleanup.append(close)
    return app


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("SNAPVIZ_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    host = os.environ.get("SNAPVIZ_HOST", "0.0.0.0")
    port = int(os.environ.get("SNAPVIZ_PORT", "8080"))
    log.info("TrueNAS Snapshot Visualizer %s listening on %s:%d", __version__, host, port)
    web.run_app(create_app(), host=host, port=port, access_log=None, print=None)


if __name__ == "__main__":
    main()
