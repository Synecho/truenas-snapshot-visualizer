"""HTTPS for the web UI: own certificate or an automatically generated self-signed one.

SNAPVIZ_TLS       auto (default) | off
SNAPVIZ_TLS_CERT  path to a PEM certificate (chain); with SNAPVIZ_TLS_KEY
SNAPVIZ_TLS_KEY   path to the PEM private key
SNAPVIZ_DATA_DIR  optional writable directory: the generated certificate is kept there,
                  so browsers do not warn again after every restart
"""

from __future__ import annotations

import datetime
import ipaddress
import logging
import os
import socket
import ssl
import tempfile
from pathlib import Path

log = logging.getLogger("snapviz.tls")

CERT_NAME = "snapviz-cert.pem"
KEY_NAME = "snapviz-key.pem"


def tls_enabled() -> bool:
    return os.environ.get("SNAPVIZ_TLS", "auto").strip().lower() not in ("off", "false", "0", "no")


def generate_self_signed(days: int = 3650) -> tuple[bytes, bytes]:
    """Return (cert_pem, key_pem) for a self-signed certificate."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    hostname = socket.gethostname() or "snapshot-visualizer"
    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "Snapshot Visualizer"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Snapshot Visualizer (self-signed)"),
    ])
    sans = [x509.DNSName("localhost"), x509.DNSName(hostname), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
    now = datetime.datetime.now(datetime.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=days))
        .add_extension(x509.SubjectAlternativeName(sans), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    return (
        cert.public_bytes(serialization.Encoding.PEM),
        key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()),
    )


def _load_from_memory(ctx: ssl.SSLContext, cert_pem: bytes, key_pem: bytes) -> None:
    """ssl only loads from files; the root filesystem is read-only, /dev/shm is a writable tmpfs."""
    tmpdir = "/dev/shm" if os.path.isdir("/dev/shm") and os.access("/dev/shm", os.W_OK) else None
    fd, path = tempfile.mkstemp(prefix="snapviz-", suffix=".pem", dir=tmpdir)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(key_pem + b"\n" + cert_pem)
        ctx.load_cert_chain(path)
    finally:
        os.unlink(path)


def build_ssl_context() -> ssl.SSLContext | None:
    if not tls_enabled():
        log.warning("HTTPS is disabled (SNAPVIZ_TLS=off) - the web UI is served over plain HTTP")
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2

    cert_file, key_file = os.environ.get("SNAPVIZ_TLS_CERT"), os.environ.get("SNAPVIZ_TLS_KEY")
    if cert_file:
        ctx.load_cert_chain(cert_file, key_file or None)
        log.info("HTTPS with certificate %s", cert_file)
        return ctx

    data_dir = os.environ.get("SNAPVIZ_DATA_DIR")
    if data_dir:
        cert_path, key_path = Path(data_dir) / CERT_NAME, Path(data_dir) / KEY_NAME
        if cert_path.exists() and key_path.exists():
            ctx.load_cert_chain(cert_path, key_path)
            log.info("HTTPS with stored self-signed certificate %s", cert_path)
            return ctx
        cert_pem, key_pem = generate_self_signed()
        try:
            key_path.write_bytes(key_pem)
            os.chmod(key_path, 0o600)
            cert_path.write_bytes(cert_pem)
            ctx.load_cert_chain(cert_path, key_path)
            log.info("HTTPS with new self-signed certificate stored in %s", data_dir)
            return ctx
        except OSError as exc:
            log.warning("Cannot store certificate in %s (%s); using a temporary one", data_dir, exc)
    else:
        cert_pem, key_pem = generate_self_signed()

    _load_from_memory(ctx, cert_pem, key_pem)
    log.info("HTTPS with a temporary self-signed certificate (set SNAPVIZ_DATA_DIR to keep it across restarts)")
    return ctx
