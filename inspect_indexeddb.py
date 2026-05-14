#!/usr/bin/env python3
"""Dump Termius IndexedDB entries: enumerate keys + best-effort decoded values.

Helps discover crypto layout (which records reference which session-log UUIDs,
salt/private_key/public_key storage, envelope structure).
"""
from __future__ import annotations

import argparse
import base64
import re
import sys
from pathlib import Path

import plyvel

PRINTABLE = re.compile(rb"[\x20-\x7e]{4,}")


def printable_chunks(b: bytes) -> list[str]:
    return [m.decode("ascii", "replace") for m in PRINTABLE.findall(b)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--db",
        default="Termius/IndexedDB/file__0.indexeddb.leveldb",
        help="Path to LevelDB dir",
    )
    ap.add_argument("--max-bytes", type=int, default=512)
    ap.add_argument("--grep", default=None, help="Only show entries containing this substring")
    args = ap.parse_args()

    db_path = Path(args.db)
    if not db_path.is_dir():
        print(f"missing: {db_path}", file=sys.stderr)
        return 1

    def cmp(a: bytes, b: bytes) -> int:
        return (a > b) - (a < b)

    db = plyvel.DB(
        str(db_path),
        create_if_missing=False,
        comparator=cmp,
        comparator_name=b"idb_cmp1",
    )
    try:
        for i, (k, v) in enumerate(db):
            if args.grep:
                hay = k + b"\x00" + v
                if args.grep.encode() not in hay:
                    continue
            print(f"--- entry #{i} key_len={len(k)} val_len={len(v)} ---")
            print(f"key hex: {k.hex()[:120]}")
            kstr = "".join(c if 32 <= ord(c) < 127 else "." for c in k.decode("latin-1"))
            print(f"key ascii: {kstr[:200]}")
            head = v[: args.max_bytes]
            print(f"val hex: {head.hex()[:240]}")
            chunks = printable_chunks(head)
            if chunks:
                print("val printable:")
                for c in chunks[:25]:
                    print("  ", c)
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
