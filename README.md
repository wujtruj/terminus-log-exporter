# terminus-log-converter

Decrypt Termius SSH session logs (`session-logs-v2/<uuid>.log`) into plaintext `.txt`.

Termius has no built-in export. Logs are end-to-end encrypted with libsodium; this repo reverses the local crypto chain so logs can be recovered from a copied Windows AppData directory.

There are two ways to run this:

- **Windows-only (recommended).** Everything runs on the Windows jumpbox where Termius is installed. See [`windows/README.md`](windows/README.md) — single command: `.\windows\run_all.ps1`. No Mac, no Python.
- **macOS Python pipeline (alternative).** Copy Termius's AppData to a Mac, run the Python tool there, ship `keys.json` back to Windows for the libtermius stage. Documented below — kept fully functional as a fallback.

## Pipeline (Windows-only, recommended)

```
Windows jumpbox
───────────────
run_all.ps1
 ├─► stops Termius
 ├─► snapshots %APPDATA%\Termius\{Local Storage, IndexedDB}
 ├─► restarts Termius
 ├─► get_local_key.ps1 ──► dump_local_key.ps1 ──► localKey (base64)
 ├─► extract_keys.js (Node)
 │     - reads LevelDB snapshots (pure JS reader, SST + WAL)
 │     - decrypts envelopes via tweetnacl
 │     - decodes V8 SSV
 │     - writes decrypted\keys.json
 └─► run_helper.ps1 ──► decrypt_via_libtermius.js (under Termius.exe)
       - libtermius terminalOutput.LogReader
       - writes decrypted\<uuid>.txt
```

Quick start:

```powershell
cd <repo>\windows
npm install                          # one-time, can be vendored for offline use
cd ..
.\windows\run_all.ps1
```

See [`windows/README.md`](windows/README.md) for flags, offline install, and step-by-step manual execution.

## Pipeline (macOS Python — alternative)

```
Windows jumpbox                                   Mac (this repo)              Windows jumpbox
───────────────                                   ───────────────              ───────────────
dump_local_key.ps1 ──┐                                                  ┌─── run_helper.ps1
   reads             │                                                  │       loads libtermius
   "Termius/localKey"│                                                  │       via Termius.exe
   from Credential   │  (paste 44-char base64)                          │       (ELECTRON_RUN_AS_NODE=1)
   Manager           ▼                                                  │
                                                                        │
                  decrypt_termius_logs.py ─── writes ──► keys.json ─────┤
                  (Python on Mac)                                       │
                  - reads Termius/Local Storage                         │
                  - reads Termius/IndexedDB                             │
                  - unwraps every credential                            │
                  - emits per-session secretKey                         │
                                                                        ▼
                                                                  decrypt_via_libtermius.js
                                                                  - loads @termius/libtermius
                                                                    from app.asar.unpacked
                                                                  - new terminalOutput.LogReader({
                                                                      filename, encryptionKey,
                                                                      onDataReady, onError })
                                                                  - writes <uuid>.txt
```

### 1. On the Windows jumpbox

Extract the 32-byte `localKey` from Windows Credential Manager:

```powershell
.\dump_local_key.ps1
```

Output: `localKey (base64): <44-char-string>`. Copy that string.

### 2. On this Mac

Place the copied Termius AppData directory at `./Termius/` (must contain `Local Storage/`, `IndexedDB/`, `session-logs-v2/`). Then:

```bash
./setup.sh
source .venv/bin/activate
python3 decrypt_termius_logs.py --local-key-b64 '<paste 44-char string>'
```

Output: `decrypted/keys.json` containing every Local Storage credential in plaintext (`apiKey`, `encryptionSalt`, `hmacSalt`, `personalKey`, `privateKey`, `publicKey`) and, for every session in IndexedDB, its filename + per-session 32-byte `secretKey` when still available locally.

### 3. Back on the Windows jumpbox

Copy `decrypt_via_libtermius.js`, `run_helper.ps1`, and `decrypted\keys.json` to the jumpbox. Optionally copy the original Mac-side `Termius/session-logs-v2/` too if some `.log` files are missing from the runtime folder. Then:

```powershell
.\run_helper.ps1 decrypted\keys.json
```

Or with multiple log directories (live + Mac-side copy):

```powershell
.\run_helper.ps1 decrypted\keys.json `
  --logs-dir "C:\Users\<you>\AppData\Roaming\Termius\session-logs-v2" `
  --logs-dir "C:\path\to\copied\Termius\session-logs-v2"
```

Output: `decrypted\<uuid>.txt` per recoverable session, plus a trailing list of orphan `.log` files (encrypted with cloud-only keys, can't be recovered locally).

## Why it needs Termius's bundled Electron

`@termius/libtermius` is built against Electron 21's Node ABI. Plain `node.exe` rejects it with `Module did not self-register`. `run_helper.ps1` sets `ELECTRON_RUN_AS_NODE=1` and invokes `Termius.exe` (which IS Electron 21) as the runtime. Override `Termius.exe`'s location with `-TermiusExe <path>` if needed.

Manual fallback without the launcher:

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "$env:LOCALAPPDATA\Programs\Termius\Termius.exe" decrypt_via_libtermius.js decrypted\keys.json
```

## What's recoverable

| status                | meaning                                                                                                       | recoverable? |
|-----------------------|---------------------------------------------------------------------------------------------------------------|---|
| `UPLOAD_FAILED`       | Session log never uploaded to cloud — per-session `secretKey` still in IndexedDB                              | yes |
| `DELETED` (synced)    | Successfully uploaded; Termius wipes `session_log_data` locally to leave only the cloud copy                  | no — `.log` is orphan ciphertext, key now exists only on Termius's server |
| `.log` not in keys.json | The runtime folder has files Termius never indexed (rare; usually leftovers from interrupted writes)         | no — no key |

## Crypto layout (reverse-engineered from `app.asar`, Termius 9.38.2)

```
IndexedDB record / Local Storage credential  ("BA...=" base64):
  [0x04 0x01]  [24-byte nonce]  [ciphertext]  [16-byte Poly1305 tag]
  decryption: crypto_secretbox_open_easy(nonce, body, key)

session-logs-v2/<uuid>.log:
  libsodium crypto_secretstream_xchacha20poly1305, framed by libtermius's
  native terminalOutput.Writer. Chunk layout is internal to the .node
  binary — only readable via libtermius's terminalOutput.LogReader
  (async callback API: onDataReady(buf), onError(...)).
```

Key chain:

```
localKey (32 bytes, Windows Credential Manager: "Termius/localKey")
  └─ unwraps Local Storage credentials AND the history table in IndexedDB
        (one localCryptoSystem instance does both)
        ├─ apiKey, encryptionSalt, hmacSalt, privateKey, publicKey, personalKey
        └─ session_log_data.{name, secretKey} for every session

per-session secretKey (32 bytes, from session_log_data.secretKey)
  └─ libtermius terminalOutput.LogReader decrypts the .log file
```

## Files

Top-level:

| file                          | purpose |
|---|---|
| `dump_local_key.ps1`          | PowerShell — extract `localKey` from Windows Credential Manager |
| `decrypt_via_libtermius.js`   | Node helper — `.log` → `.txt` via libtermius LogReader |
| `run_helper.ps1`              | PowerShell launcher — runs the Node helper under Termius.exe (Electron 21) |

Windows-native pipeline (`windows/`):

| file                          | purpose |
|---|---|
| `windows/run_all.ps1`         | Orchestrator — stop Termius, snapshot LevelDB, run extractor + libtermius helper |
| `windows/get_local_key.ps1`   | Capture-only wrapper around `dump_local_key.ps1` (emits bare base64 to stdout) |
| `windows/extract_keys.js`     | Node CLI — replaces `decrypt_termius_logs.py` on Windows |
| `windows/lib/leveldb_reader.js` | Pure-JS LevelDB scanner (SST + WAL, snappy decompress, comparator-agnostic) |
| `windows/lib/v8_ssv.js`       | V8 structured-clone decoder (JS port of `inspect_v8.py`) |
| `windows/lib/termius_crypto.js` | Secretbox envelope decrypt via `tweetnacl` |
| `windows/lib/localstorage.js` | Chromium Local Storage credential walker |
| `windows/lib/vault.js`        | Chromium IndexedDB session-record walker |
| `windows/package.json`        | `tweetnacl` + `snappyjs` |

macOS Python pipeline (alternative):

| file                          | purpose |
|---|---|
| `decrypt_termius_logs.py`     | macOS Python CLI — emit `decrypted/keys.json` |
| `termius_crypto.py`           | libsodium envelope helpers (secretbox + Local Storage / IndexedDB record envelope) |
| `termius_localstorage.py`     | Chromium Local Storage walker (LevelDB) |
| `termius_vault.py`            | Chromium IndexedDB walker (LevelDB, `idb_cmp1` comparator) |
| `inspect_v8.py`               | V8 structured-clone decoder used by the IndexedDB walker |
| `inspect_*.py`                | one-off discovery scripts kept for reproducibility |
| `requirements.txt`            | `pynacl` + `plyvel-ci` |
| `setup.sh`                    | venv bootstrap (uses `python3`) |

## Layout expected in the working directory

```
.
├── Termius/                                # AppData copy from Windows
│   ├── IndexedDB/file__0.indexeddb.leveldb/
│   ├── Local Storage/leveldb/
│   ├── session-logs-v2/*.log
│   └── ...
├── decrypted/                              # output (created on first run)
│   ├── keys.json
│   └── <uuid>.txt                          # after step 3
├── app.asar.extracted/                     # optional, only if reversing further
└── *.py *.js *.ps1 *.sh
```

## Caveats

- Logs are written as a raw terminal stream — ANSI/VT100 escapes are preserved in the `.txt` output. Strip with `sed 's/\x1b\[[0-9;?]*[A-Za-z]//g'` or similar if desired.
- The Python tool runs on macOS (uses `python3`). The Node helper runs on Windows (needs the matching Electron 21 libtermius). The `localKey` lives in Windows Credential Manager and must be dumped there first.
- libtermius is bundled inside Termius itself, not redistributable. This repo contains no Termius code.
