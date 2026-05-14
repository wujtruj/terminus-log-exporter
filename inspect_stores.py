#!/usr/bin/env python3
"""List unique key-prefix patterns to identify distinct object stores."""
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

# IndexedDB key layout (chromium): db_id varint, obj_store_id varint, idx_id varint, user-key
# First 6 bytes usually identify store; group by 6-byte prefix.
prefix_counts = Counter()
prefix_samples = {}
for k, v in db:
    p = k[:6]
    prefix_counts[p] += 1
    prefix_samples.setdefault(p, []).append((len(k), len(v)))

for p, c in sorted(prefix_counts.items(), key=lambda x: -x[1]):
    print(f"{p.hex():14s}  count={c:5d}  sample sizes: {prefix_samples[p][:3]}")
db.close()
