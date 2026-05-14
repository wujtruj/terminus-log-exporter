# CLAUDE.md

Notes for future Claude sessions working in this repo. Treat the user-facing details in `README.md` as canonical; this file captures non-obvious context that makes future work faster.

## What this project does

Recovers Termius SSH session logs (`session-logs-v2/<uuid>.log`) into plaintext `.txt` files. End-to-end encrypted with libsodium — needs the Windows-side `localKey` to unlock everything, then libtermius's native `LogReader` to crack the per-session secretstream framing.

## Toolchain

Single pipeline, all on the Windows jumpbox where Termius is installed.

| runtime | what runs there | why |
|---|---|---|
| system Node.js 20+ x64 | `extract_keys.js` (+ `lib/*.js`) | reads Local Storage + IndexedDB LevelDB via a pure-JS reader (`leveldb_reader.js`, comparator-agnostic, snappy decompress, SST + WAL), decrypts envelopes via `tweetnacl`, decodes V8 SSV; outputs `decrypted/keys.json` |
| Termius.exe (Electron 21) as Node, via `ELECTRON_RUN_AS_NODE=1` | `decrypt_via_libtermius.js` | only place where the matching `@termius/libtermius.node` ABI exists |
| PowerShell | `run_all.ps1` | orchestrator: stops Termius, snapshots LevelDB to a tempdir, restarts Termius, captures `localKey` (via `get_local_key.ps1` → `dump_local_key.ps1`), runs `extract_keys.js`, then `run_helper.ps1` |

`localKey` flows from PS → `$env:TERMIUS_LOCAL_KEY_B64` (single child process) → `node`. Never on argv. Cleared immediately after `extract_keys.js` returns.

Plain `node.exe` cannot load libtermius (`Module did not self-register`). `run_helper.ps1` is the launcher that sets `ELECTRON_RUN_AS_NODE=1` and exec's Termius.exe.

The pure-JS LevelDB reader must scan the WAL (`*.log` in the LevelDB dirs) as well as `*.ldb` SSTs — `UPLOAD_FAILED` `session_log_data` records (the only recoverable ones) frequently live in the WAL until Chromium compacts them. Skipping the WAL silently loses the freshest sessions.

**Recovery design note**: the reader does NOT honor MANIFEST file-obsolescence or cross-file deletion tombstones. It scans every `.ldb` plus the WAL and de-duplicates by `local_id` (last write wins by scan order: alphabetical SSTs, then WAL). Side effect: superseded historical `session_log_data` records — ones that Termius later nulled after a successful upload — are recovered if they still exist in older SST files. This intentionally lets us decrypt `.log` files that a strictly merged view treats as orphans. Empirically on the sample dump this surfaced ~3x more recoverable sessions than a merged view; the extras all have their `.log` on disk and decrypt cleanly.

## Crypto chain (don't re-derive from scratch)

- Local Storage values + IndexedDB history records both share envelope `[0x04 0x01][24-byte nonce][cipher][16-byte Poly1305 tag]` = libsodium `crypto_secretbox`. Same `localKey` decrypts both — Termius calls it `localCryptoSystem`.
- `session-logs-v2/<uuid>.log` files use libsodium `crypto_secretstream_xchacha20poly1305` framed by libtermius. The framing is internal to the `.node` binary; do not try to re-implement it. Re-implementation attempts already failed.
- Per-session 32-byte key comes from `session_log_data.secretKey` in IndexedDB. Only present for sessions whose `log_status == 'UPLOAD_FAILED'`. After successful cloud upload, Termius nulls `session_log_data` locally — those `.log` files become orphan ciphertext.

## libtermius LogReader API

Recovered from `app.asar/ui-process/assets/ui-process-bbeccd12.js` (offset 38149):

```js
new terminalOutput.LogReader({
  filename:      string,            // path to encrypted .log
  encryptionKey: Buffer,            // 32-byte per-session key
  onDataReady:   (buf: Buffer) => void,   // buf.length === 0 means EOF
  onError:       (a, b, msg) => void,
});
```

Construction kicks off async streaming. **All four fields are mandatory** — omitting `onDataReady` or `onError` crashes V8 with `FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal`. That's a NAPI assertion in libtermius's C++ and is NOT catchable from JS.

## IndexedDB quirks

Chromium uses `idb_cmp1` LevelDB comparator. The pure-JS reader is comparator-agnostic (no need to register `idb_cmp1`); it scans every record and lets the caller de-duplicate by primary key.

Values are V8 structured-clone serialized. `lib/v8_ssv.js` has a minimal decoder for the subset Termius uses (utf-8 strings, ints, doubles, nested objects, arrays).

## Things that look broken but aren't

- `personalKey`, `privateKey`, `publicKey` in `keys.json` are unused for the current pipeline. Kept because they were unwrapped along the way and could be useful for cloud-side API calls.
- `apiKey` in `keys.json` is the Termius API bearer token. Could in principle be used to download cloud-stored encrypted logs for the `DELETED` sessions, then their keys would need to come from the server-side keypair flow. Not implemented.

## Common edits, expected blast radius

| change | edit |
|---|---|
| New credential field in Local Storage | `lib/localstorage.js` `CREDENTIAL_NAMES` |
| Different session record schema | `lib/vault.js` `_recordFromObj` (V8 field extraction) |
| libtermius API change between Termius versions | `decrypt_via_libtermius.js` — check `terminalOutput.*` inventory at startup |
| New Termius install path | `dump_local_key.ps1` (`Termius/localKey` target) + `run_helper.ps1` (Termius.exe path) + `run_all.ps1` |
| New V8 SSV tag from a Chromium upgrade | `lib/v8_ssv.js` `decodeValue` |
| LevelDB on-disk format change (snappy variant, etc.) | `lib/leveldb_reader.js` |

## Version banner

`decrypt_via_libtermius.js`, `extract_keys.js`, and `run_all.ps1` each print a `<script>.{ps1|js} <SCRIPT_VERSION>` line as their first output. Bump each constant on every change so we can confirm which copy is loaded on the jumpbox (stale copies were a recurring issue during dev).

## Operational footguns

- **Never** commit `decrypted/keys.json` or any `.log` / `.txt` output to git. `.gitignore` covers these.
- The user's `localKey` is the master credential — handle it like a password (no logs, no clipboard managers, no chat history with the value pasted).
- `app.asar.unpacked/` is huge (161 MB of `app.asar` decompresses to ~500 MB). Not committed.
