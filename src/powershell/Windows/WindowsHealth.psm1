#requires -Version 5.1
# Windows health: pending reboot, Windows Update, event-log errors, SFC, DISM. Heavy tools are opt-in with timeouts and need elevation.
Set-StrictMode -Version 2.0

function Test-PendingReboot {
    try {
        foreach ($k in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') {
            if (Test-Path -LiteralPath $k) { return $true }
        }
        $v = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue
        if ($v -and $v.PendingFileRenameOperations) { return $true }
    } catch { }
    return $false
}

function Get-WindowsUpdateStatus {
    $r = [ordered]@{ pendingCount = $null; lastInstalled = $null; status = 'unknown' }
    try {
        $session = New-Object -ComObject Microsoft.Update.Session
        $searcher = $session.CreateUpdateSearcher()
        $searcher.Online = $false   # use cached catalog; no network call
        try { $h = $searcher.QueryHistory(0, 20) | Where-Object { $_.ResultCode -eq 2 -and $_.Date } | Select-Object -First 1; if ($h) { $r.lastInstalled = ConvertTo-IsoTime $h.Date } } catch { }
        $res = $searcher.Search("IsInstalled=0 and IsHidden=0")
        $r.pendingCount = [int]$res.Updates.Count
        $r.status = if ($r.pendingCount -gt 0) { 'updates-pending' } else { 'up-to-date-as-of-last-check' }
    } catch { $r.status = 'unavailable' }
    [pscustomobject]$r
}

function Get-EventErrorSummary {
    param([int]$Days = 1, [int]$MaxEvents = 3000)
    $start = (Get-Date).AddDays(-$Days)
    $out = [ordered]@{ system = 0; application = 0; top = @() }
    $all = New-Object System.Collections.ArrayList
    foreach ($log in 'System', 'Application') {
        try {
            $ev = @(Get-WinEvent -FilterHashtable @{ LogName = $log; Level = 1, 2; StartTime = $start } -MaxEvents $MaxEvents -ErrorAction Stop)
            $out[$log.ToLowerInvariant()] = $ev.Count
            foreach ($e in $ev) { [void]$all.Add($e) }
        } catch {
            if ($_.Exception.Message -notmatch 'No events were found') { Add-RunError -Source "eventlog:$log" -Message $_.Exception.Message }
        }
    }
    $out.top = @($all | Group-Object { "$($_.ProviderName)|$($_.Id)" } | Sort-Object Count -Descending | Select-Object -First 8 | ForEach-Object {
            $f = $_.Group[0]
            $msg = ''; try { $msg = ([string]$f.Message -split "`r?`n")[0]; if ($msg.Length -gt 220) { $msg = $msg.Substring(0, 220) } } catch { }
            [pscustomobject]@{ source = $f.ProviderName; id = $f.Id; count = $_.Count; message = $msg }
        })
    [pscustomobject]$out
}

function Get-FailedServiceEvents {
    # Service Control Manager events 7000/7001/7023/7024/7031/7034 = service failures
    param([int]$Days = 1)
    try {
        $ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; Id = 7000, 7001, 7023, 7024, 7031, 7034; StartTime = (Get-Date).AddDays(-$Days) } -MaxEvents 500 -ErrorAction Stop)
        $names = foreach ($e in $ev) { if ($e.Properties.Count -gt 0) { [string]$e.Properties[0].Value } }
        return @($names | Where-Object { $_ } | Select-Object -Unique)
    } catch { return @() }
}

function Invoke-SfcVerify {
    <# sfc /verifyonly: read-only integrity check. Requires elevation. Never runs /scannow automatically. #>
    param([int]$TimeoutSec = 1800)
    if (-not (Test-IsAdmin)) { return [pscustomobject]@{ ran = $false; result = 'requires-admin'; detail = 'sfc needs an elevated session' } }
    [void](Write-GuardianEvent -Category windows -Action 'sfc:verifyonly-started' -Result started)
    $c = Invoke-GuardianCommand -FilePath "$env:SystemRoot\System32\sfc.exe" -Arguments @('/verifyonly') -TimeoutSec $TimeoutSec
    $result = 'unknown'
    if ($c.TimedOut) { $result = 'timeout' }
    elseif ($c.Error) { $result = 'failed' }
    elseif ($c.Output -match 'did not find any integrity violations') { $result = 'clean' }
    elseif ($c.Output -match 'found integrity violations') { $result = 'violations-unrepaired' }
    elseif ($c.Output -match 'could not perform') { $result = 'failed' }
    $rr = switch ($result) { 'clean' { 'success' } 'timeout' { 'timeout' } 'violations-unrepaired' { 'success' } default { 'failure' } }
    [void](Write-GuardianEvent -Category windows -Action 'sfc:verifyonly-finished' -Result $rr -Severity $(if ($result -in 'clean') { 'info' } else { 'warning' }) -Target $result -ErrorDetails $c.Error)
    [pscustomobject]@{ ran = (-not $c.TimedOut -and -not $c.Error); result = $result; detail = $(if ($c.Output.Length -gt 400) { $c.Output.Substring(0, 400) } else { $c.Output }) }
}

function Invoke-DismCheck {
    <# DISM /CheckHealth (fast, metadata) daily-safe; /ScanHealth (deep, weekly) read-only. /RestoreHealth is NEVER run automatically. #>
    param([ValidateSet('CheckHealth', 'ScanHealth')][string]$Mode = 'CheckHealth', [int]$TimeoutSec = 1200)
    if (-not (Test-IsAdmin)) { return [pscustomobject]@{ ran = $false; result = 'requires-admin'; detail = 'DISM needs an elevated session' } }
    [void](Write-GuardianEvent -Category windows -Action "dism:$Mode-started" -Result started)
    $c = Invoke-GuardianCommand -FilePath "$env:SystemRoot\System32\dism.exe" -Arguments @('/Online', '/Cleanup-Image', "/$Mode") -TimeoutSec $TimeoutSec
    $result = 'unknown'
    if ($c.TimedOut) { $result = 'timeout' }
    elseif ($c.Error) { $result = 'failed' }
    elseif ($c.Output -match 'No component store corruption detected') { $result = 'healthy' }
    elseif ($c.Output -match 'not repairable') { $result = 'not-repairable' }
    elseif ($c.Output -match 'repairable') { $result = 'repairable' }
    elseif ($c.ExitCode -ne 0) { $result = 'failed' }
    $rr = switch ($result) { 'healthy' { 'success' } 'timeout' { 'timeout' } 'failed' { 'failure' } default { 'success' } }
    [void](Write-GuardianEvent -Category windows -Action "dism:$Mode-finished" -Result $rr -Target $result -Severity $(if ($result -eq 'healthy') { 'info' } else { 'warning' }) -ErrorDetails $c.Error)
    [pscustomobject]@{ ran = (-not $c.TimedOut -and -not $c.Error); result = $result; detail = $(if ($c.Output.Length -gt 400) { $c.Output.Substring($c.Output.Length - 400) } else { $c.Output }) }
}

function Get-ComponentStoreInfo {
    if (-not (Test-IsAdmin)) { return [pscustomobject]@{ reclaimable = $null; detail = 'requires-admin' } }
    $c = Invoke-GuardianCommand -FilePath "$env:SystemRoot\System32\dism.exe" -Arguments @('/Online', '/Cleanup-Image', '/AnalyzeComponentStore') -TimeoutSec 900
    $rec = $null
    if ($c.Output -match 'Component Store Cleanup Recommended\s*:\s*(\w+)') { $rec = $Matches[1] -eq 'Yes' }
    $size = $null
    if ($c.Output -match 'Reclaimable Packages\s*:\s*(\d+)') { $size = [int]$Matches[1] }
    [pscustomobject]@{ reclaimable = $rec; reclaimablePackages = $size; detail = $(if ($c.TimedOut) { 'timeout' } else { 'ok' }) }
}

function Get-WindowsHealth {
    param([switch]$IncludeDism, [switch]$IncludeSfc, [ValidateSet('CheckHealth', 'ScanHealth')][string]$DismMode = 'CheckHealth', [int]$EventDays = 1)
    $sfc = [pscustomobject]@{ ran = $false; result = 'not-run' }
    $dism = [pscustomobject]@{ ran = $false; result = 'not-run'; detail = '' }
    if ($IncludeSfc) { $sfc = Invoke-Safely 'sfc' { Invoke-SfcVerify } $sfc }
    if ($IncludeDism) { $dism = Invoke-Safely 'dism' { Invoke-DismCheck -Mode $DismMode } $dism }
    [pscustomobject][ordered]@{
        pendingReboot = (Test-PendingReboot)
        windowsUpdate = (Invoke-Safely 'windows-update' { Get-WindowsUpdateStatus } ([pscustomobject]@{ pendingCount = $null; lastInstalled = $null; status = 'unavailable' }))
        eventErrors = (Invoke-Safely 'event-log' { Get-EventErrorSummary -Days $EventDays } ([pscustomobject]@{ system = 0; application = 0; top = @() }))
        sfc = $sfc; dism = $dism
        componentStore = [pscustomobject]@{ reclaimable = $null }
    }
}

Export-ModuleMember -Function *
