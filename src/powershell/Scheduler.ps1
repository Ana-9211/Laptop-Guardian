#requires -Version 5.1
<#
.SYNOPSIS  Registers / removes / reports Laptop Guardian scheduled tasks (Windows Task Scheduler, folder \LaptopGuardian).
.NOTES     Times come from config/config.json. RunLevel Highest is used when this script runs elevated (required for SFC/DISM/Repair-Volume).
           Prints one JSON object when -Json is set (used by the dashboard bridge).
#>
[CmdletBinding()]
param([ValidateSet('Status', 'Register', 'Unregister')][string]$Action = 'Status', [switch]$Json, [ValidatePattern('^\\[A-Za-z0-9_-]+\\$')][string]$TaskFolder = '\LaptopGuardian\')

. "$PSScriptRoot\Common\Load.ps1"
Start-RunContext -RunType 'user'
$folder = $TaskFolder
$names = @{ daily = 'Daily Audit'; weekly = 'Weekly Deep Analysis'; dashboard = 'Dashboard Bridge' }

function Get-TaskInfo {
    $out = @()
    foreach ($k in 'daily', 'weekly', 'dashboard') {
        $t = Get-ScheduledTask -TaskPath $folder -TaskName $names[$k] -ErrorAction SilentlyContinue
        if (-not $t) { $out += [pscustomobject]@{ name = $names[$k]; kind = $k; state = 'NotRegistered'; nextRun = $null; lastRun = $null; lastResult = $null; runLevel = $null; trigger = $null; wakeToRun = $null }; continue }
        $i = Get-ScheduledTaskInfo -TaskPath $folder -TaskName $names[$k] -ErrorAction SilentlyContinue
        $trg = @($t.Triggers)[0]
        $out += [pscustomobject]@{
            name = $t.TaskName; kind = $k; state = [string]$t.State
            nextRun = $(if ($i -and $i.NextRunTime -and $i.NextRunTime.Year -gt 2000) { ConvertTo-IsoTime $i.NextRunTime } else { $null })
            lastRun = $(if ($i -and $i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { ConvertTo-IsoTime $i.LastRunTime } else { $null })
            lastResult = $(if ($i) { $i.LastTaskResult } else { $null }); runLevel = [string]$t.Principal.RunLevel
            trigger = $(if ($trg) { ConvertTo-IsoTime $trg.StartBoundary } else { $null }); wakeToRun = [bool]$t.Settings.WakeToRun
        }
    }
    return $out
}

function Register-Guardian {
    $cfg = Get-GuardianConfig
    $ps = (Get-Command powershell.exe).Source
    $admin = Test-IsAdmin
    $runLevel = if ($admin) { 'Highest' } else { 'Limited' }
    $user = "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel $runLevel
    $root = Split-Path -Parent $PSScriptRoot | Split-Path -Parent

    if ($cfg.schedule.daily.enabled) {
        $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSScriptRoot\Daily.ps1`"" -WorkingDirectory $root
        $time = [datetime]::ParseExact($cfg.schedule.daily.time, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
        $trigger = New-ScheduledTaskTrigger -Daily -At $time
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)
        Register-ScheduledTask -TaskPath $folder -TaskName $names.daily -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Laptop Guardian daily audit (observe, analyse, recommend).' -Force | Out-Null
        [void](Write-GuardianEvent -Category config -Action 'scheduler:registered-daily' -Target $cfg.schedule.daily.time -Actor user -Reason "runLevel=$runLevel")
    } else { Unregister-ScheduledTask -TaskPath $folder -TaskName $names.daily -Confirm:$false -ErrorAction SilentlyContinue }

    if ($cfg.schedule.weekly.enabled) {
        $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSScriptRoot\Weekly.ps1`" -Scheduled" -WorkingDirectory $root
        $time = [datetime]::ParseExact($cfg.schedule.weekly.time, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
        $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek ([System.DayOfWeek]$cfg.schedule.weekly.day) -At $time
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 5)
        Register-ScheduledTask -TaskPath $folder -TaskName $names.weekly -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Laptop Guardian weekly deep analysis; ends with controlled shutdown.' -Force | Out-Null
        [void](Write-GuardianEvent -Category config -Action 'scheduler:registered-weekly' -Target "$($cfg.schedule.weekly.day) $($cfg.schedule.weekly.time)" -Actor user -Reason "runLevel=$runLevel")
    } else { Unregister-ScheduledTask -TaskPath $folder -TaskName $names.weekly -Confirm:$false -ErrorAction SilentlyContinue }
    # Dashboard bridge: local-only web server (127.0.0.1) started at logon with LEAST privilege.
    $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if ($node) {
        $server = Join-Path $root 'src\bridge\server.js'
        $a = New-ScheduledTaskAction -Execute $node -Argument "`"$server`"" -WorkingDirectory $root
        $tr = New-ScheduledTaskTrigger -AtLogOn -User $user
        $st = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
        $pr = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskPath $folder -TaskName $names.dashboard -Action $a -Trigger $tr -Settings $st -Principal $pr -Description 'Laptop Guardian local dashboard (127.0.0.1 only).' -Force | Out-Null
    }
    return $runLevel
}

function Unregister-Guardian {
    foreach ($k in 'daily', 'weekly', 'dashboard') { Unregister-ScheduledTask -TaskPath $folder -TaskName $names[$k] -Confirm:$false -ErrorAction SilentlyContinue }
    # remove the (now empty) folder
    try { $svc = New-Object -ComObject Schedule.Service; $svc.Connect(); $svc.GetFolder('\').DeleteFolder($folder.Trim([char]92), 0) } catch { }
    [void](Write-GuardianEvent -Category config -Action 'scheduler:unregistered' -Actor user)
}

$result = [ordered]@{ ok = $true; action = $Action; message = ''; tasks = @(); admin = (Test-IsAdmin) }
try {
    switch ($Action) {
        'Register' { $lvl = Register-Guardian; $result.message = "Registered (run level $lvl)" }
        'Unregister' { Unregister-Guardian; $result.message = 'Tasks removed' }
    }
    $result.tasks = @(Get-TaskInfo)
} catch { $result.ok = $false; $result.message = $_.Exception.Message }
if ($Json) { $result | ConvertTo-Json -Depth 5 -Compress } else { $result.tasks | Format-Table -AutoSize; if ($result.message) { Write-Host $result.message } }
exit $(if ($result.ok) { 0 } else { 1 })
