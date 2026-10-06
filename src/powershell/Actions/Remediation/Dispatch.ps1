# Action id to handler table, and the single entry point.
# Dot-sourced by Actions\Remediation.psm1 (same module scope, so Pester mocks and exports are unchanged).
# ---------- dispatcher ----------
function Get-RemediationHandler {
    param([string]$Id)
    switch ($Id) {
        'process.stop' { return @{ V = { param($p) Test-ProcessStop $p }; E = { param($p, $v) Invoke-ProcessStop $p $v } } }
        'startup.disable' { return @{ V = { param($p) Test-StartupChange $p $false }; E = { param($p, $v) Invoke-StartupChange $p $v $false } } }
        'startup.enable' { return @{ V = { param($p) Test-StartupChange $p $true }; E = { param($p, $v) Invoke-StartupChange $p $v $true } } }
        'task.disable' { return @{ V = { param($p) Test-TaskChange $p $false }; E = { param($p, $v) Invoke-TaskChange $p $v $false } } }
        'task.enable' { return @{ V = { param($p) Test-TaskChange $p $true }; E = { param($p, $v) Invoke-TaskChange $p $v $true } } }
        'service.disable' { return @{ V = { param($p) Test-ServiceChange $p $false }; E = { param($p, $v) Invoke-ServiceChange $p $v $false } } }
        'service.enable' { return @{ V = { param($p) Test-ServiceChange $p $true }; E = { param($p, $v) Invoke-ServiceChange $p $v $true } } }
        'file.recycle' { return @{ V = { param($p) Test-FileRecycle $p }; E = { param($p, $v) Invoke-FileRecycle $p $v } } }
        'defender.update-signatures' { return @{ V = { param($p) Test-DefenderUpdate }; E = { param($p, $v) Invoke-DefenderUpdate } } }
        'defender.quick-scan' { return @{ V = { param($p) Test-DefenderQuickScan }; E = { param($p, $v) Invoke-DefenderQuickScan } } }
        'system.integrity-check' { return @{ V = { param($p) Test-IntegrityCheck }; E = { param($p, $v) Invoke-IntegrityCheck } } }
        'firewall.enable-profile' { return @{ V = { param($p) Test-FirewallEnable $p }; E = { param($p, $v) Invoke-FirewallEnable $p } } }
        'dns.flush' { return @{ V = { param($p) Test-DnsFlush }; E = { param($p, $v) Invoke-DnsFlush } } }
        'app.revo-launch' { return @{ V = { param($p) Test-RevoLaunch $p }; E = { param($p, $v) Invoke-RevoLaunch $p $v } } }
        'firewall.block-program' { return @{ V = { param($p) Test-FirewallCreate $p 'block-program' }; E = { param($p, $v) Invoke-FirewallCreate $p 'block-program' } } }
        'firewall.allow-program' { return @{ V = { param($p) Test-FirewallCreate $p 'allow-program' }; E = { param($p, $v) Invoke-FirewallCreate $p 'allow-program' } } }
        'firewall.block-port' { return @{ V = { param($p) Test-FirewallCreate $p 'block-port' }; E = { param($p, $v) Invoke-FirewallCreate $p 'block-port' } } }
        'firewall.block-remote' { return @{ V = { param($p) Test-FirewallCreate $p 'block-remote' }; E = { param($p, $v) Invoke-FirewallCreate $p 'block-remote' } } }
        'firewall.remove-rule' { return @{ V = { param($p) Test-FirewallManage $p 'remove' }; E = { param($p, $v) Invoke-FirewallManage $p 'remove' } } }
        'firewall.disable-rule' { return @{ V = { param($p) Test-FirewallManage $p 'disable' }; E = { param($p, $v) Invoke-FirewallManage $p 'disable' } } }
        'firewall.enable-rule' { return @{ V = { param($p) Test-FirewallManage $p 'enable' }; E = { param($p, $v) Invoke-FirewallManage $p 'enable' } } }
        'dns.block-domain' { return @{ V = { param($p) Test-DnsBlock $p 'block' }; E = { param($p, $v) Invoke-DnsBlock $p 'block' } } }
        'dns.unblock-domain' { return @{ V = { param($p) Test-DnsBlock $p 'unblock' }; E = { param($p, $v) Invoke-DnsBlock $p 'unblock' } } }
        'dns.rollback' { return @{ V = { param($p) Test-DnsRollback }; E = { param($p, $v) Invoke-DnsRollback } } }
        'deep.dnslog-enable' { return @{ V = { param($p) Test-DnsLogChange $true }; E = { param($p, $v) Invoke-DnsLogChange $true } } }
        'deep.dnslog-disable' { return @{ V = { param($p) Test-DnsLogChange $false }; E = { param($p, $v) Invoke-DnsLogChange $false } } }
        'defender.enable-realtime' { return @{ V = { param($p) Test-DefenderRealtime }; E = { param($p, $v) Invoke-DefenderRealtime } } }
        'system.run-windows-update-scan' { return @{ V = { param($p) Test-WindowsUpdateScan }; E = { param($p, $v) Invoke-WindowsUpdateScan } } }
        'system.open-settings' { return @{ V = { param($p) Test-OpenSettings $p }; E = { param($p, $v) Invoke-OpenSettings $p } } }
        'service.stop' { return @{ V = { param($p) Test-ServiceRun $p $false }; E = { param($p, $v) Invoke-ServiceRun $p $v $false } } }
        'service.start' { return @{ V = { param($p) Test-ServiceRun $p $true }; E = { param($p, $v) Invoke-ServiceRun $p $v $true } } }
        'storage.clean-temp' { return @{ V = { param($p) Test-CleanTemp $p }; E = { param($p, $v) Invoke-CleanTemp $p $v } } }
        'cleanup.empty-recycle-bin' { return @{ V = { param($p) Test-EmptyRecycleBin }; E = { param($p, $v) Invoke-EmptyRecycleBin } } }
        'file.delete-permanent' { return @{ V = { param($p) Test-FilePermanentDelete $p }; E = { param($p, $v) Invoke-FilePermanentDelete $p $v } } }
        'scan.schedule-once' { return @{ V = { param($p) Test-ScanScheduleOnce $p }; E = { param($p, $v) Invoke-ScanScheduleOnce $p $v } } }
        'scan.cancel-once' { return @{ V = { param($p) Test-ScanCancelOnce $p }; E = { param($p, $v) Invoke-ScanCancelOnce $p } } }
        'setup.enable-dns-log' { return @{ V = { param($p) Test-DnsLogChange $true }; E = { param($p, $v) Invoke-DnsLogChange $true } } }
        'setup.enable-firewall-audit' { return @{ V = { param($p) Test-FirewallAuditChange $true }; E = { param($p, $v) Invoke-FirewallAuditChange $true } } }
        'setup.disable-firewall-audit' { return @{ V = { param($p) Test-FirewallAuditChange $false }; E = { param($p, $v) Invoke-FirewallAuditChange $false } } }
        'app.verify-removed' { return @{ V = { param($p) Test-AppVerify $p }; E = { param($p, $v) Invoke-AppVerify $p } } }
        default { return $null }
    }
}

function Invoke-GuardianRemediation {
    <#
    .SYNOPSIS  Validate or execute one catalog action. Execute always re-validates first and refuses on any mismatch.
    .PARAMETER Params  Catalog parameters, plus optional _identityKey (from the earlier Validate) to detect change between review and action.
    #>
    param([Parameter(Mandatory)][string]$Action, [ValidateSet('Validate', 'Execute')][string]$Mode = 'Validate', [hashtable]$Params = @{})
    $spec = Get-ActionSpec -Id $Action
    if (-not $spec) { return New-RemResult -Ok $false -Action $Action -Mode $Mode -Errors @("'$Action' is not an allowlisted Guardian action.") }
    $perr = @(Test-ActionParams -Spec $spec -Params $Params)
    if ($perr.Count -gt 0) { return New-RemResult -Ok $false -Action $Action -Mode $Mode -Errors $perr }
    $h = Get-RemediationHandler -Id $Action
    if (-not $h) { return New-RemResult -Ok $false -Action $Action -Mode $Mode -Errors @('No handler for this action.') }
    $v = & $h.V $Params
    $v.action = $Action; $v.mode = $Mode
    if ($Mode -eq 'Validate') { return $v }
    if (-not $v.ok) { return $v }
    if ($Params.ContainsKey('_identityKey') -and $Params['_identityKey'] -and ([string]$Params['_identityKey'] -ne $v.identityKey)) {
        return New-RemResult -Ok $false -Action $Action -Mode $Mode -Errors @('The target changed between your review and this action (identity mismatch). Nothing was done; review it again.')
    }
    $r = & $h.E $Params $v
    $r.action = $Action; $r.mode = $Mode; $r.needsAdmin = $v.needsAdmin
    if (-not $r.identityKey) { $r.identityKey = $v.identityKey }
    return $r
}
