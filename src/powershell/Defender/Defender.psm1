#requires -Version 5.1
# Microsoft Defender + Windows Firewall. Read-mostly; never disables or weakens anything.
Set-StrictMode -Version 2.0

function Invoke-JobWithTimeout {
    param([Parameter(Mandatory)][scriptblock]$ScriptBlock, [int]$TimeoutSec = 120, $ArgumentList = @())
    $job = Start-Job -ScriptBlock $ScriptBlock -ArgumentList $ArgumentList
    try {
        $done = Wait-Job -Job $job -Timeout $TimeoutSec
        if (-not $done) { Stop-Job -Job $job -ErrorAction SilentlyContinue; return [pscustomobject]@{ Ok = $false; TimedOut = $true; Output = $null; Error = 'timeout' } }
        $out = Receive-Job -Job $job -ErrorAction SilentlyContinue -ErrorVariable ev
        if ($job.State -eq 'Failed') { return [pscustomobject]@{ Ok = $false; TimedOut = $false; Output = $null; Error = [string]$job.ChildJobs[0].JobStateInfo.Reason.Message } }
        $err = $null; if ($ev -and $ev.Count) { $err = [string]$ev[0] }
        return [pscustomobject]@{ Ok = (-not $err); TimedOut = $false; Output = $out; Error = $err }
    } finally { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
}

function Get-DefenderStatus {
    $r = [ordered]@{ available = $false; enabled = $null; realTimeProtection = $null; sigVersion = $null; sigAgeDays = $null; lastQuickScan = $null; lastFullScan = $null; tamperProtected = $null; threats = 0; scan = [pscustomobject]@{ ran = $false; result = 'not-run'; durationSec = 0; threats = @() }; error = $null }
    try {
        $s = Get-MpComputerStatus -ErrorAction Stop
        $r.available = $true
        $r.enabled = [bool]$s.AMServiceEnabled; $r.realTimeProtection = [bool]$s.RealTimeProtectionEnabled
        $r.sigVersion = $s.AntivirusSignatureVersion
        if ($s.AntivirusSignatureLastUpdated) { $r.sigAgeDays = [math]::Round(((Get-Date) - $s.AntivirusSignatureLastUpdated).TotalDays, 1) }
        $r.lastQuickScan = ConvertTo-IsoTime $s.QuickScanEndTime; $r.lastFullScan = ConvertTo-IsoTime $s.FullScanEndTime
        try { $r.tamperProtected = [bool]$s.IsTamperProtected } catch { }
    } catch { $r.error = $_.Exception.Message }
    try {
        # Only unresolved detections count: 1 detected, 5 allowed, 102-106 an action (quarantine/remove/allow/abandon/block) failed.
        # 2 cleaned, 3 quarantined, 4 removed and 6 blocked are resolved and must not be reported as active threats.
        $unresolved = 1, 5, 102, 103, 104, 105, 106
        $det = @(Get-MpThreatDetection -ErrorAction Stop | Where-Object { $_.InitialDetectionTime -gt (Get-Date).AddDays(-30) -and ([int]$_.ThreatStatusID) -in $unresolved } | Group-Object { [string]$_.ThreatID } | ForEach-Object { $_.Group | Sort-Object InitialDetectionTime -Descending | Select-Object -First 1 })
        $names = @{}
        try { foreach ($t in @(Get-MpThreat -ErrorAction Stop)) { $names[[string]$t.ThreatID] = [string]$t.ThreatName } } catch { }
        $r.threats = $det.Count
        $r.scan.threats = @($det | Select-Object -First 20 | ForEach-Object { $tid = [string]$_.ThreatID; [pscustomobject]@{ name = $(if ($names.ContainsKey($tid) -and $names[$tid]) { $names[$tid] } else { "Threat ID $tid" }); severity = 'unknown'; status = [string]$_.ThreatStatusID } })
    } catch { }
    [pscustomobject]$r
}

function Update-DefenderSignatures {
    $res = Invoke-JobWithTimeout -TimeoutSec 180 -ScriptBlock { Update-MpSignature -ErrorAction Stop }
    if ($res.Ok) { [void](Write-GuardianEvent -Category defender -Action 'defender:update-signatures' -Result success) }
    elseif ($res.TimedOut) { [void](Write-GuardianEvent -Category defender -Action 'defender:update-signatures' -Result timeout -Severity warning) }
    else { [void](Write-GuardianEvent -Category defender -Action 'defender:update-signatures' -Result failure -Severity warning -ErrorDetails $res.Error) }
    return $res
}

function Invoke-DefenderScan {
    # -LeaveRunning: a scan still going at the deadline is reported as 'running' (Defender keeps scanning) instead of 'timeout'.
    param([ValidateSet('QuickScan', 'FullScan')][string]$Type = 'QuickScan', [int]$TimeoutSec = 900, [switch]$LeaveRunning)
    [void](Write-GuardianEvent -Category defender -Action "defender:$Type-started" -Result started)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $res = Invoke-JobWithTimeout -TimeoutSec $TimeoutSec -ArgumentList $Type -ScriptBlock { param($t) Start-MpScan -ScanType $t -ErrorAction Stop }
    $sw.Stop()
    $result = if ($res.TimedOut) { $(if ($LeaveRunning) { 'running' } else { 'timeout' }) } elseif ($res.Ok) { 'completed' } else { 'failed' }
    $sev = if ($result -eq 'completed') { 'info' } else { 'warning' }
    $rr = if ($result -eq 'completed') { 'success' } elseif ($result -eq 'timeout') { 'timeout' } else { 'failure' }
    [void](Write-GuardianEvent -Category defender -Action "defender:$Type-finished" -Result $rr -Severity $sev -ErrorDetails $res.Error)
    return [pscustomobject]@{ ran = $true; result = $result; durationSec = [int]$sw.Elapsed.TotalSeconds; error = $res.Error }
}

function Get-FirewallStatus {
    $r = [ordered]@{ profiles = @(); problems = @() }
    try {
        $profiles = @(Get-NetFirewallProfile -ErrorAction Stop)
        $r.profiles = @($profiles | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; enabled = ([string]$_.Enabled -eq 'True'); defaultInbound = [string]$_.DefaultInboundAction; defaultOutbound = [string]$_.DefaultOutboundAction } })
        foreach ($p in $r.profiles) {
            if (-not $p.enabled) { $r.problems += "Firewall profile '$($p.name)' is disabled." }
            if ($p.defaultInbound -eq 'Allow') { $r.problems += "Profile '$($p.name)' allows inbound traffic by default." }
        }
    } catch { $r.problems += "Could not read firewall status: $($_.Exception.Message)" }
    [pscustomobject]$r
}

Export-ModuleMember -Function *
