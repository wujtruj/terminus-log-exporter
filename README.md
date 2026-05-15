# terminus-log-exporter

Decrypt Termius SSH session logs (`session-logs-v2/<uuid>.log`) into plaintext `.txt`.

Termius has no built-in export. Logs are end-to-end encrypted with libsodium; this repo reverses the local crypto chain so logs can be recovered on the Windows jumpbox where Termius is installed.

Everything runs on Windows — no Mac, no Python. One command: `.\run_all.ps1`.

## Pipeline

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

## Prerequisites

- Termius for Windows installed (any modern version that ships `@termius/libtermius`).
- Node.js 20+ x64. The official `.zip` works (no admin, no MSI prompts). Extract it anywhere and add the directory to `PATH`, or set it per-session: `$env:PATH = "C:\node-v20\;$env:PATH"`.
- PowerShell 5.1 (built-in) or PowerShell 7.

If the jumpbox is locked-down (no script execution by default):

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

…or invoke each `.ps1` via `powershell -ExecutionPolicy Bypass -File <script>`.

## One-time install

```powershell
cd <repo>
npm install
```

Pulls `tweetnacl` and `snappyjs` (pure JS, no native compile).

For an **offline jumpbox** (no npm access), vendor `node_modules\` from another machine:

```powershell
# On a machine with internet:
cd <repo>
npm install
Compress-Archive node_modules node_modules.zip

# On the jumpbox:
Expand-Archive node_modules.zip <repo>\
```

## Run

```powershell
cd <repo>
.\run_all.ps1
```

This does, in order:

1. Stops Termius (graceful close, then `Stop-Process -Force`, then waits for the LevelDB `LOCK` file to be releasable).
2. Snapshots `%APPDATA%\Termius\Local Storage\leveldb` and `%APPDATA%\Termius\IndexedDB\file__0.indexeddb.leveldb` to a temp dir.
3. Starts Termius again — your sessions resume after ~1-2 s of downtime.
4. Reads `localKey` from Windows Credential Manager (`get_local_key.ps1` → `dump_local_key.ps1`).
5. Runs `extract_keys.js` against the snapshot, writes `decrypted\keys.json`.
6. Runs `decrypt_via_libtermius.js` under `Termius.exe` (Electron 21 as Node) to decrypt every `session-logs-v2\<uuid>.log` → `decrypted\<uuid>.txt`.
7. Deletes the temp snapshot.

The `localKey` is passed to Node via the `TERMIUS_LOCAL_KEY_B64` env var, never on the command line, so it does not appear in process listings.

## Options

```powershell
.\run_all.ps1 `
    -DataDir "$env:APPDATA\Termius" `
    -Out decrypted `
    -TermiusExe "C:\Path\To\Termius.exe" `
    -StopTimeoutSec 10 `
    -KeepSnapshot `
    -SkipRestart
```

- `-DataDir` — override Termius AppData root. Default: `%APPDATA%\Termius`.
- `-Out` — output dir (relative paths resolve against repo root). Default: `decrypted`.
- `-TermiusExe` — override Termius.exe path. Default: `%LOCALAPPDATA%\Programs\Termius\Termius.exe`.
- `-StopTimeoutSec` — how long to wait for the LevelDB `LOCK` to release.
- `-KeepSnapshot` — leave the temp snapshot on disk for debugging.
- `-SkipRestart` — don't restart Termius after snapshotting (handy if you want to keep the DB completely quiescent for repeat runs).

## Manual / step-by-step

If something fails and you want to run pieces individually:

```powershell
# 1. Get the key:
$key = .\get_local_key.ps1
$env:TERMIUS_LOCAL_KEY_B64 = $key

# 2. Snapshot manually (or point straight at %APPDATA%\Termius after closing Termius yourself):
$snap = "C:\temp\termius-snap"
Copy-Item -Recurse "$env:APPDATA\Termius\Local Storage" $snap
Copy-Item -Recurse "$env:APPDATA\Termius\IndexedDB" $snap

# 3. Extract keys:
node .\extract_keys.js --data-dir $snap `
    --logs-dir "$env:APPDATA\Termius\session-logs-v2" `
    --out decrypted

# 4. Decrypt logs:
.\run_helper.ps1 decrypted\keys.json `
    --logs-dir "$env:APPDATA\Termius\session-logs-v2" `
    --out decrypted
# Add --keep-blank-lines to suppress the prompt-blank-line cleanup (see Caveats).

# 5. Clean up:
Remove-Item Env:TERMIUS_LOCAL_KEY_B64
Remove-Item -Recurse $snap
```

Or with multiple log directories:

```powershell
.\run_helper.ps1 decrypted\keys.json `
  --logs-dir "C:\Users\<you>\AppData\Roaming\Termius\session-logs-v2" `
  --logs-dir "C:\path\to\extra\session-logs-v2"
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

| file                          | purpose |
|---|---|
| `run_all.ps1`                 | Orchestrator — stop Termius, snapshot LevelDB, run extractor + libtermius helper |
| `get_local_key.ps1`           | Capture-only wrapper around `dump_local_key.ps1` (emits bare base64 to stdout) |
| `dump_local_key.ps1`          | Reads `localKey` from Windows Credential Manager |
| `extract_keys.js`             | Node CLI — reads LevelDB snapshots, decrypts envelopes, writes `keys.json` |
| `decrypt_via_libtermius.js`   | Node helper — `.log` → `.txt` via libtermius LogReader |
| `run_helper.ps1`              | PowerShell launcher — runs the Node helper under Termius.exe (Electron 21) |
| `lib/leveldb_reader.js`       | Pure-JS LevelDB scanner (SST + WAL, snappy decompress, comparator-agnostic) |
| `lib/v8_ssv.js`               | V8 structured-clone decoder |
| `lib/termius_crypto.js`       | Secretbox envelope decrypt via `tweetnacl` |
| `lib/localstorage.js`         | Chromium Local Storage credential walker |
| `lib/vault.js`                | Chromium IndexedDB session-record walker |
| `package.json`                | `tweetnacl` + `snappyjs` |

## Layout expected in the working directory

```
.
├── %APPDATA%\Termius\                      # live Termius install (read-only)
│   ├── IndexedDB/file__0.indexeddb.leveldb/
│   ├── Local Storage/leveldb/
│   ├── session-logs-v2/*.log
│   └── ...
├── decrypted/                              # output (created on first run)
│   ├── keys.json
│   └── <uuid>.txt                          # after step 6
└── *.js *.ps1
```

## Caveats

- Termius is briefly stopped (~1-2 s for the snapshot copy) every run. If a session is mid-write, the WAL fragment may be truncated; the WAL parser tolerates this by skipping malformed batch entries.
- The pure-JS LevelDB reader handles snappy-compressed blocks, prefix compression, internal-key suffix stripping (deletion tombstones are skipped), and the WAL's 32 KiB record framing. It does **not** merge by sequence number — duplicates across SST + WAL are de-duplicated downstream by primary key (`session_log_data.local_id` for sessions; credential name for Local Storage), with WAL entries winning over older SST entries.
- **Recovery bonus:** the JS reader does not honor MANIFEST file-obsolescence or cross-file deletion tombstones, so it resurrects historical `session_log_data` records still living in older SST files even after Termius has nulled them post-upload. This finds extra `.log` files that a strictly merged view would treat as orphans.
- Logs are rendered through a minimal terminal emulator (`lib/terminal_render.js`) before being written to `.txt`, so command-line edits, history navigation, and shell autocomplete redraws collapse to their final displayed form (CR, BS, `ESC[K`, cursor-move CSI sequences applied; SGR colors and OSC title sequences stripped).
- By default the renderer also strips spurious blank lines that appear immediately before a shell-prompt line. Some devices (e.g. FortiGate / FortiOS) emit an extra `\r\n` between a command's output and the next prompt, which surfaces as a blank line in the `.txt`. The cleanup only touches blanks that precede a prompt-shaped line (line starts with non-whitespace and contains `#`, `$`, `>`, or `%` followed by space); blanks inside command output are preserved. Pass `--keep-blank-lines` to `decrypt_via_libtermius.js` (or `.\run_helper.ps1`) to disable the cleanup and get the raw stream.
- libtermius is bundled inside Termius itself, not redistributable. This repo contains no Termius code.
