#!/usr/bin/env python3
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
        if b"UPLOAD_FAILED" not in v:
            continue
        ssv = v.find(b"\xff")
        obj = decode_value(Reader(v[ssv:]))
        if not isinstance(obj, dict):
            continue
        print(f"=== key={k.hex()} ===")
        for kk, vv in obj.items():
            if isinstance(vv, str) and len(vv) > 80:
                print(f"  {kk}: <str len={len(vv)}> {vv[:60]}...{vv[-20:]}")
            elif isinstance(vv, (bytes, bytearray)):
                print(f"  {kk}: <bytes len={len(vv)}> {vv[:40].hex()}...")
            else:
                print(f"  {kk}: {vv!r}")
finally:
    db.close()
