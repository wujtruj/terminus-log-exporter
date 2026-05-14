#!/usr/bin/env python3
"""Decode every session record. Look for non-null session_log_data / encrypted_with."""
from __future__ import annotations

import plyvel
from inspect_v8 import Reader, decode_value

def cmp(a, b):
    return (a > b) - (a < b)

db = plyvel.DB(
    "Termius/IndexedDB/file__0.indexeddb.leveldb",
    create_if_missing=False,
    comparator=cmp,
    comparator_name=b"idb_cmp1",
)
try:
    for k, v in db:
        if b"session_log_data" not in v:
            continue
        ssv = v.find(b"\xff")
        if ssv < 0:
            continue
        try:
            obj = decode_value(Reader(v[ssv:]))
        except Exception as e:
            print("decode err", e)
            continue
        if not isinstance(obj, dict):
            continue
        sld = obj.get("session_log_data")
        ew = obj.get("encrypted_with")
        cmd = obj.get("command")
        sid = obj.get("id")
        status = obj.get("log_status")
        local = obj.get("local_id")
        print(
            f"id={sid} local={local} log_status={status} ew={ew!r:30s} sld={('Y' if sld else 'N')} cmd_len={(len(cmd) if cmd else 0)}"
        )
finally:
    db.close()
