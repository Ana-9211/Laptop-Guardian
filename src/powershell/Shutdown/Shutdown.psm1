#requires -Version 5.1
# Shutdown: controlled Windows shutdown. Guardian never kills processes; Windows performs the shutdown.
Set-StrictMode -Version 2.0

function Get-SecondsUntil {
    param([string]$TimeOfDay)   # "HH:mm"
    $t = [datetime]::ParseExact($TimeOfDay, 'HH:mm', [System.Globalization.CultureInfo]::InvariantCulture)
    $target = (Get-Date).Date.Add($t.TimeOfDay)
    return [int](($target - (Get-Date)).TotalSeconds)
}

function Test-ShutdownAllowed {
    param($Config, [switch]$NoShutdown)
    if ($NoShutdown) { return [pscustomobject]@{ Allowed = $false; Reason = 'Disabled by -NoShutdown switch' } }
    if (-not $Config.safety.weeklyShutdown) { return [pscustomobject]@{ Allowed = $false; Reason = 'Weekly shutdown disabled in Safety settings' } }
    if (-not $Config.schedule.weekly.shutdownEnabled) { return [pscustomobject]@{ Allowed = $false; Reason = 'Shutdown disabled in Schedule settings' } }
    if ($Config.safety.automationPaused) { return [pscustomobject]@{ Allowed = $false; Reason = 'Automation is paused' } }
    return [pscustomobject]@{ Allowed = $true; Reason = 'ok' }
}

function Start-GuardianShutdown {
    <# Schedules a Windows shutdown at $ShutdownTime (or in 60 s if that time has passed). Abortable with: shutdown /a #>
    param($Config, [switch]$NoShutdown, [int]$MinDelaySec = 300, [int]$MaxDelaySec = 21600)
    $chk = Test-ShutdownAllowed -Config $Config -NoShutdown:$NoShutdown
    $res = [ordered]@{ planned = $null; initiated = $false; reason = $chk.Reason; delaySec = 0 }
    if (-not $chk.Allowed) { [void](Write-GuardianEvent -Category shutdown -Action 'shutdown:skipped' -Result skipped -Reason $chk.Reason); return [pscustomobject]$res }
    $delay = Get-SecondsUntil $Config.schedule.weekly.shutdownTime
    # Never shut down outside the planned window (e.g. a missed run started late while you are working)
    if ($delay -lt 0 -or $delay -gt $MaxDelaySec) {
        $res.reason = 'Planned shutdown time has passed (or is too far away); shutdown withheld'
        [void](Write-GuardianEvent -Category shutdown -Action 'shutdown:skipped' -Result skipped -Reason $res.reason)
        return [pscustomobject]$res
    }
    if ($delay -lt $MinDelaySec) { $delay = $MinDelaySec }
    $res.delaySec = $delay; $res.planned = (Get-Date).AddSeconds($delay).ToString('yyyy-MM-ddTHH:mm:sszzz')
    try {
        $out = & "$env:SystemRoot\System32\shutdown.exe" /s /t $delay /c "Laptop Guardian weekly maintenance finished. Run 'shutdown /a' to cancel." 2>&1
        if ($LASTEXITCODE -eq 0) {
            $res.initiated = $true; $res.reason = "Windows shutdown scheduled in $delay s (cancel with: shutdown /a)"
            [void](Write-GuardianEvent -Category shutdown -Action 'shutdown:initiated' -Result success -Reason $res.reason)
        } else {
            $res.reason = "shutdown.exe failed: $out"
            [void](Write-GuardianEvent -Category shutdown -Action 'shutdown:initiate' -Result failure -Severity error -ErrorDetails "$out")
        }
    } catch { $res.reason = $_.Exception.Message; [void](Write-GuardianEvent -Category shutdown -Action 'shutdown:initiate' -Result failure -Severity error -ErrorDetails $_.Exception.Message) }
    return [pscustomobject]$res
}

Export-ModuleMember -Function *
