'use strict';
// Port of inspect_v8.py — V8 structured-clone subset.

const MAX_DEPTH = 12;

class Reader {
    constructor(data) {
        this.data = data;
        this.pos = 0;
    }
    eof() { return this.pos >= this.data.length; }
    peek() { return this.eof() ? -1 : this.data[this.pos]; }
    u8() {
        const b = this.data[this.pos];
        this.pos += 1;
        return b;
    }
    varintBig() {
        let result = 0n;
        let shift = 0n;
        while (true) {
            const b = this.u8();
            result |= BigInt(b & 0x7F) << shift;
            if (!(b & 0x80)) return result;
            shift += 7n;
        }
    }
    varint() {
        const v = this.varintBig();
        return v <= 9007199254740991n ? Number(v) : v;
    }
    zigzag() {
        const v = this.varintBig();
        // (v >> 1) ^ -(v & 1)
        const sign = -(v & 1n);
        const z = (v >> 1n) ^ sign;
        if (z >= -9007199254740991n && z <= 9007199254740991n) return Number(z);
        return z;
    }
    bytes(n) {
        const out = this.data.slice(this.pos, this.pos + n);
        this.pos += n;
        return out;
    }
}

const C_UNDERSCORE = 0x5F, C_ZERO = 0x30, C_T = 0x54, C_F = 0x46;
const C_I = 0x49, C_U = 0x55, C_N = 0x4E;
const C_QUOTE = 0x22, C_c = 0x63, C_S = 0x53;
const C_o = 0x6F, C_OBJ_END = 0x7B; // '{'
const C_A = 0x41, C_AT = 0x40;
const C_a = 0x61, C_DOLLAR = 0x24;
const C_B = 0x42;

function decodeValue(r, depth = 0) {
    if (depth > MAX_DEPTH) return { __overflow__: true };
    if (r.eof()) return null;
    const tag = r.u8();

    if (tag === 0x00) return decodeValue(r, depth);
    if (tag === C_UNDERSCORE) return null;
    if (tag === C_ZERO) return null;
    if (tag === C_T) return true;
    if (tag === C_F) return false;
    if (tag === C_I) return r.zigzag();
    if (tag === C_U) return r.varint();
    if (tag === C_N) {
        const buf = r.bytes(8);
        return buf.readDoubleLE(0);
    }
    if (tag === C_QUOTE) {
        const n = Number(r.varintBig());
        return r.bytes(n).toString('utf8');
    }
    if (tag === C_c) {
        const n = Number(r.varintBig());
        return r.bytes(n).toString('utf16le');
    }
    if (tag === C_S) {
        const n = Number(r.varintBig());
        return r.bytes(n).toString('latin1');
    }
    if (tag === C_o) {
        const props = {};
        while (true) {
            if (r.peek() === C_OBJ_END) {
                r.u8();
                r.varintBig(); // expected count
                return props;
            }
            if (r.eof()) return props;
            const key = decodeValue(r, depth + 1);
            const value = decodeValue(r, depth + 1);
            if (typeof key === 'string' || typeof key === 'number' || typeof key === 'bigint') {
                props[String(key)] = value;
            } else {
                props[`__nonstring_key_${tag}__`] = value;
            }
        }
    }
    if (tag === C_A) {
        const length = Number(r.varintBig());
        const items = {};
        while (true) {
            if (r.peek() === C_AT) {
                r.u8();
                r.varintBig();
                r.varintBig();
                const arr = new Array(length);
                for (let i = 0; i < length; i++) arr[i] = items[i] !== undefined ? items[i] : null;
                return arr;
            }
            if (r.eof()) return items;
            const key = decodeValue(r, depth + 1);
            const value = decodeValue(r, depth + 1);
            if (typeof key === 'number') items[key] = value;
        }
    }
    if (tag === C_a) {
        const length = Number(r.varintBig());
        const arr = [];
        for (let i = 0; i < length; i++) arr.push(decodeValue(r, depth + 1));
        if (r.peek() === C_DOLLAR) {
            r.u8();
            r.varintBig();
            r.varintBig();
        }
        return arr;
    }
    if (tag === C_B) {
        const n = Number(r.varintBig());
        return r.bytes(n);
    }
    if (tag === 0xFF) {
        r.varintBig(); // version
        return decodeValue(r, depth);
    }
    if (tag === 0x14 || tag === 0x0D || tag === 0x0E || tag === 0x0F) {
        return decodeValue(r, depth);
    }
    const rem = r.data.slice(r.pos, r.pos + 32).toString('hex');
    return { __unknown_tag__: `0x${tag.toString(16).padStart(2, '0')}`, __remaining_hex__: rem };
}

function decodeFromBytes(buf, start = 0) {
    return decodeValue(new Reader(buf.slice(start)));
}

module.exports = { Reader, decodeValue, decodeFromBytes };
