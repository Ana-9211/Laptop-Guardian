#requires -Version 5.1
# Sends ONE file to the Recycle Bin (never permanent deletion). Called by the bridge after user confirmation.
param([Parameter(Mandatory)][string]$Path)
. "$PSScriptRoot\..\Common\Load.ps1"
Start-RunContext -RunType 'user'
function Out-Result($ok, $msg) { (@{ ok = $ok; success = $ok; message = $msg; error = $(if ($ok) { $null } else { $msg }) } | ConvertTo-Json -Compress); exit $(if ($ok) { 0 } else { 1 }) }
try {
    $cfg = Get-GuardianConfig
    $files = Read-JsonFile -Path (Get-GuardianPath 'LatestFiles') -Default $null
    $cand = $null
    if ($files) { $cand = @($files.candidates | Where-Object { $_.path -ieq $Path } | Select-Object -First 1)[0] }
    if (-not $cand) { throw 'File is not in the latest Guardian recommendations; refusing.' }
    if ($cand.classification -in 'KEEP', 'HIGH_RISK', 'UNKNOWN') { throw "Classified $($cand.classification): Guardian will not recycle it. Delete it yourself in Explorer if you are sure." }
    $fi = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ([math]::Abs(($fi.LastWriteTime - [datetime]$cand.lastModified).TotalSeconds) -gt 2) { throw 'File changed since it was analysed; re-scan first.' }
    if ((Test-PathHasReparse -Path (Split-Path -Parent $Path))) { throw 'Path passes through a junction/symlink; refusing.' }
    [void](Move-ToRecycleBin -Path $Path -ProtectedDirs @($cfg.storage.protectedDirs))
    [void](Write-GuardianEvent -Category file -Action 'file:recycled' -Target $Path -Actor user -Reason 'Moved to Recycle Bin (user confirmed in dashboard)')
    Out-Result $true 'Moved to Recycle Bin'
} catch {
    [void](Write-GuardianEvent -Category file -Action 'file:recycle' -Target $Path -Result failure -Severity warning -Actor user -ErrorDetails $_.Exception.Message)
    Out-Result $false $_.Exception.Message
}
