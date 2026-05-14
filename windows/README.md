# Windows-only quick start

Run the whole pipeline on the Windows jumpbox where Termius is installed.
No need to copy the Termius AppData to a Mac.

## Prerequisites

- Termius for Windows installed (any modern version that ships
  `@termius/libtermius`).
- Node.js 20+ x64. The official `.zip` works (no admin, no MSI prompts).
  Extract it anywhere and add the directory to `PATH`, or pass `node.exe`
  via PATH for this session: `$env:PATH = "C:\node-v20\;$env:PATH"`.
- PowerShell 5.1 (built-in) or PowerShell 7.

If the jumpbox is locked-down (no script execution by default):

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

…or invoke each `.ps1` via `powershell -ExecutionPolicy Bypass -File <script>`.

## One-time install

```powershell
cd <repo>\windows
npm install
```

This pulls `tweetnacl` and `snappyjs` (pure JS, no native compile).

For an **offline jumpbox** (no npm access), vendor `windows\node_modules\`
from another machine:

```powershell
# On a machine with internet:
cd <repo>\windows
npm install
Compress-Archive node_modules node_modules.zip

# On the jumpbox:
Expand-Archive node_modules.zip <repo>\windows\
```

## Run

```powershell
cd <repo>
.\windows\run_all.ps1
```

This does, in order:

1. Stops Termius (graceful close, then `Stop-Process -Force`, then waits for
   the LevelDB `LOCK` file to be releasable).
2. Snapshots `%APPDATA%\Termius\Local Storage\leveldb` and
   `%APPDATA%\Termius\IndexedDB\file__0.indexeddb.leveldb` to a temp dir.
3. Starts Termius again — your sessions resume after ~1-2 s of downtime.
4. Reads `localKey` from Windows Credential Manager
   (`get_local_key.ps1` -> `dump_local_key.ps1`).
5. Runs `extract_keys.js` against the snapshot, writes `decrypted\keys.json`
   (same schema as the macOS Python tool's output).
6. Runs `decrypt_via_libtermius.js` under `Termius.exe` (Electron 21 as Node)
   to decrypt every `session-logs-v2\<uuid>.log` -> `decrypted\<uuid>.txt`.
7. Deletes the temp snapshot.

The `localKey` is passed to Node via the `TERMIUS_LOCAL_KEY_B64` env var,
never on the command line, so it does not appear in process listings.

## Options

```powershell
.\windows\run_all.ps1 `
    -DataDir "$env:APPDATA\Termius" `
    -Out decrypted `
    -TermiusExe "C:\Path\To\Termius.exe" `
    -StopTimeoutSec 10 `
    -KeepSnapshot `
    -SkipRestart
```

- `-DataDir` — override Termius AppData root. Default: `%APPDATA%\Termius`.
- `-Out` — output dir (relative paths resolve against repo root). Default:
  `decrypted`.
- `-TermiusExe` — override Termius.exe path. Default:
  `%LOCALAPPDATA%\Programs\Termius\Termius.exe`.
- `-StopTimeoutSec` — how long to wait for the LevelDB `LOCK` to release.
- `-KeepSnapshot` — leave the temp snapshot on disk for debugging.
- `-SkipRestart` — don't restart Termius after snapshotting (handy if you
  want to keep the DB completely quiescent for repeat runs).

## Components

| file | purpose |
|---|---|
| `run_all.ps1` | Orchestrator (stop -> snapshot -> start -> extract -> decrypt). |
| `get_local_key.ps1` | Captures `dump_local_key.ps1`'s `Write-Host` stream and emits only the bare base64 key. |
| `extract_keys.js` | Reads LevelDB snapshots, decrypts envelopes, writes `keys.json`. |
| `lib/leveldb_reader.js` | Pure-JS read-only LevelDB scanner (SST + WAL, snappy decompress). |
| `lib/v8_ssv.js` | V8 structured-clone decoder (port of `inspect_v8.py`). |
| `lib/termius_crypto.js` | Secretbox envelope decrypt via `tweetnacl`. |
| `lib/localstorage.js` | Walk Chromium Local Storage for Termius credentials. |
| `lib/vault.js` | Walk Chromium IndexedDB for `session_log_data` records. |
| `package.json` | `tweetnacl` + `snappyjs`. |

## Manual / step-by-step

If something fails and you want to run pieces individually:

```powershell
# 1. Get the key:
$key = .\windows\get_local_key.ps1
$env:TERMIUS_LOCAL_KEY_B64 = $key

# 2. Snapshot manually (or point straight at %APPDATA%\Termius after
#    closing Termius yourself):
$snap = "C:\temp\termius-snap"
Copy-Item -Recurse "$env:APPDATA\Termius\Local Storage" $snap
Copy-Item -Recurse "$env:APPDATA\Termius\IndexedDB" $snap

# 3. Extract keys:
node .\windows\extract_keys.js --data-dir $snap `
    --logs-dir "$env:APPDATA\Termius\session-logs-v2" `
    --out decrypted

# 4. Decrypt logs:
.\run_helper.ps1 decrypted\keys.json `
    --logs-dir "$env:APPDATA\Termius\session-logs-v2" `
    --out decrypted

# 5. Clean up:
Remove-Item Env:TERMIUS_LOCAL_KEY_B64
Remove-Item -Recurse $snap
```

## Caveats

- Termius is briefly stopped (~1-2 s for the snapshot copy) every run. If a
  session is mid-write, the WAL fragment may be truncated; the WAL parser
  tolerates this by skipping malformed batch entries.
- The pure-JS LevelDB reader handles snappy-compressed blocks, prefix
  compression, internal-key suffix stripping (deletion tombstones are
  skipped), and the WAL's 32 KiB record framing. It does **not** merge by
  sequence number — duplicates across SST + WAL are de-duplicated downstream
  by primary key (`session_log_data.local_id` for sessions; credential name
  for Local Storage), with WAL entries winning over older SST entries.
- **Recovery bonus vs the Python tool:** the JS reader does not honor
  MANIFEST file-obsolescence or cross-file deletion tombstones, so it
  resurrects historical `session_log_data` records still living in older
  SST files even after Termius has nulled them post-upload. Empirically
  this finds extra `.log` files the Python tool treats as orphans. Treat
  this as a feature for the recovery use case, but note it if you ever
  diff `keys.json` between the two pipelines.
- The Mac/Python pipeline (`decrypt_termius_logs.py` + friends) still works
  unchanged; see the repo-root README for that flow.
