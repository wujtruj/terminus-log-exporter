'use strict';
// Walk Chromium Local Storage entries and extract Termius credentials.
// See termius_localstorage.py for the reference implementation.

const CREDENTIAL_NAMES = [
    'apiKey',
    'encryptionSalt',
    'hmacSalt',
    'personalKey',
    'privateKey',
    'publicKey',
];

function _stripValueEnvelope(v) {
    // Trim leading 0x00/0x01 type marker.
    let start = 0;
    while (start < v.length && (v[start] === 0x00 || v[start] === 0x01)) start += 1;
    // Trim trailing nul bytes / whitespace.
    let end = v.length;
    while (end > start && (v[end - 1] === 0x00 || v[end - 1] === 0x20)) end -= 1;
    let s = v.slice(start, end).toString('latin1').trim();
    if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
    return s;
}

// Match keys whose tail is `\x01<name>` (Chromium prefixes the per-key store).
function _matchCredentialName(key) {
    for (const name of CREDENTIAL_NAMES) {
        const need = Buffer.concat([Buffer.from([0x01]), Buffer.from(name, 'utf8')]);
        if (key.length >= need.length) {
            if (key.slice(key.length - need.length).equals(need)) return name;
        }
    }
    return null;
}

function readCredentials(entries) {
    const out = {};
    for (const { key, value } of entries) {
        const name = _matchCredentialName(key);
        if (!name) continue;
        out[name] = _stripValueEnvelope(value);
    }
    const missing = CREDENTIAL_NAMES.filter(n => !(n in out));
    if (missing.length) {
        throw new Error(`missing credentials in Local Storage: ${missing.join(', ')}`);
    }
    return out;
}

module.exports = { readCredentials, CREDENTIAL_NAMES, _stripValueEnvelope };
