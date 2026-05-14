# Run this on the Windows jumpbox where Termius is installed.
# It reads the "localKey" credential that Termius stored via keytar
# (Windows Credential Manager) and prints it as base64.
#
#   PS C:\> .\dump_local_key.ps1
#
# Copy the printed base64 string to the Mac and pass to:
#   python3 decrypt_termius_logs.py --local-key-b64 <string>
#
# The localKey is a 32-byte libsodium secretbox key. Nothing else is needed
# from the Windows machine — every other secret lives in the AppData you
# already copied.

if (-not ([System.Management.Automation.PSTypeName]'Win32.Credman').Type) {
    Add-Type -Namespace Win32 -Name Credman -MemberDefinition @"
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
}
[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool CredRead(string target, uint type, uint reserved, out IntPtr credentialPtr);
[DllImport("advapi32.dll")]
public static extern void CredFree(IntPtr ptr);
"@
}

function Get-TermiusLocalKey {
    param([string]$Target)
    $ptr = [IntPtr]::Zero
    if (-not [Win32.Credman]::CredRead($Target, 1, 0, [ref]$ptr)) {
        return $null
    }
    try {
        $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][Win32.Credman+CREDENTIAL])
        $bytes = New-Object byte[] $cred.CredentialBlobSize
        [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
        # @termius/keytar stores the credential as UTF-8 bytes (the stored string is
        # already base64 of the 32-byte key, so we just print it).
        return [System.Text.Encoding]::UTF8.GetString($bytes)
    } finally {
        [Win32.Credman]::CredFree($ptr)
    }
}

# keytar service name = Electron exe base name. For Termius this is "Termius".
# App Store builds use "Termius (MAS)" — adjust if needed.
$candidates = @("Termius/localKey", "Termius (MAS)/localKey")
foreach ($target in $candidates) {
    $val = Get-TermiusLocalKey -Target $target
    if ($val) {
        Write-Host "Found credential for: $target"
        Write-Host "localKey (base64): $val"
        exit 0
    }
}
Write-Error "Could not read Termius localKey from Windows Credential Manager."
Write-Error "Open 'Credential Manager' -> 'Windows Credentials' and look for entries starting with 'Termius'."
exit 1
