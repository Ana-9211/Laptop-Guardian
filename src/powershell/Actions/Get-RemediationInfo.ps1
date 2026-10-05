#requires -Version 5.1
# Read-only facts the Action Center needs: the installed-programs list and the state of the Revo Uninstaller shortcut.
[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('apps', 'revo')][string]$Topic)
. "$PSScriptRoot\..\Common\Load.ps1"
Import-Module (Join-Path $PSScriptRoot 'Remediation.psm1') -Force -DisableNameChecking
Start-RunContext -RunType 'user'
try {
    if ($Topic -eq 'apps') { @{ ok = $true; apps = @(Get-InstalledPrograms) } | ConvertTo-Json -Depth 4 -Compress }
    else { @{ ok = $true; revo = (Get-RevoInfo) } | ConvertTo-Json -Depth 4 -Compress }
} catch { @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress; exit 1 }
