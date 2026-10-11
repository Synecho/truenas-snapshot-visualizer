import asyncio
import socket

import aiohttp
import pytest

from snapviz.listener import serve
from snapviz.server import create_app
from snapviz.tls import build_ssl_context


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
async def https_server(monkeypatch):
    monkeypatch.setenv("SNAPVIZ_SOURCE", "demo")
    monkeypatch.setenv("SNAPVIZ_TLS", "auto")
    monkeypatch.delenv("SNAPVIZ_DATA_DIR", raising=False)
    monkeypatch.delenv("SNAPVIZ_TLS_CERT", raising=False)
    port = _free_port()
    started = asyncio.Event()
    task = asyncio.create_task(serve(create_app(), "127.0.0.1", port, build_ssl_context(), started))
    await asyncio.wait_for(started.wait(), 10)
    yield port
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


async def test_plain_http_is_redirected_to_https(https_server):
    port = https_server
    async with aiohttp.ClientSession() as s:
        async with s.get(f"http://127.0.0.1:{port}/#treemap?x=1", allow_redirects=False) as r:
            assert r.status == 308
            assert r.headers["Location"] == f"https://127.0.0.1:{port}/"
        async with s.get(f"http://127.0.0.1:{port}/api/status?a=b", allow_redirects=False) as r:
            assert r.headers["Location"] == f"https://127.0.0.1:{port}/api/status?a=b"


async def test_https_is_served(https_server):
    port = https_server
    async with aiohttp.ClientSession() as s:
        async with s.get(f"https://127.0.0.1:{port}/healthz", ssl=False) as r:
            assert r.status == 200
            assert await r.text() == "ok"
        # following the redirect from http lands on the app
        async with s.get(f"http://127.0.0.1:{port}/healthz", ssl=False) as r:
            assert r.status == 200
            assert str(r.url).startswith("https://")


async def test_idle_connection_does_not_block_others(https_server):
    port = https_server
    # a client that connects but sends nothing must not stall the accept loop
    idle = socket.create_connection(("127.0.0.1", port))
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"https://127.0.0.1:{port}/healthz", ssl=False) as r:
                assert r.status == 200
    finally:
        idle.close()
