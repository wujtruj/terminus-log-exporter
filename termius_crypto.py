"""Termius crypto envelope helpers.

Reverse-engineered from `app.asar` (Termius 9.38.2 on Windows):

Envelope layout used by `tr.systems.FromEncryptionKey(key).encrypt(msg)`
(libtermius native binding, libsodium-backed):

    [0x04]                -- "encryption schema v4"
    [0x01]                -- secretbox sub-type
    [24-byte XSalsa20 nonce]
    [ciphertext]
    [16-byte Poly1305 tag]

Decryption: classic libsodium `crypto_secretbox_open_easy(nonce, body, key)`.

Termius chains crypto for personal data:
  - FromEncryptionKey(localKey) wraps Local Storage credentials AND records
        in the history (sessions) IndexedDB table — the same
        `localCryptoSystem` instance does both. So with just `localKey` we can
        unwrap `session_log_data.{name, secretKey}` plus the privateKey /
        publicKey / personalKey / salts / apiKey credentials.
  - The session-log FILE body (`session-logs-v2/<uuid>.log`) starts with
        a `0x01` version byte and is written by libtermius's native
        `terminalOutput.Writer` using libsodium
        `crypto_secretstream_xchacha20poly1305` keyed by the 32-byte
        per-session `secretKey`. The chunk framing inside the file is
        defined in the libtermius `.node` binary and not in any JS; this
        Python module exposes only the envelope helpers — actually
        decrypting the file body requires `decrypt_via_libtermius.js`.

`localKey` itself lives in Windows Credential Manager (`Termius/localKey`,
keytar service name). Run `dump_local_key.ps1` on the source Windows machine
to extract it.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass

import nacl.bindings as sb
import nacl.exceptions


def _strip_envelope(raw: bytes, expected_prefix: bytes) -> tuple[bytes, bytes]:
    """Return (nonce, ciphertext_with_tag) after validating the prefix."""
    if len(raw) < len(expected_prefix) + 24 + 16:
        raise TermiusDecryptError(f"blob too short ({len(raw)} bytes)")
    if not raw.startswith(expected_prefix):
        raise TermiusDecryptError(
            f"bad envelope prefix: got {raw[:len(expected_prefix)].hex()}, "
            f"want {expected_prefix.hex()}"
        )
    body = raw[len(expected_prefix):]
    nonce, ciphertext = body[:24], body[24:]
    return nonce, ciphertext


class TermiusDecryptError(Exception):
    pass


@dataclass
class SecretBoxSystem:
    key: bytes  # 32 raw bytes

    def __post_init__(self):
        if len(self.key) != 32:
            raise ValueError(f"key must be 32 bytes, got {len(self.key)}")

    def decrypt_local_storage(self, blob_b64: str) -> bytes:
        """Decrypt a `BA...` envelope from Chromium Local Storage (`04 01 ...`)."""
        raw = base64.b64decode(blob_b64)
        nonce, ciphertext = _strip_envelope(raw, b"\x04\x01")
        try:
            return sb.crypto_secretbox_open(ciphertext, nonce, self.key)
        except nacl.exceptions.CryptoError as e:
            raise TermiusDecryptError(f"local-storage record auth failed: {e}") from e

    def decrypt_indexeddb_record(self, blob_b64: str) -> bytes:
        """Same envelope; different key (personalKey instead of localKey)."""
        return self.decrypt_local_storage(blob_b64)

    def decrypt_session_log(self, payload: bytes) -> bytes:
        """Decrypt a `session-logs-v2/<uuid>.log` file body (envelope `01 ...`)."""
        nonce, ciphertext = _strip_envelope(payload, b"\x01")
        try:
            return sb.crypto_secretbox_open(ciphertext, nonce, self.key)
        except nacl.exceptions.CryptoError as e:
            raise TermiusDecryptError(f"session-log auth failed: {e}") from e


def decode_local_key(spec: str) -> bytes:
    """Accept the Windows-dumped localKey as base64 (default) or hex."""
    spec = spec.strip().strip('"').strip("'")
    try:
        raw = base64.b64decode(spec, validate=True)
        if len(raw) == 32:
            return raw
    except (ValueError, base64.binascii.Error):
        pass
    try:
        raw = bytes.fromhex(spec)
        if len(raw) == 32:
            return raw
    except ValueError:
        pass
    raise TermiusDecryptError(
        f"localKey must decode to exactly 32 bytes (got {spec!r})"
    )
