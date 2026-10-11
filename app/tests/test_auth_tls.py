import ssl
import time

import pytest

from snapviz.auth import COOKIE, Auth, _safe_next
from snapviz.server import create_app
from snapviz.tls import build_ssl_context, generate_self_signed


# ---------------------------------------------------------------- login

@pytest.fixture
def login_client(aiohttp_client, monkeypatch):
    monkeypatch.setenv("SNAPVIZ_SOURCE", "demo")
    monkeypatch.setenv("SNAPVIZ_PASSWORD", "s3cret")
    return aiohttp_client(create_app())


async def test_login_required(login_client):
    c = await login_client
    r = await c.get("/api/snapshots")
    assert r.status == 401
    r = await c.get("/", allow_redirects=False)
    assert r.status == 302 and r.headers["Location"] == "/login"
    # public: healthcheck, static assets and the login page itself
    assert (await c.get("/healthz")).status == 200
    assert (await c.get("/static/js/login.js")).status == 200
    assert (await c.get("/login")).status == 200


async def test_login_flow(login_client):
    c = await login_client
    r = await c.post("/login", data={"password": "wrong"}, allow_redirects=False)
    assert r.status == 302 and "error=1" in r.headers["Location"]
    assert (await c.get("/api/snapshots")).status == 401

    r = await c.post("/login", data={"password": "s3cret", "next": "//evil.example/"}, allow_redirects=False)
    assert r.status == 302 and r.headers["Location"] == "/"
    cookie = r.cookies[COOKIE]
    assert cookie["httponly"] and cookie["samesite"] == "Strict"
    assert (await c.get("/api/snapshots")).status == 200
    status = await (await c.get("/api/status")).json()
    assert status["auth_enabled"] is True

    r = await c.post("/logout", allow_redirects=False)
    assert r.status == 302
    assert (await c.get("/api/snapshots")).status == 401


async def test_login_lockout(login_client, monkeypatch):
    monkeypatch.setattr("snapviz.auth.asyncio.sleep", lambda _s: _noop())
    c = await login_client
    for _ in range(10):
        await c.post("/login", data={"password": "nope"}, allow_redirects=False)
    r = await c.post("/login", data={"password": "s3cret"}, allow_redirects=False)
    assert "error=locked" in r.headers["Location"]


async def _noop():
    return None


async def test_no_password_means_no_login(aiohttp_client, monkeypatch):
    monkeypatch.setenv("SNAPVIZ_SOURCE", "demo")
    monkeypatch.delenv("SNAPVIZ_PASSWORD", raising=False)
    c = await aiohttp_client(create_app())
    assert (await c.get("/api/snapshots")).status == 200
    r = await c.get("/login", allow_redirects=False)
    assert r.status == 302


def test_tokens():
    a = Auth("pw", b"k" * 32)
    tok = a.make_token()
    assert a.valid(tok)
    assert not a.valid(tok + "0")
    assert not a.valid("garbage")
    assert not a.valid(a.make_token(now=time.time() - 40 * 86400))
    # changing the password invalidates sessions
    assert not Auth("other", b"k" * 32).valid(tok)


def test_safe_next():
    assert _safe_next("/#treemap") == "/#treemap"
    assert _safe_next("//evil.example") == "/"
    assert _safe_next("https://evil.example") == "/"
    assert _safe_next(None) == "/"


# ---------------------------------------------------------------- tls

def test_self_signed_certificate_loads():
    cert, key = generate_self_signed()
    assert cert.startswith(b"-----BEGIN CERTIFICATE-----")
    assert b"PRIVATE KEY" in key


def test_build_ssl_context_variants(tmp_path, monkeypatch):
    monkeypatch.delenv("SNAPVIZ_TLS_CERT", raising=False)
    monkeypatch.setenv("SNAPVIZ_TLS", "off")
    assert build_ssl_context() is None

    monkeypatch.setenv("SNAPVIZ_TLS", "auto")
    monkeypatch.delenv("SNAPVIZ_DATA_DIR", raising=False)
    assert isinstance(build_ssl_context(), ssl.SSLContext)

    # persisted certificate is reused across restarts
    monkeypatch.setenv("SNAPVIZ_DATA_DIR", str(tmp_path))
    build_ssl_context()
    first = (tmp_path / "snapviz-cert.pem").read_bytes()
    build_ssl_context()
    assert (tmp_path / "snapviz-cert.pem").read_bytes() == first
