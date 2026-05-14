#!/usr/bin/env python3
"""Inventory every unique field name across IndexedDB values.

Helps find where private key / salt / vault key is stored.
"""
import re
from collections import Counter

import plyvel

def cmp(a, b):
    return (a > b) - (a < b)

db = plyvel.DB(
    "Termius/IndexedDB/file__0.indexeddb.leveldb",
    create_if_missing=False,
    comparator=cmp,
    comparator_name=b"idb_cmp1",
)

FIELD = re.compile(rb'"([A-Za-z_][A-Za-z0-9_]{2,40})"?')
field_counts = Counter()
for k, v in db:
    # V8 SSV uses 0x22 (')(varint len)(bytes) for utf-8 strings.
    # Field names are usually plain ASCII; just scrape printable runs prefixed by 0x22.
    i = 0
    while i < len(v) - 2:
        if v[i] == 0x22 and 3 < v[i+1] < 60:
            n = v[i+1]
            if i + 2 + n > len(v):
                i += 1
                continue
            s = v[i+2:i+2+n]
            if all(0x20 <= b < 0x7f for b in s):
                field_counts[s.decode()] += 1
                i += 2 + n
                continue
        i += 1
db.close()

for name, c in field_counts.most_common(200):
    print(f"{c:6d}  {name}")
