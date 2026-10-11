"""Container healthcheck: GET /healthz over http or https (busybox wget has no TLS)."""

import os
import ssl
import sys
import urllib.request

from .tls import tls_enabled


def main() -> int:
    port = os.environ.get("SNAPVIZ_PORT", "8080")
    scheme = "https" if tls_enabled() else "http"
    ctx = ssl._create_unverified_context() if scheme == "https" else None  # self-signed is fine here
    try:
        with urllib.request.urlopen(f"{scheme}://127.0.0.1:{port}/healthz", timeout=4, context=ctx) as r:
            return 0 if r.status == 200 else 1
    except Exception as exc:
        print(f"unhealthy: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
