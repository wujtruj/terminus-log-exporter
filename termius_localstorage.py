"""Walk Chromium Local Storage (LevelDB) and pull Termius-stored credentials.

Local Storage holds the per-app encrypted credential set wrapped with the
`localKey` from Windows Credential Manager. See termius_crypto.py for the
envelope details.

Keys we care about (each value is `\\x01"BA...="`):
    apiKey, encryptionSalt, hmacSalt, personalKey, privateKey, publicKey
"""
from __future__ import annotations

import re
from pathlib import Path

import plyvel


_CREDENTIAL_NAMES = (
    "apiKey",
    "encryptionSalt",
    "hmacSalt",
    "personalKey",
    "privateKey",
    "publicKey",
)


def read_credentials(local_storage_dir: Path) -> dict[str, str]:
    """Return {name: b64_envelope} for every credential we recognize."""
    db = plyvel.DB(str(local_storage_dir), create_if_missing=False)
    out: dict[str, str] = {}
    try:
        for k, v in db:
            for name in _CREDENTIAL_NAMES:
                # Keys look like b'_file://\x00\x01<name>'
                if k.endswith(b"\x01" + name.encode()):
                    out[name] = _strip_value_envelope(v)
                    break
    finally:
        db.close()
    missing = [n for n in _CREDENTIAL_NAMES if n not in out]
    if missing:
        raise RuntimeError(f"missing credentials in Local Storage: {missing}")
    return out


_QUOTED = re.compile(rb'^[\x00\x01]?"(BA[A-Za-z0-9+/=]+)"$')


def _strip_value_envelope(v: bytes) -> str:
    """Local Storage stores values as JSON-ish quoted strings prefixed by a
    1-byte type marker. Strip both."""
    m = _QUOTED.match(v)
    if m:
        return m.group(1).decode("ascii")
    # Some entries may not have the leading marker; try without.
    s = v.lstrip(b"\x00\x01").decode("latin-1", errors="replace")
    s = s.strip().strip('"')
    return s
