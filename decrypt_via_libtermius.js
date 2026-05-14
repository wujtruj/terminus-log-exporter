#!/usr/bin/env node
// Decrypt Termius session-logs-v2/*.log files using libtermius's terminalOutput.LogReader.
//
// Run on the Windows jumpbox where Termius is installed (any cwd, PowerShell or cmd):
//
//   .\run_helper.ps1 decrypted\keys.json
//
// Or directly with Termius's bundled Electron as Node:
//
//   $env:ELECTRON_RUN_AS_NODE = "1"
//   & "$env:LOCALAPPDATA\Programs\Termius\Termius.exe" decrypt_via_libtermius.js decrypted\keys.json
//
// Optional flags: [--asar <app.asar.unpacked>] [--logs-dir <dir>] [--out <dir>]
//
// LogReader options shape (recovered from app.asar's ui-process bundle):
//   new terminalOutput.LogReader({
//     filename:      <path to encrypted .log>,
//     encryptionKey: <32-byte Buffer>,
//     onDataReady:   (buf) => { /* buf.length === 0 means EOF */ },
//     onError:       (a, b, msg) => { /* errors */ },
//   })
// Construction is what kicks off the async stream; data arrives via callbacks.
'use strict';
const SCRIPT_VERSION = '2026-05-14.v7';
console.log(`decrypt_via_libtermius.js ${SCRIPT_VERSION}`);
const fs = require('fs');
const path = require('path');

function expandEnv(p) {
    if (!p) return p;
    return p.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
}

function parseArgs(argv) {
    const out = { positional: [], 'logs-dir': [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--logs-dir') {
            out['logs-dir'].push(expandEnv(argv[++i]));
        } else if (a === '--asar' || a === '--out') {
            out[a.replace(/^--/, '')] = expandEnv(argv[++i]);
        } else {
            out.positional.push(expandEnv(a));
        }
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const keysJsonPath = args.positional[0];
if (!keysJsonPath) {
    console.error('usage: node decrypt_via_libtermius.js <keys.json> [--asar <dir>] [--logs-dir <dir>] [--out <dir>]');
    process.exit(2);
}
if (!fs.existsSync(keysJsonPath)) {
    console.error(`keys.json not found: ${keysJsonPath}`);
    process.exit(2);
}
const bundle = JSON.parse(fs.readFileSync(keysJsonPath, 'utf8'));
const keysDir = path.dirname(path.resolve(keysJsonPath));

function resolveLibtermius(supplied) {
    const candidates = [];
    if (supplied) candidates.push(path.join(supplied, 'node_modules', '@termius', 'libtermius'));
    const local = process.env.LOCALAPPDATA;
    if (local) {
        candidates.push(path.join(local, 'Programs', 'Termius', 'resources', 'app.asar.unpacked', 'node_modules', '@termius', 'libtermius'));
    }
    candidates.push(path.join(process.cwd(), 'node_modules', '@termius', 'libtermius'));
    for (const c of candidates) {
        try { if (fs.statSync(c).isDirectory()) return c; } catch {}
    }
    return null;
}

function resolveLogsDirs(suppliedList, bundleLogDir, keysDir) {
    // Returns ALL directories that exist, user-supplied first, then auto-detected fallbacks.
    const candidates = [];
    for (const s of suppliedList || []) candidates.push(s);
    if (bundleLogDir) candidates.push(bundleLogDir);
    candidates.push(path.join(keysDir, '..', 'Termius', 'session-logs-v2'));
    candidates.push(path.join(keysDir, 'session-logs-v2'));
    candidates.push(path.join(keysDir, 'Termius', 'session-logs-v2'));
    const local = process.env.LOCALAPPDATA;
    if (local) candidates.push(path.join(local, 'Termius', 'session-logs-v2'));
    const roaming = process.env.APPDATA;
    if (roaming) candidates.push(path.join(roaming, 'Termius', 'session-logs-v2'));
    const found = [];
    const seen = new Set();
    for (const c of candidates) {
        try {
            if (fs.statSync(c).isDirectory()) {
                const real = fs.realpathSync(c);
                if (!seen.has(real)) {
                    seen.add(real);
                    found.push(c);
                }
            }
        } catch {}
    }
    return found;
}

function findLogFile(logsDirs, filename) {
    for (const d of logsDirs) {
        const p = path.join(d, filename);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

const libtermiusPath = resolveLibtermius(args.asar);
if (!libtermiusPath) {
    console.error('could not locate @termius/libtermius. pass --asar <path-to-app.asar.unpacked> if Termius is installed elsewhere.');
    process.exit(2);
}
console.log(`resolved libtermius: ${libtermiusPath}`);

const logsDirs = resolveLogsDirs(args['logs-dir'], bundle.log_dir, keysDir);
if (logsDirs.length === 0) {
    console.error('could not locate any session-logs-v2 directory. pass --logs-dir <path> (multiple allowed) to override.');
    process.exit(2);
}
console.log(`resolved session-logs-v2 (${logsDirs.length}):`);
for (const d of logsDirs) console.log(`  - ${d}`);

const outDir = args.out ?? keysDir;
fs.mkdirSync(outDir, { recursive: true });
console.log(`output dir: ${outDir}`);

let libtermius;
try {
    libtermius = require(libtermiusPath);
} catch (e) {
    console.error(`failed to require @termius/libtermius from ${libtermiusPath}: ${e.message}`);
    process.exit(2);
}

const term = libtermius.terminalOutput || libtermius.default?.terminalOutput;
if (!term || typeof term.LogReader !== 'function') {
    console.error('libtermius.terminalOutput.LogReader not available. Top-level keys:');
    console.error(Object.keys(libtermius));
    process.exit(3);
}
console.log('found terminalOutput.LogReader');

// LogReader is async/push-based: construction kicks off streaming, data arrives via callbacks.
function decryptOne(filename, key) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let settled = false;
        // Keep a strong reference so the reader isn't GC'd before EOF.
        const reader = new term.LogReader({
            filename,
            encryptionKey: key,
            onDataReady: (buf) => {
                if (settled) return;
                if (buf && buf.length > 0) {
                    chunks.push(Buffer.from(buf));
                } else {
                    settled = true;
                    void reader; // strong reference held until here
                    resolve(Buffer.concat(chunks));
                }
            },
            onError: (a, b, msg) => {
                if (settled) return;
                settled = true;
                reject(new Error(msg || `LogReader error code=${a} sub=${b}`));
            },
        });
    });
}

(async () => {
    let ok = 0;
    const knownFilenames = new Set();
    for (const s of bundle.sessions) {
        if (s.filename) knownFilenames.add(s.filename);
        if (!s.session_key_b64 || !s.filename) continue;
        const inFile = findLogFile(logsDirs, s.filename);
        if (!inFile) {
            console.error(`[skip] ${s.filename}: not present in any of the searched dirs`);
            continue;
        }
        const outFile = path.join(outDir, s.filename.replace(/\.log$/, '.txt'));
        const key = Buffer.from(s.session_key_b64, 'base64');
        process.stderr.write(`decrypting ${s.filename} (from ${path.dirname(inFile)}) ...\n`);
        try {
            const plaintext = await decryptOne(inFile, key);
            fs.writeFileSync(outFile, plaintext);
            console.log(`[ok] ${s.filename} -> ${outFile} (${plaintext.length} bytes)`);
            ok++;
        } catch (e) {
            console.error(`[fail] ${s.filename}: ${e.message}`);
        }
    }
    console.log(`\ndecrypted ${ok} session(s)`);

    // Orphan report: .log files on disk that we can't decrypt.
    const sessionsByFile = new Map();
    for (const s of bundle.sessions) if (s.filename) sessionsByFile.set(s.filename, s);
    const orphans = [];
    const noKey = [];
    for (const d of logsDirs) {
        for (const f of fs.readdirSync(d).filter(n => n.endsWith('.log'))) {
            const s = sessionsByFile.get(f);
            if (!s) orphans.push({ filename: f, dir: d });
            else if (!s.session_key_b64) noKey.push({ filename: f, dir: d, log_status: s.log_status });
        }
    }
    if (noKey.length || orphans.length) {
        console.log(`\nunrecoverable .log files (no usable key locally):`);
        for (const o of noKey) console.log(`  - ${o.filename}  (log_status=${o.log_status}, in ${o.dir})`);
        for (const o of orphans) console.log(`  - ${o.filename}  (not in keys.json, in ${o.dir})`);
        console.log(`These can only be decrypted by re-fetching the per-session key from the Termius cloud (the local copy was wiped after upload).`);
    }
    process.exit(ok > 0 ? 0 : 4);
})().catch(e => {
    console.error(`unexpected error: ${e.stack || e.message}`);
    process.exit(5);
});
