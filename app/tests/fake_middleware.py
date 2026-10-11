"""Fake TrueNAS middleware listening on a unix socket, for manual end-to-end tests.

    python -m tests.fake_middleware /run/middleware/middlewared.sock
"""

import os
import sys

from aiohttp import web

from tests.test_truenas import make_app


async def main(path: str) -> None:
    runner = web.AppRunner(make_app(socket_user="root"))
    await runner.setup()
    await web.UnixSite(runner, path).start()
    os.chmod(path, 0o666)  # like the real middlewared.sock
    print(f"fake middleware listening on {path}", flush=True)
    while True:
        await __import__("asyncio").sleep(3600)


if __name__ == "__main__":
    __import__("asyncio").run(main(sys.argv[1]))
