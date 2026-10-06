#requires -Version 5.1
<# Creates the data folders and the default settings for THIS copy of Laptop Guardian (the installed copy when run from there).
   Existing files are kept. The installer runs it from the installed program folder so the paths come from install.json. #>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\Common\Load.ps1"
$root = Get-GuardianDataRoot
foreach ($d in 'config', 'data\history', 'data\recommendations', 'data\actions', 'data\processes', 'data\metrics', 'data\state', 'data\latest', 'data\secrets', 'reports\daily', 'reports\weekly', 'logs') {
    New-Item -ItemType Directory -Path (Join-Path $root $d) -Force | Out-Null
}
try { $mySid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; & "$env:SystemRoot\System32\icacls.exe" (Join-Path $root 'data\secrets') /inheritance:r /grant:r "*${mySid}:(OI)(CI)F" 2>&1 | Out-Null } catch { }
$made = New-Object System.Collections.ArrayList
if (-not (Test-Path -LiteralPath (Join-Path $root 'config\config.json'))) { Save-GuardianConfig -Config (Get-DefaultConfig); [void]$made.Add('config.json (Safe Mode on)') }
if (-not (Test-Path -LiteralPath (Join-Path $root 'config\process-policy.json'))) { Write-JsonFile -Path (Join-Path $root 'config\process-policy.json') -Object ([ordered]@{ blacklist = @(); whitelist = @(); ignored = @() }); [void]$made.Add('process-policy.json') }
if (-not (Test-Path -LiteralPath (Join-Path $root 'config\cleanup-policy.json'))) { Write-JsonFile -Path (Join-Path $root 'config\cleanup-policy.json') -Object ([ordered]@{}); [void]$made.Add('cleanup-policy.json') }
[pscustomobject]@{ ok = $true; dataRoot = $root; created = @($made) } | ConvertTo-Json -Compress
