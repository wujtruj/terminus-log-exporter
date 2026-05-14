'use strict';
// Envelope: [0x04 0x01][24-byte nonce][cipher][16-byte Poly1305 tag]
// Decryption: libsodium crypto_secretbox_open_easy via tweetnacl.

const nacl = require('tweetnacl');

class TermiusDecryptError extends Error {}

function stripEnvelope(raw, expectedPrefix) {
    if (raw.length < expectedPrefix.length + 24 + 16) {
        throw new TermiusDecryptError(`blob too short (${raw.length} bytes)`);
    }
    for (let i = 0; i < expectedPrefix.length; i++) {
        if (raw[i] !== expectedPrefix[i]) {
            throw new TermiusDecryptError(
                `bad envelope prefix: got ${raw.slice(0, expectedPrefix.length).toString('hex')}, ` +
                `want ${Buffer.from(expectedPrefix).toString('hex')}`
            );
        }
    }
    const body = raw.slice(expectedPrefix.length);
    const nonce = body.slice(0, 24);
    const cipher = body.slice(24);
    return { nonce, cipher };
}

function _open(cipher, nonce, key) {
    const out = nacl.secretbox.open(
        new Uint8Array(cipher.buffer, cipher.byteOffset, cipher.byteLength),
        new Uint8Array(nonce.buffer, nonce.byteOffset, nonce.byteLength),
        new Uint8Array(key.buffer, key.byteOffset, key.byteLength),
    );
    if (!out) throw new TermiusDecryptError('secretbox auth failed');
    return Buffer.from(out);
}

class SecretBoxSystem {
    constructor(key) {
        if (!Buffer.isBuffer(key) && !(key instanceof Uint8Array)) {
            throw new Error('key must be Buffer/Uint8Array');
        }
        if (key.length !== 32) throw new Error(`key must be 32 bytes, got ${key.length}`);
        this.key = Buffer.isBuffer(key) ? key : Buffer.from(key);
    }
    decryptLocalStorage(blobB64) {
        const raw = Buffer.from(blobB64, 'base64');
        const { nonce, cipher } = stripEnvelope(raw, Buffer.from([0x04, 0x01]));
        return _open(cipher, nonce, this.key);
    }
    decryptIndexedDB(blobB64) {
        return this.decryptLocalStorage(blobB64);
    }
}

function decodeLocalKey(spec) {
    const s = spec.trim().replace(/^['"]|['"]$/g, '');
    try {
        const b = Buffer.from(s, 'base64');
        if (b.length === 32) {
            // Sanity-check: re-encoding should equal input (modulo padding).
            const re = b.toString('base64');
            if (re.replace(/=+$/, '') === s.replace(/=+$/, '')) return b;
        }
    } catch {}
    if (/^[0-9a-fA-F]+$/.test(s) && s.length === 64) {
        return Buffer.from(s, 'hex');
    }
    throw new TermiusDecryptError(`localKey must decode to exactly 32 bytes (got ${JSON.stringify(spec)})`);
}

module.exports = { SecretBoxSystem, TermiusDecryptError, decodeLocalKey, stripEnvelope };
