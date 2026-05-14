#!/usr/bin/env python3
"""Decode V8-serialized IndexedDB values into Python objects.

IndexedDB stores values using V8 serialization. Header structure:
  byte 0: 'V' (legacy) or a "blob info" wrapper
Format we see here: starts with cd08 ff14 ff0f 6f ... — that's the SSV header
(0xff 0x0d/0x0e/0x0f) plus version tag, then an object tree.

This module implements just enough of the V8 serialization grammar to extract
flat object properties (strings, ints, booleans, nulls, ASCII/UTF-16 strings,
byte arrays) — anything fancier (typed arrays, nested objects beyond 1 level)
is best-effort and tagged as `unknown` for the caller to inspect.

Reference: v8/src/objects/value-serializer.cc.
"""
from __future__ import annotations

import argparse
import io
import re
import struct
import sys
from pathlib import Path
from typing import Any

import plyvel


class Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def eof(self) -> bool:
        return self.pos >= len(self.data)

    def peek(self) -> int:
        return self.data[self.pos] if not self.eof() else -1

    def u8(self) -> int:
        b = self.data[self.pos]
        self.pos += 1
        return b

    def varint(self) -> int:
        result = 0
        shift = 0
        while True:
            b = self.u8()
            result |= (b & 0x7F) << shift
            if not (b & 0x80):
                return result
            shift += 7

    def zigzag(self) -> int:
        v = self.varint()
        return (v >> 1) ^ -(v & 1)

    def bytes(self, n: int) -> bytes:
        out = self.data[self.pos : self.pos + n]
        self.pos += n
        return out


def decode_value(r: Reader, depth: int = 0) -> Any:
    if depth > 12:
        return {"__overflow__": True}
    if r.eof():
        return None
    tag = r.u8()
    c = chr(tag) if 0x20 <= tag < 0x7F else f"\\x{tag:02x}"
    # Common tags from value-serializer.cc
    if tag == 0x00:  # padding
        return decode_value(r, depth)
    if tag == ord("_"):  # kUndefined
        return None
    if tag == ord("0"):  # kNull
        return None
    if tag == ord("T"):  # kTrue
        return True
    if tag == ord("F"):  # kFalse
        return False
    if tag == ord("I"):  # kInt32 (zigzag varint)
        return r.zigzag()
    if tag == ord("U"):  # kUint32 (varint)
        return r.varint()
    if tag == ord("N"):  # kDouble
        return struct.unpack("<d", r.bytes(8))[0]
    if tag == ord('"'):  # kUtf8 string (varint len + bytes)
        n = r.varint()
        return r.bytes(n).decode("utf-8", errors="replace")
    if tag == ord("c"):  # kTwoByteString (utf-16-le)
        n = r.varint()
        return r.bytes(n).decode("utf-16-le", errors="replace")
    if tag == ord("S"):  # kOneByteString (latin-1)
        n = r.varint()
        return r.bytes(n).decode("latin-1", errors="replace")
    if tag == ord("o"):  # kBeginJSObject
        props: dict[str, Any] = {}
        while True:
            if r.peek() == ord("{"):
                r.u8()
                _expected_count = r.varint()
                return props
            if r.eof():
                return props
            key = decode_value(r, depth + 1)
            value = decode_value(r, depth + 1)
            if isinstance(key, (str, int)):
                props[str(key)] = value
            else:
                props[f"__nonstring_key_{tag}__"] = value
    if tag == ord("A"):  # kBeginSparseJSArray
        length = r.varint()
        items: dict[int, Any] = {}
        while True:
            if r.peek() == ord("@"):
                r.u8()
                _props_written = r.varint()
                _length_again = r.varint()
                return [items.get(i) for i in range(length)]
            if r.eof():
                return items
            key = decode_value(r, depth + 1)
            value = decode_value(r, depth + 1)
            if isinstance(key, int):
                items[key] = value
    if tag == ord("a"):  # kBeginDenseJSArray
        length = r.varint()
        arr = []
        for _ in range(length):
            arr.append(decode_value(r, depth + 1))
        if r.peek() == ord("$"):
            r.u8()
            r.varint()
            r.varint()
        return arr
    if tag == ord("B"):  # kArrayBuffer (varint len + bytes)
        n = r.varint()
        return r.bytes(n)
    if tag == 0xFF:  # version header
        _ver = r.varint()
        return decode_value(r, depth)
    if tag in (0x14, 0x0D, 0x0E, 0x0F):  # blob wrapper tags
        # Different SSV versions have wrappers; try to skip
        return decode_value(r, depth)
    # Unknown — try to keep going by treating as opaque
    return {"__unknown_tag__": f"0x{tag:02x} ({c})", "__remaining_hex__": r.data[r.pos : r.pos + 32].hex()}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--db", default="Termius/IndexedDB/file__0.indexeddb.leveldb"
    )
    ap.add_argument("--grep", default="session_log_data")
    ap.add_argument("--limit", type=int, default=10)
    args = ap.parse_args()

    def cmp(a: bytes, b: bytes) -> int:
        return (a > b) - (a < b)

    db = plyvel.DB(
        str(args.db),
        create_if_missing=False,
        comparator=cmp,
        comparator_name=b"idb_cmp1",
    )
    n = 0
    try:
        for k, v in db:
            if args.grep.encode() not in v:
                continue
            n += 1
            if n > args.limit:
                break
            print(f"=== key={k.hex()} val_len={len(v)} ===")
            # IndexedDB value blob has a small prefix before the SSV stream
            # Strip leading bytes until we hit 0xff (version marker)
            ssv_start = v.find(b"\xff")
            if ssv_start < 0:
                print("no SSV marker, skip")
                continue
            try:
                obj = decode_value(Reader(v[ssv_start:]))
            except Exception as e:
                obj = {"__error__": str(e)}
            print(repr(obj)[:4000])
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
