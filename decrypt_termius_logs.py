#!/usr/bin/env python3
"""Extract Termius session-log encryption metadata.

Inputs:
  * `Termius/` (Windows AppData copy) — Local Storage + IndexedDB
  * `--local-key-b64` — `localKey` (32 raw bytes, base64) dumped from
        Windows Credential Manager via `dump_local_key.ps1`

What this does:
  1. Unwraps every Local Storage credential with `localKey` (so we have
     `privateKey`, `publicKey`, `personalKey`, `encryptionSalt`,
     `hmacSalt`, `apiKey` in plaintext).
  2. Walks the history table in IndexedDB and decrypts each session's
     `session_log_data.{name, secretKey}` — also with `localKey`, because
     the history table uses the same `localCryptoSystem`.
  3. Writes a JSON bundle to `decrypted/keys.json` describing every
     recoverable session: filename + 32-byte per-session secretkey
     (base64). This is the input for `decrypt_via_libtermius.js`.

What this does NOT do:
  * The `.log` file body itself is encrypted with libsodium
    `crypto_secretstream_xchacha20poly1305`, written chunked by Termius's
    native libtermius `terminalOutput.Writer`. The chunk framing is
    defined in the `.node` binary and not in any JS we can read. So we
    delegate the file-body decryption to `decrypt_via_libtermius.js`,
    which loads libtermius itself.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

import termius_crypto as tc
import termius_localstorage as tls
import termius_vault as tv


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", default="Termius", type=Path)
    ap.add_argument("--logs-dir", default=None, type=Path)
    ap.add_argument("--out", default="decrypted", type=Path)
    ap.add_argument(
        "--local-key-b64",
        help="The localKey (base64) dumped from Windows Credential Manager via dump_local_key.ps1",
    )
    ap.add_argument("--local-key-hex", help="Same as --local-key-b64 but hex-encoded")
    args = ap.parse_args()

    logs_dir = args.logs_dir or (args.data_dir / "session-logs-v2")
    idb_path = args.data_dir / "IndexedDB" / "file__0.indexeddb.leveldb"
    ls_path = args.data_dir / "Local Storage" / "leveldb"
    args.out.mkdir(parents=True, exist_ok=True)

    for p, label in [(idb_path, "IndexedDB"), (logs_dir, "session-logs-v2"), (ls_path, "Local Storage")]:
        if not p.is_dir():
            print(f"missing {label} at {p}", file=sys.stderr)
            return 2

    key_spec = args.local_key_b64 or args.local_key_hex
    if not key_spec:
        print("error: --local-key-b64 (or --local-key-hex) is required", file=sys.stderr)
        print("Run dump_local_key.ps1 on the Windows jumpbox to obtain it.", file=sys.stderr)
        return 2

    local_key = tc.decode_local_key(key_spec)
    local_box = tc.SecretBoxSystem(local_key)

    creds = tls.read_credentials(ls_path)
    plain_creds: dict[str, str] = {}
    for name, blob in creds.items():
        try:
            plain_creds[name] = local_box.decrypt_local_storage(blob).decode("ascii")
        except tc.TermiusDecryptError as e:
            print(f"error: localKey did not unwrap {name} ({e}). Wrong key?", file=sys.stderr)
            return 3
    print(f"unlocked {len(plain_creds)} Local Storage credentials")

    db = tv.open_idb(idb_path)
    log_paths = {p.name: p for p in logs_dir.glob("*.log")}
    sessions: list[dict[str, object]] = []
    try:
        for rec in tv.iter_session_records(db):
            entry: dict[str, object] = {
                "local_id": rec.local_id,
                "remote_id": rec.remote_id,
                "timestamp": rec.timestamp,
                "log_status": rec.log_status,
                "has_local_key": rec.has_local_key,
            }
            if rec.has_local_key:
                try:
                    name_plain = local_box.decrypt_indexeddb_record(rec.name_blob).decode("ascii")
                    session_key_b64 = local_box.decrypt_indexeddb_record(rec.secretkey_blob).decode("ascii")
                except tc.TermiusDecryptError as e:
                    entry["error"] = f"could not unwrap session_log_data: {e}"
                    sessions.append(entry)
                    continue
                session_key = base64.b64decode(session_key_b64)
                entry["filename"] = name_plain
                entry["session_key_b64"] = session_key_b64
                entry["session_key_hex"] = session_key.hex()
                entry["log_file_present"] = name_plain in log_paths
                if name_plain in log_paths:
                    entry["log_file_size"] = log_paths[name_plain].stat().st_size
            sessions.append(entry)
    finally:
        db.close()

    bundle = {
        "credentials": plain_creds,
        "sessions": sessions,
        "log_dir": str(logs_dir.resolve()),
    }
    out_path = args.out / "keys.json"
    out_path.write_text(json.dumps(bundle, indent=2))
    print(f"wrote {out_path}")

    recoverable = [s for s in sessions if s.get("session_key_b64") and s.get("log_file_present")]
    print(f"\nsessions in IndexedDB: {len(sessions)}")
    print(f"with local key + on-disk file: {len(recoverable)}")
    for s in recoverable:
        print(f"  local_id={s['local_id']:<3}  {s['timestamp']}  {s['filename']} ({s['log_file_size']} bytes)")

    if recoverable:
        print(
            f"\nNext: pass {out_path} to decrypt_via_libtermius.js (Node.js on Windows where libtermius can load):\n"
            f"  node decrypt_via_libtermius.js {out_path} <termius-app-asar-unpacked-dir> <output-dir>"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
