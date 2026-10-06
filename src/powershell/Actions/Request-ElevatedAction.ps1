#requires -Version 5.1
<#
.SYNOPSIS  Asks Windows (UAC) to run ONE allowlisted catalog action elevated. Never opens a general elevated shell.
.NOTES     Only actions whose catalog entry needs administrator rights are accepted. The elevated process runs
           Invoke-GuardianAction.ps1 with the same fixed parameters, re-validates the live target itself, and writes its result
           to data\state\action-results\<ticket>.json. Declining the prompt changes nothing.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z]+(\.[a-z\-]+)+$')][string]$Action,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9+/=]{0,8000}$')][string]$ParamsB64,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{32}$')][string]$Ticket
)
. "$PSScriptRoot\..\Common\Load.ps1"
Import-Module (Join-Path $PSScriptRoot 'Remediation.psm1') -Force -DisableNameChecking
Start-RunContext -RunType 'user'
function Out-Json($o) { $o | ConvertTo-Json -Compress -Depth 4 }
$spec = Get-ActionSpec -Id $Action
if (-not $spec) { Out-Json @{ ok = $false; requested = $false; message = "'$Action' is not an allowlisted action." }; exit 1 }
if ($spec.admin -eq $false) { Out-Json @{ ok = $false; requested = $false; message = 'This action does not need administrator permission.' }; exit 1 }
# The UAC prompt would start code from this folder as administrator. If anything ordinary programs can edit sits in that path, say so and stop.
try { Assert-ElevatedCodeTrusted -WillElevate } catch { Out-Json @{ ok = $false; requested = $false; message = $_.Exception.Message }; exit 1 }
$entry = Join-Path $PSScriptRoot 'Invoke-GuardianAction.ps1'
$argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$entry`"", '-Action', $Action, '-Mode', 'Execute', '-ParamsB64', $ParamsB64, '-Ticket', $Ticket)
try {
    Start-Process -FilePath (Get-SystemPowerShellPath) -ArgumentList $argList -Verb RunAs -WindowStyle Hidden | Out-Null
    [void](Write-GuardianEvent -Category remediation -Action "remediation:elevation-requested" -Target $Action -Actor user -Reason 'UAC prompt shown for one allowlisted action' -Data ([ordered]@{ ticket = $Ticket }))
    Out-Json @{ ok = $true; requested = $true; message = 'Windows is asking for administrator permission. Approve it to continue.' }
} catch {
    [void](Write-GuardianEvent -Category remediation -Action "remediation:elevation-requested" -Target $Action -Actor user -Result failure -Severity warning -ErrorDetails $_.Exception.Message)
    Out-Json @{ ok = $false; requested = $false; message = 'Administrator permission was not granted, so nothing was changed.' }
    exit 1
}
