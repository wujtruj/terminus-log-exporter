# Launch decrypt_via_libtermius.js under Termius's bundled Electron runtime.
#
# @termius/libtermius is built against Electron 21's Node ABI, so the system
# node.exe cannot load termius.node ("Module did not self-register"). Electron
# honors ELECTRON_RUN_AS_NODE=1 to run as a plain Node process with its own
# ABI - perfect for loading the matching native module.
#
# Usage:
#   .\run_helper.ps1 decrypted\keys.json
#   .\run_helper.ps1 decrypted\keys.json --logs-dir "C:\Users\<you>\AppData\Roaming\Termius\session-logs-v2"
#   .\run_helper.ps1 -TermiusExe "<full path to Termius.exe>" decrypted\keys.json
#
# Everything except -TermiusExe / --termius-exe is forwarded verbatim to
# decrypt_via_libtermius.js. (No param() block on purpose - using $args
# directly avoids PowerShell's positional-binding quirks.)

$TermiusExe = $null
$ForwardedArgs = @()
for ($i = 0; $i -lt $args.Count; $i++) {
    switch -CaseSensitive ($args[$i]) {
        '-TermiusExe'   { $TermiusExe = $args[++$i] }
        '--termius-exe' { $TermiusExe = $args[++$i] }
        default         { $ForwardedArgs += $args[$i] }
    }
}

if (-not $TermiusExe) {
    $TermiusExe = Join-Path $env:LOCALAPPDATA 'Programs\Termius\Termius.exe'
}
if (-not (Test-Path -LiteralPath $TermiusExe)) {
    Write-Error "Termius.exe not found at: $TermiusExe`nPass -TermiusExe <path> if Termius is installed elsewhere."
    exit 2
}
if (-not ($TermiusExe -like '*Termius.exe')) {
    Write-Error "Resolved -TermiusExe does not look like Termius.exe: $TermiusExe"
    exit 2
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HelperJs  = Join-Path $ScriptDir 'decrypt_via_libtermius.js'
if (-not (Test-Path -LiteralPath $HelperJs)) {
    Write-Error "decrypt_via_libtermius.js not found next to this script: $HelperJs"
    exit 2
}

$env:ELECTRON_RUN_AS_NODE = '1'
Write-Host "ELECTRON_RUN_AS_NODE=1; launching:"
Write-Host "  Termius.exe : $TermiusExe"
Write-Host "  helper.js   : $HelperJs"
Write-Host "  args        : $($ForwardedArgs -join ' ')"

& $TermiusExe $HelperJs @ForwardedArgs
exit $LASTEXITCODE
