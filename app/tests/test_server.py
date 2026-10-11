import pytest

from snapviz.server import create_app


@pytest.fixture
def client(aiohttp_client, monkeypatch):
    monkeypatch.setenv("SNAPVIZ_SOURCE", "demo")
    return aiohttp_client(create_app())


async def test_index_and_health(client):
    c = await client
    r = await c.get("/")
    assert r.status == 200
    assert "Snapshot Visualizer" in await r.text()
    assert "Content-Security-Policy" in r.headers
    r = await c.get("/healthz")
    assert await r.text() == "ok"
    r = await c.get("/static/js/app.js")
    assert r.status == 200


async def test_snapshots_endpoint(client):
    c = await client
    r = await c.get("/api/snapshots")
    assert r.status == 200
    body = await r.json()
    assert body["source"] == "demo"
    assert body["snapshots"]
    r = await c.get("/api/status")
    status = await r.json()
    assert status["source"] == "demo"
    assert status["last_error"] is None


async def test_import(client):
    c = await client
    r = await c.post("/api/import", data="tank/x@a\t5\t10\t5\t1790000000\t0\n")
    assert r.status == 200
    body = await r.json()
    assert body["source"] == "import"
    assert body["snapshots"][0][:2] == ["tank/x", "a"]
    r = await c.post("/api/import", data="garbage without snapshots\n")
    assert r.status == 400


async def test_import_can_be_disabled(aiohttp_client, monkeypatch):
    monkeypatch.setenv("SNAPVIZ_SOURCE", "demo")
    monkeypatch.setenv("SNAPVIZ_ALLOW_IMPORT", "false")
    c = await aiohttp_client(create_app())
    r = await c.post("/api/import", data="tank/x@a\t5\n")
    assert r.status == 403
