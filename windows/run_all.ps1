# Windows-native end-to-end runner for terminus-log-converter.
#
# Pipeline:
#   1. Stop Termius (graceful, then force).
#   2. Snapshot %APPDATA%\Termius\Local Storage and IndexedDB to a tempdir.
#   3. Start Termius again (your sessions resume).
#   4. Read localKey from Credential Manager (via get_local_key.ps1).
#   5. Run extract_keys.js against the snapshot -> decrypted\keys.json.
#   6. Run decrypt_via_libtermius.js (via run_helper.ps1) against the LIVE
#      %APPDATA%\Termius\session-logs-v2\ to write decrypted\<uuid>.txt.
#   7. Delete the snapshot on success.
#
# Usage:
#   .\windows\run_all.ps1
#   .\windows\run_all.ps1 -DataDir "$env:APPDATA\Termius" -Out decrypted
#   .\windows\run_all.ps1 -TermiusExe "<full path to Termius.exe>"

[CmdletBinding()]
param(
    [string] $DataDir,
    [string] $Out = "decrypted",
    [string] $TermiusExe,
    [int]    $StopTimeoutSec = 10,
    [switch] $KeepSnapshot,
    [switch] $SkipRestart
)

$ErrorActionPreference = 'Stop'
$SCRIPT_VERSION = '2026-05-13.v1'
Write-Host "run_all.ps1 $SCRIPT_VERSION"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir

if (-not $DataDir) { $DataDir = Join-Path $env:APPDATA 'Termius' }
if (-not $TermiusExe) { $TermiusExe = Join-Path $env:LOCALAPPDATA 'Programs\Termius\Termius.exe' }

if (-not (Test-Path -LiteralPath $DataDir)) {
    Write-Error "Termius AppData not found: $DataDir"
    exit 2
}
if (-not (Test-Path -LiteralPath $TermiusExe)) {
    Write-Error "Termius.exe not found: $TermiusExe (pass -TermiusExe <path>)"
    exit 2
}

$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue)?.Source
if (-not $nodeExe) {
    Write-Error "node.exe not found on PATH. Install Node.js 20+ x64 (standalone zip is fine) and add it to PATH."
    exit 2
}

$ExtractJs = Join-Path $ScriptDir 'extract_keys.js'
$GetKey    = Join-Path $ScriptDir 'get_local_key.ps1'
$RunHelper = Join-Path $RepoRoot  'run_helper.ps1'
foreach ($p in @($ExtractJs, $GetKey, $RunHelper)) {
    if (-not (Test-Path -LiteralPath $p)) {
        Write-Error "missing required script: $p"
        exit 2
    }
}

# Ensure deps are installed.
$NodeModules = Join-Path $ScriptDir 'node_modules'
if (-not (Test-Path -LiteralPath $NodeModules)) {
    Push-Location $ScriptDir
    try {
        Write-Host "Installing Node deps (one-time)..."
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            Write-Error "npm install failed. If the jumpbox has no internet, vendor windows\node_modules\ from another machine."
            exit 2
        }
    } finally {
        Pop-Location
    }
}

# --- Step 1: Stop Termius ---
function Stop-Termius {
    $procs = Get-Process -Name Termius -ErrorAction SilentlyContinue
    if (-not $procs) { Write-Host "Termius is not running."; return }
    Write-Host "Stopping Termius ($($procs.Count) processes)..."
    foreach ($p in $procs) {
        try { [void]$p.CloseMainWindow() } catch {}
    }
    try { Wait-Process -Name Termius -Timeout 5 -ErrorAction SilentlyContinue } catch {}
    $procs = Get-Process -Name Termius -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Host "Graceful close timed out; force-stopping..."
        Stop-Process -Name Termius -Force -ErrorAction SilentlyContinue
        try { Wait-Process -Name Termius -Timeout 5 -ErrorAction SilentlyContinue } catch {}
    }

    # Poll LOCK files until releasable (Chromium holds an OS-level fcntl lock).
    $lockFiles = @(
        Join-Path $DataDir 'IndexedDB\file__0.indexeddb.leveldb\LOCK',
        Join-Path $DataDir 'Local Storage\leveldb\LOCK'
    )
    $deadline = (Get-Date).AddSeconds($StopTimeoutSec)
    foreach ($lock in $lockFiles) {
        if (-not (Test-Path -LiteralPath $lock)) { continue }
        while ((Get-Date) -lt $deadline) {
            try {
                $fs = [System.IO.File]::Open($lock, 'Open', 'ReadWrite', 'None')
                $fs.Close()
                break
            } catch {
                Start-Sleep -Milliseconds 250
            }
        }
    }
}

Stop-Termius

# --- Step 2: Snapshot ---
$Snapshot = Join-Path $env:TEMP ("termius-snapshot-" + [Guid]::NewGuid().ToString('N').Substring(0,8))
Write-Host "Snapshotting LevelDB dirs -> $Snapshot"
New-Item -ItemType Directory -Path $Snapshot | Out-Null
$snapLs  = Join-Path $Snapshot 'Local Storage\leveldb'
$snapIdb = Join-Path $Snapshot 'IndexedDB\file__0.indexeddb.leveldb'
New-Item -ItemType Directory -Path (Split-Path $snapLs)  | Out-Null
New-Item -ItemType Directory -Path (Split-Path $snapIdb) | Out-Null
Copy-Item -Recurse -Force -LiteralPath (Join-Path $DataDir 'Local Storage\leveldb') -Destination (Split-Path $snapLs)
Copy-Item -Recurse -Force -LiteralPath (Join-Path $DataDir 'IndexedDB\file__0.indexeddb.leveldb') -Destination (Split-Path $snapIdb)

# Symlink session-logs-v2 directly to the live dir (we only read .log files,
# they aren't locked at the file level).
$snapLogs = Join-Path $Snapshot 'session-logs-v2'
$liveLogs = Join-Path $DataDir 'session-logs-v2'
if (-not (Test-Path -LiteralPath $liveLogs)) {
    Write-Error "session-logs-v2 not found at: $liveLogs"
    exit 2
}

# --- Step 3: Start Termius again (unless suppressed) ---
if (-not $SkipRestart) {
    Write-Host "Starting Termius again..."
    Start-Process -FilePath $TermiusExe | Out-Null
}

# --- Step 4: Get localKey ---
Write-Host "Reading localKey from Credential Manager..."
$key = (& $GetKey).Trim()
if (-not $key -or $LASTEXITCODE -ne 0) {
    Write-Error "Could not obtain localKey."
    if (-not $KeepSnapshot) { Remove-Item -Recurse -Force $Snapshot -ErrorAction SilentlyContinue }
    exit 3
}

# --- Step 5: Extract keys ---
$OutAbs = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $RepoRoot $Out }
New-Item -ItemType Directory -Force -Path $OutAbs | Out-Null
Write-Host "Extracting keys to $OutAbs\keys.json ..."
$env:TERMIUS_LOCAL_KEY_B64 = $key
try {
    & $nodeExe $ExtractJs --data-dir $Snapshot --logs-dir $liveLogs --out $OutAbs
    $extractExit = $LASTEXITCODE
} finally {
    Remove-Item Env:TERMIUS_LOCAL_KEY_B64 -ErrorAction SilentlyContinue
}
if ($extractExit -ne 0) {
    Write-Error "extract_keys.js failed (exit $extractExit)."
    if (-not $KeepSnapshot) { Remove-Item -Recurse -Force $Snapshot -ErrorAction SilentlyContinue }
    exit $extractExit
}

# --- Step 6: Decrypt logs via libtermius ---
$KeysJson = Join-Path $OutAbs 'keys.json'
Write-Host "Decrypting session logs via libtermius..."
& $RunHelper $KeysJson --logs-dir $liveLogs --out $OutAbs -TermiusExe $TermiusExe
$helperExit = $LASTEXITCODE

# --- Step 7: Cleanup ---
if (-not $KeepSnapshot) {
    Remove-Item -Recurse -Force $Snapshot -ErrorAction SilentlyContinue
} else {
    Write-Host "Snapshot retained at: $Snapshot"
}

if ($helperExit -ne 0) {
    Write-Error "decrypt_via_libtermius.js exited with $helperExit."
    exit $helperExit
}

Write-Host "Done. Output: $OutAbs"
exit 0
