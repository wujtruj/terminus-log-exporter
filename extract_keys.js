#!/usr/bin/env node
'use strict';
// Reads Termius's Local Storage + IndexedDB (LevelDB) directly from a
// snapshot of %APPDATA%\Termius, decrypts envelopes with the 32-byte
// localKey (passed via TERMIUS_LOCAL_KEY_B64 env var), decodes V8 SSV,
// and writes decrypted/keys.json in the schema decrypt_via_libtermius.js
// consumes.
//
// Usage (env-var passes the master credential; argv never holds it):
//   $env:TERMIUS_LOCAL_KEY_B64 = "<base64 from dump_local_key.ps1>"
//   node extract_keys.js --data-dir <snapshot of Termius/> [--logs-dir <dir>] [--out decrypted]

const SCRIPT_VERSION = '2026-05-14.v2';
console.log(`extract_keys.js ${SCRIPT_VERSION}`);

const fs = require('fs');
const path = require('path');

const { scanLevelDbDir } = require('./lib/leveldb_reader');
const { SecretBoxSystem, TermiusDecryptError, decodeLocalKey } = require('./lib/termius_crypto');
const { readCredentials } = require('./lib/localstorage');
const { iterSessionRecords, hasLocalKey } = require('./lib/vault');

function parseArgs(argv) {
    const out = { 'data-dir': 'Termius', out: 'decrypted', 'logs-dir': null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--data-dir' || a === '--out' || a === '--logs-dir') {
            out[a.replace(/^--/, '')] = argv[++i];
        } else if (a === '--help' || a === '-h') {
            out.help = true;
        }
    }
    return out;
}

function usage() {
    console.error('usage: node extract_keys.js [--data-dir <dir>] [--logs-dir <dir>] [--out <dir>]');
    console.error('env: TERMIUS_LOCAL_KEY_B64 (required) — base64 of the 32-byte localKey');
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { usage(); return 0; }

    const dataDir = path.resolve(args['data-dir']);
    const outDir = path.resolve(args.out);
    const logsDir = args['logs-dir']
        ? path.resolve(args['logs-dir'])
        : path.join(dataDir, 'session-logs-v2');
    const idbPath = path.join(dataDir, 'IndexedDB', 'file__0.indexeddb.leveldb');
    const lsPath = path.join(dataDir, 'Local Storage', 'leveldb');

    for (const [p, label] of [[idbPath, 'IndexedDB'], [logsDir, 'session-logs-v2'], [lsPath, 'Local Storage']]) {
        if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
            console.error(`missing ${label} at ${p}`);
            return 2;
        }
    }

    const keySpec = process.env.TERMIUS_LOCAL_KEY_B64 || process.env.TERMIUS_LOCAL_KEY_HEX;
    if (!keySpec) {
        console.error('error: TERMIUS_LOCAL_KEY_B64 (or TERMIUS_LOCAL_KEY_HEX) env var is required');
        console.error('Run get_local_key.ps1 to obtain it from Windows Credential Manager.');
        return 2;
    }

    let localKey;
    try {
        localKey = decodeLocalKey(keySpec);
    } catch (e) {
        console.error(`error: ${e.message}`);
        return 2;
    }
    const box = new SecretBoxSystem(localKey);

    // Scan Local Storage LevelDB.
    const lsScan = scanLevelDbDir(lsPath);
    for (const w of lsScan.warnings) console.error(`[ls warn] ${w}`);
    let plainCreds;
    try {
        const envelopes = readCredentials(lsScan.entries);
        plainCreds = {};
        for (const [name, blob] of Object.entries(envelopes)) {
            try {
                plainCreds[name] = box.decryptLocalStorage(blob).toString('ascii');
            } catch (e) {
                console.error(`error: localKey did not unwrap ${name} (${e.message}). Wrong key?`);
                return 3;
            }
        }
    } catch (e) {
        console.error(`error: ${e.message}`);
        return 3;
    }
    console.log(`unlocked ${Object.keys(plainCreds).length} Local Storage credentials`);

    // Scan IndexedDB LevelDB.
    const idbScan = scanLevelDbDir(idbPath);
    for (const w of idbScan.warnings) console.error(`[idb warn] ${w}`);
    fs.mkdirSync(outDir, { recursive: true });

    const logPaths = new Map();
    for (const f of fs.readdirSync(logsDir)) {
        if (f.endsWith('.log')) {
            const full = path.join(logsDir, f);
            logPaths.set(f, { path: full, size: fs.statSync(full).size });
        }
    }

    const sessions = [];
    for (const rec of iterSessionRecords(idbScan.entries)) {
        const entry = {
            local_id: rec.local_id,
            remote_id: rec.remote_id,
            timestamp: rec.timestamp,
            log_status: rec.log_status,
            has_local_key: hasLocalKey(rec),
        };
        if (hasLocalKey(rec)) {
            try {
                const namePlain = box.decryptIndexedDB(rec.name_blob).toString('ascii');
                const secretKeyB64 = box.decryptIndexedDB(rec.secretkey_blob).toString('ascii');
                const sessionKey = Buffer.from(secretKeyB64, 'base64');
                entry.filename = namePlain;
                entry.session_key_b64 = secretKeyB64;
                entry.session_key_hex = sessionKey.toString('hex');
                entry.log_file_present = logPaths.has(namePlain);
                if (entry.log_file_present) {
                    entry.log_file_size = logPaths.get(namePlain).size;
                }
            } catch (e) {
                entry.error = `could not unwrap session_log_data: ${e.message}`;
            }
        }
        sessions.push(entry);
    }
    // Sort by local_id for deterministic output (Python's plyvel iteration is
    // sorted by idb_cmp1, which we don't replicate; sort here for stability).
    sessions.sort((a, b) => {
        const aid = a.local_id ?? Number.MAX_SAFE_INTEGER;
        const bid = b.local_id ?? Number.MAX_SAFE_INTEGER;
        return aid - bid;
    });

    const bundle = {
        credentials: plainCreds,
        sessions,
        log_dir: logsDir,
    };
    const outPath = path.join(outDir, 'keys.json');
    fs.writeFileSync(outPath, JSON.stringify(bundle, replacerBigInt, 2));
    console.log(`wrote ${outPath}`);

    const recoverable = sessions.filter(s => s.session_key_b64 && s.log_file_present);
    console.log(`\nsessions in IndexedDB: ${sessions.length}`);
    console.log(`with local key + on-disk file: ${recoverable.length}`);
    for (const s of recoverable) {
        const lid = String(s.local_id ?? '?').padEnd(3);
        console.log(`  local_id=${lid}  ${s.timestamp}  ${s.filename} (${s.log_file_size} bytes)`);
    }
    if (recoverable.length) {
        console.log(`\nNext: pass ${outPath} to decrypt_via_libtermius.js (run via run_helper.ps1).`);
    }
    return 0;
}

function replacerBigInt(_, v) {
    if (typeof v === 'bigint') return v.toString();
    if (Buffer.isBuffer(v)) return v.toString('latin1');
    return v;
}

process.exit(main());
