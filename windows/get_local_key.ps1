# Wrapper around dump_local_key.ps1 (repo root) that emits ONLY the bare
# base64 localKey to stdout. The original script uses Write-Host (information
# stream), which $key = .\dump_local_key.ps1 cannot capture on PowerShell 5.1
# — the Windows default. This wrapper captures all streams via *>&1 and
# extracts the key with a regex.
#
# Exit codes:
#   0 — key written to stdout
#   1 — could not extract key (original script failed or output unexpected)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$DumpScript = Join-Path $RepoRoot 'dump_local_key.ps1'

if (-not (Test-Path -LiteralPath $DumpScript)) {
    Write-Error "dump_local_key.ps1 not found at: $DumpScript"
    exit 1
}

$raw = & $DumpScript *>&1 | Out-String
$dumpExit = $LASTEXITCODE

if ($raw -match 'localKey \(base64\):\s*(\S+)') {
    Write-Output $Matches[1]
    exit 0
}

Write-Error "Could not parse localKey from dump_local_key.ps1 output (exit=$dumpExit):"
Write-Error $raw
exit 1
