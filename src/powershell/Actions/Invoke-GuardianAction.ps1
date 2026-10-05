#requires -Version 5.1
<#
.SYNOPSIS  The single entry point for every Guardian remediation. Runs one allowlisted catalog action (validate or execute).
.NOTES     Parameters arrive as base64 JSON and are validated against src/shared/action-catalog.json before anything happens.
           Execute always re-validates the live target first, refuses protected targets, verifies the outcome, and appends an audit
           event. When -Ticket is given (elevated runs launched through Request-ElevatedAction.ps1) the result is also written to
           data\state\action-results\<ticket>.json so the dashboard can read it. There is no parameter that accepts a command.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z]+(\.[a-z\-]+)+$')][string]$Action,
    [ValidateSet('Validate', 'Execute')][string]$Mode = 'Validate',
    [ValidatePattern('^[A-Za-z0-9+/=]{0,8000}$')][string]$ParamsB64 = '',
    [ValidatePattern('^([0-9a-f]{32})?$')][string]$Ticket = ''
)
. "$PSScriptRoot\..\Common\Load.ps1"
Import-Module (Join-Path $PSScriptRoot 'Remediation.psm1') -Force -DisableNameChecking
Start-RunContext -RunType 'user'

function ConvertTo-Hashtable {
    param($Obj)
    $h = @{}
    if ($null -eq $Obj) { return $h }
    foreach ($p in $Obj.PSObject.Properties) { $h[$p.Name] = $p.Value }
    return $h
}

$result = $null
$runningMarker = $null
if ($Ticket -and $Mode -eq 'Execute') {
    # Lets the dashboard tell "permission granted, still working" from "prompt never answered".
    try { $d0 = Join-Path (Split-Path (Get-GuardianPath 'RunState')) 'action-results'; if (-not (Test-Path -LiteralPath $d0)) { New-Item -ItemType Directory -Path $d0 -Force | Out-Null }; $runningMarker = Join-Path $d0 "$Ticket.running.json"; Write-JsonFile -Path $runningMarker -Object @{ startedAt = (Get-IsoNow); action = $Action } } catch { }
}
try {
    $params = @{}
    if ($ParamsB64) {
        $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ParamsB64))
        $params = ConvertTo-Hashtable (ConvertFrom-Json $json)
    }
    $result = Invoke-GuardianRemediation -Action $Action -Mode $Mode -Params $params
} catch {
    $result = [pscustomobject]@{ ok = $false; action = $Action; mode = $Mode; message = ''; errors = @($_.Exception.Message); needsAdmin = $false; needsElevation = $false; identityKey = ''; verified = $false; details = $null; undo = $null }
}

function Get-ActionSubject {
    # Canonical identity of what an action changed, so an undo (whose params differ) can be matched to the original.
    param([string]$Action, $P, $Res)
    function V($k) { if ($P -and $P.ContainsKey($k)) { [string]$P[$k] } else { '' } }
    switch -Wildcard ($Action) {
        'firewall.block-*' { $n = $null; try { $n = $Res.details.ruleName } catch { }; if ($n) { return "fw:$n" }; return $null }
        'firewall.allow-*' { $n = $null; try { $n = $Res.details.ruleName } catch { }; if ($n) { return "fw:$n" }; return $null }
        'firewall.remove-rule' { return "fw:$(V 'name')" }
        'firewall.enable-rule' { return "fw:$(V 'name')" }
        'firewall.disable-rule' { return "fw:$(V 'name')" }
        'service.*' { return "service:$(V 'name')" }
        'startup.*' { return "startup:$(V 'kind')|$(V 'name')|$(V 'location')" }
        'task.*' { return "task:$(V 'taskPath')$(V 'taskName')" }
        'dns.block-domain' { return "dns:$(V 'domain')" }
        'dns.unblock-domain' { return "dns:$(V 'domain')" }
        'deep.dnslog-*' { return 'dnslog' }
        default { return $null }
    }
}

if ($Mode -eq 'Execute') {
    # Audit trail: one event per attempt, whatever the outcome. Details carry verification and the undo recipe.
    $first = if (@($result.errors).Count) { @($result.errors)[0] } else { $null }
    $target = if ($params -and $params.Count) { (($params.GetEnumerator() | Where-Object { $_.Key -notlike '_*' } | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join '; ') } else { $null }
    $res = if ($result.ok) { 'success' } elseif ($result.needsElevation) { 'skipped' } else { 'failure' }
    $reason = if ($result.message) { $result.message } else { $first }
    [void](Write-GuardianEvent -Category remediation -Action "remediation:$Action" -Target $target -Result $res -Actor user -Severity $(if ($result.ok) { 'info' } else { 'warning' }) -Reason $reason -ErrorDetails $(if (-not $result.ok) { $first } else { $null }) -Data ([ordered]@{ subject = (Get-ActionSubject -Action $Action -P $params -Res $result); verified = [bool]$result.verified; needsElevation = [bool]$result.needsElevation; details = $result.details; undo = $result.undo; elevated = (Test-IsAdmin); ticket = $Ticket }))
}

if ($Ticket) {
    try {
        $dir = Join-Path (Split-Path (Get-GuardianPath 'RunState')) 'action-results'
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Write-JsonFile -Path (Join-Path $dir "$Ticket.json") -Object $result
    } catch {
        # Without this file the dashboard cannot learn the outcome, so say so in the audit trail instead of going silent.
        [void](Write-GuardianEvent -Category remediation -Action "remediation:result-not-saved" -Target $Action -Result failure -Severity warning -ErrorDetails $_.Exception.Message)
    }
    if ($runningMarker) { Remove-Item -LiteralPath $runningMarker -Force -ErrorAction SilentlyContinue }
}
$result | ConvertTo-Json -Depth 6 -Compress
exit $(if ($result.ok) { 0 } else { 1 })
