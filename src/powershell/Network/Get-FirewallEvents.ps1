#requires -Version 5.1
# Prints recent Windows Filtering Platform events (allowed and blocked connections) as JSON. Read-only.
[CmdletBinding()]
param([int]$Max = 500, [int]$Hours = 24)
. "$PSScriptRoot\..\Common\Load.ps1"
Import-Module (Join-Path $PSScriptRoot 'WfpEvents.psm1') -Force -DisableNameChecking
Start-RunContext -RunType 'user'
try { Get-WfpEvents -Max $Max -Hours $Hours | ConvertTo-Json -Depth 6 -Compress }
catch { @{ available = $false; reason = $_.Exception.Message; items = @() } | ConvertTo-Json -Compress }
