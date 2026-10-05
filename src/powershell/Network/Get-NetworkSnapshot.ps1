#requires -Version 5.1
# Prints one JSON snapshot of the local network state. Read-only: no packet capture, no changes, no internet access.
[CmdletBinding()]
param()
. "$PSScriptRoot\..\Common\Load.ps1"
Import-Module (Join-Path $PSScriptRoot 'Guard.psm1') -Force -DisableNameChecking
Start-RunContext -RunType 'user'
try { Get-NetworkSnapshot | ConvertTo-Json -Depth 8 -Compress }
catch { @{ error = $_.Exception.Message; generatedAt = (Get-IsoNow); connections = @(); udp = @(); processes = @{}; dns = @(); firewall = @{ profiles = @(); rules = @() }; identity = @{ gateway = @(); dns = @(); dhcp = @() }; errors = @($_.Exception.Message) } | ConvertTo-Json -Depth 4 -Compress; exit 1 }
