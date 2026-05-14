'use strict';
// Read-only LevelDB scanner — pure JS, no native deps.
// Iterates *.ldb (SST) files and the WAL *.log file, yields {key, value} Buffers.
// Comparator-agnostic: block format does not depend on the key comparator.
// Order is not preserved across files; consumers must filter by content
// and de-duplicate by their own primary key.
//
// References:
//   SST: https://github.com/google/leveldb/blob/main/doc/table_format.md
//   WAL: https://github.com/google/leveldb/blob/main/doc/log_format.md

const fs = require('fs');
const path = require('path');
const snappy = require('snappyjs');

const SST_MAGIC_LOW = 0x8b80fb57;
const SST_MAGIC_HIGH = 0xdb477524;
const FOOTER_LEN = 48;
const BLOCK_TRAILER_LEN = 5;
const COMPRESS_NONE = 0;
const COMPRESS_SNAPPY = 1;

const WAL_BLOCK_SIZE = 32 * 1024;
const WAL_HEADER_SIZE = 7;
const WAL_TYPE_ZERO = 0;
const WAL_TYPE_FULL = 1;
const WAL_TYPE_FIRST = 2;
const WAL_TYPE_MIDDLE = 3;
const WAL_TYPE_LAST = 4;

const WAL_OP_DELETE = 0;
const WAL_OP_PUT = 1;

function readVarint(buf, offset) {
    let result = 0;
    let shift = 0;
    let pos = offset;
    while (true) {
        if (pos >= buf.length) throw new Error('varint overflow buffer');
        const b = buf[pos];
        pos += 1;
        if (shift < 28) {
            result |= (b & 0x7F) << shift;
        } else {
            result += (b & 0x7F) * Math.pow(2, shift);
        }
        if (!(b & 0x80)) return { value: result, next: pos };
        shift += 7;
        if (shift > 63) throw new Error('varint too long');
    }
}

function readFixed64LE(buf, offset) {
    const lo = buf.readUInt32LE(offset);
    const hi = buf.readUInt32LE(offset + 4);
    return hi * 0x100000000 + lo;
}

function parseFooter(buf) {
    if (buf.length < FOOTER_LEN) throw new Error(`file too small for SST footer (${buf.length})`);
    const footer = buf.slice(buf.length - FOOTER_LEN);
    const magicLo = footer.readUInt32LE(40);
    const magicHi = footer.readUInt32LE(44);
    if (magicLo !== SST_MAGIC_LOW || magicHi !== SST_MAGIC_HIGH) {
        throw new Error(`bad SST magic: ${magicHi.toString(16)}${magicLo.toString(16)}`);
    }
    // metaindex_handle then index_handle, each is two varints (offset, size).
    let p = 0;
    const metaOff = readVarint(footer, p); p = metaOff.next;
    const metaSize = readVarint(footer, p); p = metaSize.next;
    const idxOff = readVarint(footer, p); p = idxOff.next;
    const idxSize = readVarint(footer, p); p = idxSize.next;
    return {
        index: { offset: idxOff.value, size: idxSize.value },
        metaindex: { offset: metaOff.value, size: metaSize.value },
    };
}

function readBlock(buf, handle) {
    const start = handle.offset;
    const size = handle.size;
    const end = start + size + BLOCK_TRAILER_LEN;
    if (end > buf.length) throw new Error(`block extends past file (off=${start} size=${size})`);
    const raw = buf.slice(start, start + size);
    const type = buf[start + size];
    if (type === COMPRESS_NONE) return raw;
    if (type === COMPRESS_SNAPPY) return Buffer.from(snappy.uncompress(raw));
    throw new Error(`unknown compression type ${type} at block offset ${start}`);
}

// Walk entries of a decompressed block.
function* iterBlockEntries(block) {
    if (block.length < 4) return;
    const numRestarts = block.readUInt32LE(block.length - 4);
    const restartArrayLen = numRestarts * 4 + 4;
    const dataEnd = block.length - restartArrayLen;
    let p = 0;
    let lastKey = Buffer.alloc(0);
    while (p < dataEnd) {
        const shared = readVarint(block, p); p = shared.next;
        const nonShared = readVarint(block, p); p = nonShared.next;
        const valLen = readVarint(block, p); p = valLen.next;
        if (p + nonShared.value + valLen.value > dataEnd) break;
        const keyDelta = block.slice(p, p + nonShared.value);
        p += nonShared.value;
        const value = block.slice(p, p + valLen.value);
        p += valLen.value;
        const key = Buffer.concat([lastKey.slice(0, shared.value), keyDelta]);
        lastKey = key;
        yield { key, value };
    }
}

// SST keys have an 8-byte internal-key suffix: [seq:7 | type:1].
// type==1 = Value, type==0 = Deletion. Strip + filter.
function stripInternalKey(internalKey) {
    if (internalKey.length < 8) return null;
    const trailer = internalKey.slice(internalKey.length - 8);
    const type = trailer[0]; // low byte of the 8-byte little-endian (seq<<8|type)
    const userKey = internalKey.slice(0, internalKey.length - 8);
    return { userKey, type };
}

function scanSstFile(filePath) {
    const buf = fs.readFileSync(filePath);
    const out = [];
    let footer;
    try {
        footer = parseFooter(buf);
    } catch (e) {
        return { entries: out, warning: `SST footer parse failed for ${path.basename(filePath)}: ${e.message}` };
    }
    let indexBlock;
    try {
        indexBlock = readBlock(buf, footer.index);
    } catch (e) {
        return { entries: out, warning: `SST index block read failed for ${path.basename(filePath)}: ${e.message}` };
    }
    for (const { value: handleBytes } of iterBlockEntries(indexBlock)) {
        let p = 0;
        const off = readVarint(handleBytes, p); p = off.next;
        const size = readVarint(handleBytes, p); p = size.next;
        let dataBlock;
        try {
            dataBlock = readBlock(buf, { offset: off.value, size: size.value });
        } catch (e) {
            out.push({ __warning__: `data block read failed at off=${off.value} in ${path.basename(filePath)}: ${e.message}` });
            continue;
        }
        for (const { key: internalKey, value } of iterBlockEntries(dataBlock)) {
            const stripped = stripInternalKey(internalKey);
            if (!stripped) continue;
            if (stripped.type !== 1) continue; // skip deletions
            out.push({ key: stripped.userKey, value });
        }
    }
    return { entries: out };
}

// WAL: reassemble records across 32 KiB blocks, then walk each WriteBatch.
function* iterWalLogicalRecords(buf) {
    let blockStart = 0;
    let pending = null; // Buffer accumulating FIRST/MIDDLE fragments
    while (blockStart < buf.length) {
        const blockEnd = Math.min(blockStart + WAL_BLOCK_SIZE, buf.length);
        let p = blockStart;
        while (p + WAL_HEADER_SIZE <= blockEnd) {
            // Skip trailer at end of block if not enough room for a header.
            if (blockEnd - p < WAL_HEADER_SIZE) break;
            const len = buf.readUInt16LE(p + 4);
            const type = buf[p + 6];
            if (type === WAL_TYPE_ZERO && len === 0) {
                p = blockEnd; // trailer fill — skip to next block
                break;
            }
            const dataStart = p + WAL_HEADER_SIZE;
            const dataEnd = dataStart + len;
            if (dataEnd > blockEnd) break; // truncated
            const frag = buf.slice(dataStart, dataEnd);
            if (type === WAL_TYPE_FULL) {
                if (pending) { pending = null; }
                yield frag;
            } else if (type === WAL_TYPE_FIRST) {
                pending = Buffer.from(frag);
            } else if (type === WAL_TYPE_MIDDLE) {
                if (pending) pending = Buffer.concat([pending, frag]);
            } else if (type === WAL_TYPE_LAST) {
                if (pending) {
                    yield Buffer.concat([pending, frag]);
                    pending = null;
                }
            }
            p = dataEnd;
        }
        blockStart = blockEnd;
    }
}

function* iterWalBatchOps(record) {
    if (record.length < 12) return;
    // skip [seq:8][count:4]
    let p = 12;
    while (p < record.length) {
        const op = record[p]; p += 1;
        if (op === WAL_OP_PUT) {
            const kl = readVarint(record, p); p = kl.next;
            const key = record.slice(p, p + kl.value);
            p += kl.value;
            const vl = readVarint(record, p); p = vl.next;
            const value = record.slice(p, p + vl.value);
            p += vl.value;
            yield { key, value };
        } else if (op === WAL_OP_DELETE) {
            const kl = readVarint(record, p); p = kl.next;
            p += kl.value;
        } else {
            // Unknown op — record is corrupt or truncated; bail.
            return;
        }
    }
}

function scanWalFile(filePath) {
    const buf = fs.readFileSync(filePath);
    const out = [];
    try {
        for (const rec of iterWalLogicalRecords(buf)) {
            try {
                for (const kv of iterWalBatchOps(rec)) {
                    out.push(kv);
                }
            } catch (e) {
                // Skip malformed batch record but keep going on the rest.
            }
        }
    } catch (e) {
        return { entries: out, warning: `WAL scan aborted for ${path.basename(filePath)}: ${e.message}` };
    }
    return { entries: out };
}

function scanLevelDbDir(dirPath) {
    if (!fs.existsSync(dirPath)) throw new Error(`directory not found: ${dirPath}`);
    const names = fs.readdirSync(dirPath);
    const ldbFiles = names.filter(n => n.endsWith('.ldb') || n.endsWith('.sst')).sort();
    const logFiles = names.filter(n => n.endsWith('.log')).sort();
    const entries = [];
    const warnings = [];
    for (const n of ldbFiles) {
        const r = scanSstFile(path.join(dirPath, n));
        if (r.warning) warnings.push(r.warning);
        for (const kv of r.entries) {
            if (kv.__warning__) { warnings.push(kv.__warning__); continue; }
            entries.push(kv);
        }
    }
    for (const n of logFiles) {
        const r = scanWalFile(path.join(dirPath, n));
        if (r.warning) warnings.push(r.warning);
        for (const kv of r.entries) entries.push(kv);
    }
    return { entries, warnings };
}

module.exports = { scanLevelDbDir, scanSstFile, scanWalFile, readVarint };
