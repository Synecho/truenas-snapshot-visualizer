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


# ---------------------------------------------------------------- deleting

HDR = {"X-Snapviz-Action": "delete"}


async def _first_snapshots(c, n=2):
    body = await (await c.get("/api/snapshots")).json()
    f = body["snapshot_fields"]
    rows = [dict(zip(f, r)) for r in body["snapshots"]]
    return rows, [f"{r['dataset']}@{r['name']}" for r in rows if not r["holds"]][:n]


async def test_delete_disabled_by_default(client):
    c = await client
    _, ids = await _first_snapshots(c)
    r = await c.post("/api/delete", json={"snapshots": ids}, headers=HDR)
    assert r.status == 403
    assert (await (await c.get("/api/status")).json())["allow_delete"] is False


@pytest.fixture
def delete_client(aiohttp_client, monkeypatch):
    monkeypatch.setenv("SNAPVIZ_SOURCE", "demo")
    monkeypatch.setenv("SNAPVIZ_ALLOW_DELETE", "true")
    return aiohttp_client(create_app())


async def test_delete_flow(delete_client):
    c = await delete_client
    assert (await (await c.get("/api/status")).json())["allow_delete"] is True
    rows, ids = await _first_snapshots(c)

    # CSRF protections
    r = await c.post("/api/delete", json={"snapshots": ids})
    assert r.status == 400
    r = await c.post("/api/delete", data=f'{{"snapshots": ["{ids[0]}"]}}', headers=HDR)
    assert r.status == 400  # not application/json
    r = await c.post("/api/delete", json={"snapshots": ids}, headers={**HDR, "Origin": "http://evil.example"})
    assert r.status == 403

    # never a dataset, never something unknown
    r = await c.post("/api/delete", json={"snapshots": [rows[0]["dataset"]]}, headers=HDR)
    assert r.status == 400
    r = await c.post("/api/delete", json={"snapshots": ["tank@does-not-exist"]}, headers=HDR)
    assert r.status == 400

    origin = f"http://{c.server.host}:{c.server.port}"
    r = await c.post("/api/delete", json={"snapshots": ids}, headers={**HDR, "Origin": origin})
    assert r.status == 200
    body = await r.json()
    assert body["deleted"] == 2 and body["failed"] == 0

    # cache was invalidated: the deleted snapshots are gone
    _, remaining = await _first_snapshots(c, n=10_000)
    assert not set(ids) & set(remaining)


async def test_delete_held_snapshot_fails(delete_client):
    c = await delete_client
    rows, _ = await _first_snapshots(c)
    held = [f"{r['dataset']}@{r['name']}" for r in rows if r["holds"]]
    assert held
    r = await c.post("/api/delete", json={"snapshots": held[:1]}, headers=HDR)
    body = await r.json()
    assert body["failed"] == 1
    assert "holds" in body["results"][0]["error"]


async def test_exclude_patterns(aiohttp_client, monkeypatch):
    monkeypatch.setenv("SNAPVIZ_SOURCE", "demo")
    c = await aiohttp_client(create_app())
    body = await (await c.get("/api/snapshots")).json()
    assert "*/.system*" in body["exclude_patterns"]

    monkeypatch.setenv("SNAPVIZ_EXCLUDE_DATASETS", " tank/scratch* , */tmp ")
    c = await aiohttp_client(create_app())
    body = await (await c.get("/api/snapshots")).json()
    assert body["exclude_patterns"] == ["tank/scratch*", "*/tmp"]

    monkeypatch.setenv("SNAPVIZ_EXCLUDE_DATASETS", "")
    c = await aiohttp_client(create_app())
    body = await (await c.get("/api/snapshots")).json()
    assert body["exclude_patterns"] == []
