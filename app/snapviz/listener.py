"""Serve the app; with HTTPS, also answer plain HTTP on the same port with a redirect.

Browsers show an empty error page (Firefox: NS_ERROR_NET_EMPTY_RESPONSE) when someone opens
http:// on a TLS-only port. To avoid that, every new connection is peeked at: a TLS handshake
starts with byte 0x16 and is handed to the app with TLS, anything else gets a 308 redirect to
the same URL with https://.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import socket
import ssl

from aiohttp import web

log = logging.getLogger("snapviz.listener")

TLS_HANDSHAKE = 0x16
PEEK_TIMEOUT = 10


async def _redirect_to_https(request: web.BaseRequest) -> web.Response:
    host = request.host or "localhost"
    return web.Response(
        status=308,
        headers={"Location": f"https://{host}{request.path_qs}", "Cache-Control": "no-store"},
        text="This app uses HTTPS.\n",
    )


async def _peek(conn: socket.socket) -> bytes:
    # MSG_PEEK leaves the byte in the socket buffer for the TLS handshake / HTTP parser.
    # Run in a thread: the Windows proactor loop has no add_reader for a non-blocking peek.
    conn.settimeout(PEEK_TIMEOUT)
    try:
        return await asyncio.to_thread(conn.recv, 1, socket.MSG_PEEK)
    finally:
        conn.settimeout(None)


async def _dispatch(conn: socket.socket, app_server, redirect_server, ssl_context: ssl.SSLContext) -> None:
    loop = asyncio.get_running_loop()
    try:
        first = await _peek(conn)
        if not first:
            conn.close()
            return
        conn.setblocking(False)
        if first[0] == TLS_HANDSHAKE:
            await loop.connect_accepted_socket(app_server, conn, ssl=ssl_context, ssl_handshake_timeout=15)
        else:
            await loop.connect_accepted_socket(redirect_server, conn)
    except (TimeoutError, OSError, ssl.SSLError) as exc:
        log.debug("Dropping connection: %s", exc)
        conn.close()


async def _serve_dual(app_server, host: str, port: int, ssl_context: ssl.SSLContext) -> None:
    loop = asyncio.get_running_loop()
    redirect_server = web.Server(_redirect_to_https, access_log=None)
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    lsock = socket.create_server((host, port), family=family, backlog=128)
    lsock.setblocking(False)
    tasks: set[asyncio.Task] = set()
    try:
        while True:
            conn, _addr = await loop.sock_accept(lsock)
            conn.setblocking(True)
            task = asyncio.create_task(_dispatch(conn, app_server, redirect_server, ssl_context))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
    finally:
        lsock.close()
        await redirect_server.shutdown(1)


async def serve(app: web.Application, host: str, port: int, ssl_context: ssl.SSLContext | None,
                started: asyncio.Event | None = None) -> None:
    """Run until cancelled."""
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    try:
        if ssl_context is None:
            await web.TCPSite(runner, host, port).start()
            if started:
                started.set()
            await asyncio.Event().wait()
        else:
            serving = asyncio.create_task(_serve_dual(runner.server, host, port, ssl_context))
            await asyncio.sleep(0)  # let the listening socket bind
            if started:
                started.set()
            await serving
    finally:
        await runner.cleanup()


def run(app: web.Application, host: str, port: int, ssl_context: ssl.SSLContext | None) -> None:
    async def _main() -> None:
        loop = asyncio.get_running_loop()
        task = asyncio.create_task(serve(app, host, port, ssl_context))
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, task.cancel)  # docker stop -> graceful shutdown
            except (NotImplementedError, AttributeError, ValueError):
                pass  # Windows
        try:
            await task
        except asyncio.CancelledError:
            pass

    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        pass
