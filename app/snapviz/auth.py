"""Optional password login for the web UI (SNAPVIZ_PASSWORD).

Sessions are HMAC-signed cookies (HttpOnly, SameSite=Strict, Secure over HTTPS).
The signing key is random per start, or kept in SNAPVIZ_DATA_DIR so logins survive restarts.
Changing the password invalidates all sessions.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
import secrets
import time
from pathlib import Path

from aiohttp import web

log = logging.getLogger("snapviz.auth")

COOKIE = "snapviz_session"
SESSION_SECONDS = 30 * 86400
PUBLIC_PATHS = {"/healthz", "/login"}
PUBLIC_PREFIXES = ("/static/",)
MAX_FAILURES = 10
FAILURE_WINDOW = 600


class Auth:
    def __init__(self, password: str, secret: bytes):
        self.password = password
        self.secret = secret
        self._pw_tag = hashlib.sha256(password.encode()).hexdigest()[:16]
        self._failures: dict[str, list[float]] = {}

    @classmethod
    def from_env(cls) -> Auth | None:
        password = os.environ.get("SNAPVIZ_PASSWORD", "")
        if not password:
            return None
        return cls(password, _load_secret())

    # ---- tokens ----

    def _sign(self, expires: int) -> str:
        msg = f"{expires}:{self._pw_tag}".encode()
        return hmac.new(self.secret, msg, hashlib.sha256).hexdigest()

    def make_token(self, now: float | None = None) -> str:
        expires = int((now or time.time()) + SESSION_SECONDS)
        return f"{expires}.{self._sign(expires)}"

    def valid(self, token: str | None, now: float | None = None) -> bool:
        if not token or "." not in token:
            return False
        expires_s, sig = token.split(".", 1)
        if not expires_s.isdigit() or int(expires_s) < (now or time.time()):
            return False
        return hmac.compare_digest(sig, self._sign(int(expires_s)))

    def check_password(self, given: str) -> bool:
        return hmac.compare_digest(given.encode(), self.password.encode())

    # ---- brute force protection ----

    def locked(self, ip: str) -> bool:
        now = time.time()
        recent = [t for t in self._failures.get(ip, []) if now - t < FAILURE_WINDOW]
        self._failures[ip] = recent
        return len(recent) >= MAX_FAILURES

    def failed(self, ip: str) -> None:
        self._failures.setdefault(ip, []).append(time.time())


def _load_secret() -> bytes:
    data_dir = os.environ.get("SNAPVIZ_DATA_DIR")
    if data_dir:
        path = Path(data_dir) / "session.key"
        try:
            if path.exists():
                return bytes.fromhex(path.read_text().strip())
            key = secrets.token_bytes(32)
            path.write_text(key.hex())
            os.chmod(path, 0o600)
            return key
        except (OSError, ValueError) as exc:
            log.warning("Cannot use %s for the session key (%s); sessions end on restart", path, exc)
    return secrets.token_bytes(32)


def _is_public(path: str) -> bool:
    return path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES)


def _safe_next(target: str | None) -> str:
    # only local paths, no protocol-relative //evil.example redirects
    if not target or not target.startswith("/") or target.startswith("//") or "\\" in target:
        return "/"
    return target


@web.middleware
async def auth_middleware(request: web.Request, handler):
    auth: Auth | None = request.app.get("auth")
    if auth is None or _is_public(request.path) or auth.valid(request.cookies.get(COOKIE)):
        return await handler(request)
    if request.path.startswith("/api/"):
        return web.json_response({"error": "Login required", "login": True}, status=401)
    raise web.HTTPFound(f"/login?next={request.path_qs}" if request.path != "/" else "/login")


async def handle_login_page(request: web.Request) -> web.StreamResponse:
    if request.app.get("auth") is None:
        raise web.HTTPFound("/")
    static_dir = request.app["static_dir"]
    return web.FileResponse(static_dir / "login.html", headers={"Cache-Control": "no-cache"})


async def handle_login(request: web.Request) -> web.StreamResponse:
    auth: Auth | None = request.app.get("auth")
    if auth is None:
        raise web.HTTPFound("/")
    ip = request.remote or "?"
    form = await request.post()
    nxt = _safe_next(form.get("next"))
    if auth.locked(ip):
        log.warning("Login from %s blocked after too many failed attempts", ip)
        raise web.HTTPFound("/login?error=locked")
    if not auth.check_password(str(form.get("password", ""))):
        auth.failed(ip)
        log.warning("Failed login from %s", ip)
        await asyncio.sleep(1)  # slows down guessing
        raise web.HTTPFound(f"/login?error=1&next={nxt}")
    log.info("Login from %s", ip)
    resp = web.HTTPFound(nxt)
    resp.set_cookie(
        COOKIE, auth.make_token(), max_age=SESSION_SECONDS, httponly=True,
        samesite="Strict", secure=request.secure, path="/",
    )
    raise resp


async def handle_logout(request: web.Request) -> web.StreamResponse:
    resp = web.HTTPFound("/login" if request.app.get("auth") else "/")
    resp.del_cookie(COOKIE, path="/")
    raise resp


def setup_auth(app: web.Application) -> None:
    auth = Auth.from_env()
    app["auth"] = auth
    app.router.add_get("/login", handle_login_page)
    app.router.add_post("/login", handle_login)
    app.router.add_post("/logout", handle_logout)
    if auth:
        log.info("Password login is enabled")
