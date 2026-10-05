#requires -Version 5.1
<#
.SYNOPSIS  Registers / removes / reports Laptop Guardian scheduled tasks (Windows Task Scheduler, folder \LaptopGuardian).
.NOTES     Times come from config/config.json. Daily/Weekly use RunLevel Highest when this script runs elevated (required for SFC/DISM/Repair-Volume).
           A non-elevated run NEVER replaces or removes an existing elevated Daily/Weekly task: it reports `needsElevation` instead,
           so saving settings from the dashboard cannot silently downgrade maintenance. `-Elevate` is the explicit path: it asks
           Windows (UAC) to run exactly this script's Register action elevated; it never opens a general elevated shell.
           Prints one JSON object when -Json is set (used by the dashboard bridge).
#>
[CmdletBinding()]
param(
    [ValidateSet('Status', 'Register', 'Unregister')][string]$Action = 'Status',
    [switch]$Json,
    [ValidatePattern('^\\[A-Za-z0-9_-]+\\$')][string]$TaskFolder = '\LaptopGuardian\',
    [switch]$Elevate
)

. "$PSScriptRoot\Common\Load.ps1"
Import-Module (Join-Path $PSScriptRoot 'Scheduling\TaskPlan.psm1') -Force -DisableNameChecking
Start-RunContext -RunType 'user'
$folder = $TaskFolder
$names = @{ daily = 'Daily Audit'; weekly = 'Weekly Deep Analysis'; dashboard = 'Dashboard Bridge' }
$kinds = 'daily', 'weekly', 'dashboard'
$root = Split-Path -Parent $PSScriptRoot | Split-Path -Parent
$scriptFor = @{ daily = (Join-Path $PSScriptRoot 'Daily.ps1'); weekly = (Join-Path $PSScriptRoot 'Weekly.ps1'); dashboard = (Join-Path $root 'src\bridge\server.js') }

function Get-TaskInfo {
    $out = @()
    foreach ($k in $kinds) {
        $t = Get-ScheduledTask -TaskPath $folder -TaskName $names[$k] -ErrorAction SilentlyContinue
        if (-not $t) { $out += [pscustomobject]@{ name = $names[$k]; kind = $k; state = 'NotRegistered'; nextRun = $null; lastRun = $null; lastResult = $null; runLevel = $null; trigger = $null; wakeToRun = $null; scheduledFlag = $false; scriptCurrent = $false; time = $null; days = @() }; continue }
        $i = Get-ScheduledTaskInfo -TaskPath $folder -TaskName $names[$k] -ErrorAction SilentlyContinue
        $trg = @($t.Triggers)[0]
        $args0 = [string]@($t.Actions)[0].Arguments
        $out += [pscustomobject]@{
            name = $t.TaskName; kind = $k; state = [string]$t.State
            nextRun = $(if ($i -and $i.NextRunTime -and $i.NextRunTime.Year -gt 2000) { ConvertTo-IsoTime $i.NextRunTime } else { $null })
            lastRun = $(if ($i -and $i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { ConvertTo-IsoTime $i.LastRunTime } else { $null })
            lastResult = $(if ($i) { $i.LastTaskResult } else { $null }); runLevel = [string]$t.Principal.RunLevel
            days = @($(if ($trg -and $trg.PSObject.Properties['DaysOfWeek'] -and $trg.DaysOfWeek) { $bits = [int]$trg.DaysOfWeek; $dn = 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'; 0..6 | Where-Object { $bits -band (1 -shl $_) } | ForEach-Object { $dn[$_] } }))
            scheduledFlag = [bool]($args0 -match '-Scheduled\b')
            scriptCurrent = ($args0.IndexOf($scriptFor[$k], [StringComparison]::OrdinalIgnoreCase) -ge 0)
            time = $(if ($trg -and $trg.StartBoundary) { ([datetime]$trg.StartBoundary).ToString('HH:mm') } else { $null })
            trigger = $(if ($trg) { ConvertTo-IsoTime $trg.StartBoundary } else { $null }); wakeToRun = [bool]$t.Settings.WakeToRun
        }
    }
    return $out
}

function Get-DesiredTasks {
    param($Cfg)
    @(
        [pscustomobject]@{ kind = 'daily'; enabled = [bool]$Cfg.schedule.daily.enabled; time = [string]$Cfg.schedule.daily.time; day = $null; needsScheduledFlag = $true; wantsHighest = $true }
        [pscustomobject]@{ kind = 'weekly'; enabled = [bool]$Cfg.schedule.weekly.enabled; time = [string]$Cfg.schedule.weekly.time; day = [string]$Cfg.schedule.weekly.day; needsScheduledFlag = $true; wantsHighest = $true }
        [pscustomobject]@{ kind = 'dashboard'; enabled = [bool](Get-Command node.exe -ErrorAction SilentlyContinue); time = $null; day = $null; needsScheduledFlag = $false; wantsHighest = $false }
    )
}

function Set-GuardianTask {
    param([string]$Kind, $Cfg, [string]$RunLevel)
    $ps = (Get-Command powershell.exe).Source
    $user = "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel $RunLevel
    switch ($Kind) {
        'daily' {
            $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSScriptRoot\Daily.ps1`" -Scheduled" -WorkingDirectory $root
            $time = [datetime]::ParseExact($Cfg.schedule.daily.time, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
            $trigger = New-ScheduledTaskTrigger -Daily -At $time
            $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)
            Register-ScheduledTask -TaskPath $folder -TaskName $names.daily -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Laptop Guardian daily audit (observe, analyse, recommend).' -Force | Out-Null
        }
        'weekly' {
            $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSScriptRoot\Weekly.ps1`" -Scheduled" -WorkingDirectory $root
            $time = [datetime]::ParseExact($Cfg.schedule.weekly.time, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
            $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek ([System.DayOfWeek]$Cfg.schedule.weekly.day) -At $time
            $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 5)
            Register-ScheduledTask -TaskPath $folder -TaskName $names.weekly -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Laptop Guardian weekly deep analysis; ends with controlled shutdown.' -Force | Out-Null
        }
        'dashboard' {
            # Local-only web server (127.0.0.1) started at logon with LEAST privilege, whatever this process's own level.
            $node = (Get-Command node.exe -ErrorAction Stop).Source
            $a = New-ScheduledTaskAction -Execute $node -Argument "`"$($scriptFor.dashboard)`"" -WorkingDirectory $root
            $tr = New-ScheduledTaskTrigger -AtLogOn -User $user
            $st = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
            $pr = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
            Register-ScheduledTask -TaskPath $folder -TaskName $names.dashboard -Action $a -Trigger $tr -Settings $st -Principal $pr -Description 'Laptop Guardian local dashboard (127.0.0.1 only).' -Force | Out-Null
        }
    }
}

function Register-Guardian {
    $cfg = Get-GuardianConfig
    $admin = Test-IsAdmin
    $plan = Get-TaskRegistrationPlan -Desired (Get-DesiredTasks -Cfg $cfg) -Existing @(Get-TaskInfo | ForEach-Object { $_ | Add-Member -NotePropertyName exists -NotePropertyValue ($_.state -ne 'NotRegistered') -PassThru }) -IsAdmin $admin
    $report = @()
    foreach ($p in $plan) {
        $outcome = $p.outcome; $detail = ($p.reasons -join '; ')
        try {
            switch ($p.outcome) {
                { $_ -in 'create', 'update' } {
                    Set-GuardianTask -Kind $p.kind -Cfg $cfg -RunLevel $p.runLevel
                    $outcome = if ($p.outcome -eq 'create') { 'created' } else { 'updated' }
                    [void](Write-GuardianEvent -Category config -Action "scheduler:$outcome-$($p.kind)" -Target $names[$p.kind] -Actor user -Reason "runLevel=$($p.runLevel); $detail")
                }
                'remove' {
                    Unregister-ScheduledTask -TaskPath $folder -TaskName $names[$p.kind] -Confirm:$false -ErrorAction Stop
                    $outcome = 'removed'
                    [void](Write-GuardianEvent -Category config -Action "scheduler:removed-$($p.kind)" -Target $names[$p.kind] -Actor user -Reason $detail)
                }
                'elevation-required' {
                    [void](Write-GuardianEvent -Category config -Action "scheduler:needs-elevation-$($p.kind)" -Target $names[$p.kind] -Actor user -Result skipped -Reason "kept the elevated task unchanged; $detail")
                }
            }
        } catch { $outcome = 'failed'; $detail = $_.Exception.Message }
        $report += [pscustomobject]@{ kind = $p.kind; outcome = $outcome; detail = $detail }
    }
    return $report
}

function Unregister-Guardian {
    $admin = Test-IsAdmin; $kept = @()
    foreach ($k in $kinds) {
        $t = Get-ScheduledTask -TaskPath $folder -TaskName $names[$k] -ErrorAction SilentlyContinue
        if ($t -and $t.Principal.RunLevel -eq 'Highest' -and -not $admin) { $kept += $k; continue }
        if ($t) { Unregister-ScheduledTask -TaskPath $folder -TaskName $names[$k] -Confirm:$false -ErrorAction SilentlyContinue }
    }
    if (-not $kept.Count) { try { $svc = New-Object -ComObject Schedule.Service; $svc.Connect(); $svc.GetFolder('\').DeleteFolder($folder.Trim([char]92), 0) } catch { } }
    [void](Write-GuardianEvent -Category config -Action 'scheduler:unregistered' -Actor user -Reason $(if ($kept.Count) { "elevated tasks left in place (need administrator): $($kept -join ', ')" } else { 'all tasks removed' }))
    return $kept
}

function Request-ElevatedRegister {
    <# The one and only elevated entry point: Register, with fixed arguments, through the normal UAC consent prompt. #>
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$PSCommandPath`"", '-Action', 'Register', '-TaskFolder', "`"$folder`"")
    try {
        Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList $argList -Verb RunAs -WindowStyle Hidden | Out-Null
        [void](Write-GuardianEvent -Category config -Action 'scheduler:elevation-requested' -Actor user -Reason 'user asked to apply the schedule with administrator permission')
        return [pscustomobject]@{ requested = $true; message = 'Windows is asking for administrator permission. Approve it to finish updating the tasks.' }
    } catch {
        [void](Write-GuardianEvent -Category config -Action 'scheduler:elevation-requested' -Actor user -Severity warning -Result failure -ErrorDetails $_.Exception.Message)
        return [pscustomobject]@{ requested = $false; message = 'Administrator permission was not granted, so the tasks were not changed.' }
    }
}

$result = [ordered]@{ ok = $true; action = $Action; message = ''; tasks = @(); admin = (Test-IsAdmin); report = @(); needsElevation = $false; elevationRequested = $false }
try {
    if ($Elevate -and $Action -eq 'Register' -and -not (Test-IsAdmin)) {
        $e = Request-ElevatedRegister
        $result.elevationRequested = $e.requested; $result.ok = $e.requested; $result.message = $e.message
    } else {
        switch ($Action) {
            'Register' {
                $result.report = @(Register-Guardian)
                $result.needsElevation = [bool]@($result.report | Where-Object { $_.outcome -eq 'elevation-required' }).Count
                $failed = @($result.report | Where-Object { $_.outcome -eq 'failed' })
                $changed = @($result.report | Where-Object { $_.outcome -in 'created', 'updated', 'removed' })
                $result.message = if ($failed.Count) { "Some tasks could not be changed: $(($failed | ForEach-Object { "$($_.kind): $($_.detail)" }) -join '; ')" }
                    elseif ($result.needsElevation) { 'Elevated tasks were left unchanged. Applying these changes needs administrator permission.' }
                    elseif ($changed.Count) { "Tasks updated ($(($changed | ForEach-Object { "$($_.kind) $($_.outcome)" }) -join ', '))" }
                    else { 'Tasks already match Settings; nothing to change.' }
                if ($failed.Count) { $result.ok = $false }
            }
            'Unregister' { $kept = @(Unregister-Guardian); $result.needsElevation = [bool]$kept.Count; $result.message = if ($kept.Count) { "Elevated tasks need administrator permission to remove: $($kept -join ', ')" } else { 'Tasks removed' } }
        }
    }
    $result.tasks = @(Get-TaskInfo)
} catch { $result.ok = $false; $result.message = $_.Exception.Message }
if ($Json) { $result | ConvertTo-Json -Depth 5 -Compress } else { $result.tasks | Format-Table -AutoSize; if ($result.message) { Write-Host $result.message } }
exit $(if ($result.ok) { 0 } else { 1 })
