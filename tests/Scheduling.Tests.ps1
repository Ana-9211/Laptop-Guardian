. "$PSScriptRoot\Helpers.ps1"
$root = New-TestRoot; Import-Guardian; Initialize-GuardianDirectories
$sched = Join-Path $script:RepoRoot 'src\powershell\Scheduler.ps1'
$testFolder = '\LaptopGuardianTest\'

Describe 'Windows Task Scheduler integration' {
    It 'registers daily 19:00 and weekly Saturday 02:00 tasks from config' {
        $r = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sched -Action Register -Json -TaskFolder $testFolder | ConvertFrom-Json
        $r.ok | Should Be $true
        $d = Get-ScheduledTask -TaskPath $testFolder -TaskName 'Daily Audit'
        $w = Get-ScheduledTask -TaskPath $testFolder -TaskName 'Weekly Deep Analysis'
        ([datetime]$d.Triggers[0].StartBoundary).ToString('HH:mm') | Should Be '19:00'
        ([datetime]$w.Triggers[0].StartBoundary).ToString('HH:mm') | Should Be '02:00'
        [string]$w.Triggers[0].DaysOfWeek | Should Be '64'      # Saturday bit
        $w.Settings.WakeToRun | Should Be $true
        $d.Actions[0].Arguments | Should Match 'Daily\.ps1'
        $w.Actions[0].Arguments | Should Match 'Weekly\.ps1'
    }
    It 'reports status as JSON' {
        $r = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sched -Action Status -Json -TaskFolder $testFolder | ConvertFrom-Json
        (@($r.tasks) | Where-Object { $_.kind -eq 'daily' }).state | Should Not Be 'NotRegistered'
        (@($r.tasks) | Where-Object { $_.kind -eq 'daily' }).nextRun | Should Not BeNullOrEmpty
    }
    It 'picks up modified schedule times (user changed Settings)' {
        Write-JsonFile -Path (Get-GuardianPath 'Config') -Object @{ schedule = @{ daily = @{ enabled = $true; time = '20:30' }; weekly = @{ enabled = $true; day = 'Sunday'; time = '03:15'; shutdownTime = '05:30'; shutdownEnabled = $true } } }
        $env:GUARDIAN_ROOT = $root
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sched -Action Register -Json -TaskFolder $testFolder | Out-Null
        ([datetime](Get-ScheduledTask -TaskPath $testFolder -TaskName 'Daily Audit').Triggers[0].StartBoundary).ToString('HH:mm') | Should Be '20:30'
        $w = Get-ScheduledTask -TaskPath $testFolder -TaskName 'Weekly Deep Analysis'
        ([datetime]$w.Triggers[0].StartBoundary).ToString('HH:mm') | Should Be '03:15'
        [string]$w.Triggers[0].DaysOfWeek | Should Be '1'       # Sunday
    }
    It 'rejects a malicious task folder name' { { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sched -Action Status -TaskFolder '\x"; calc; "\' } | Should Not Throw; $LASTEXITCODE | Should Not Be 0 }
    It 'unregisters cleanly' {
        $r = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sched -Action Unregister -Json -TaskFolder $testFolder | ConvertFrom-Json
        $r.ok | Should Be $true
        @(Get-ScheduledTask -TaskPath $testFolder -ErrorAction SilentlyContinue).Count | Should Be 0
    }
}

Describe 'Shutdown policy' {
    $cfg = Get-GuardianConfig
    It 'is allowed by default config' { (Test-ShutdownAllowed -Config $cfg).Allowed | Should Be $true }
    It 'is blocked by -NoShutdown' { (Test-ShutdownAllowed -Config $cfg -NoShutdown).Allowed | Should Be $false }
    It 'is blocked by Safety > weekly shutdown off' { $c = Get-GuardianConfig; $c.safety.weeklyShutdown = $false; (Test-ShutdownAllowed -Config $c).Allowed | Should Be $false }
    It 'is blocked by Schedule > shutdown disabled' { $c = Get-GuardianConfig; $c.schedule.weekly.shutdownEnabled = $false; (Test-ShutdownAllowed -Config $c).Allowed | Should Be $false }
    It 'is blocked while automation is paused' { $c = Get-GuardianConfig; $c.safety.automationPaused = $true; (Test-ShutdownAllowed -Config $c).Allowed | Should Be $false }
    It 'does not call shutdown.exe when disallowed' {
        $r = Start-GuardianShutdown -Config $cfg -NoShutdown
        $r.initiated | Should Be $false
        (Read-JsonLines (Get-GuardianPath 'Actions') | Where-Object { $_.action -eq 'shutdown:skipped' }) | Should Not BeNullOrEmpty
    }
    It 'weekly script only shuts down for runs flagged -Scheduled' {
        (Get-Content (Join-Path $PSScriptRoot '..\src\powershell\Weekly.ps1') -Raw) | Should Match '-NoShutdown:\(\$NoShutdown -or -not \$Scheduled\)'
    }
    It 'scheduler registers the weekly task with -Scheduled' {
        (Get-Content (Join-Path $PSScriptRoot '..\src\powershell\Scheduler.ps1') -Raw) | Should Match 'Weekly\.ps1`" -Scheduled'
    }
    It 'bridge never launches a weekly run that can shut down' {
        (Get-Content (Join-Path $PSScriptRoot '..\src\bridge\server.js') -Raw) | Should Match "launchScan\('Weekly', \['-NoShutdown'\]\)"
    }
    It 'computes seconds until a wall-clock time' { $t = (Get-Date).AddMinutes(30).ToString('HH:mm'); $s = Get-SecondsUntil $t; ($s -gt 1500 -and $s -lt 1900) | Should Be $true }
}

Describe 'Retention of interrupted runs (machine shut down mid-run)' {
    It 'a stale running marker does not block the next run and is reported' {
        Set-RunState -Key 'running' -Value ([pscustomobject]@{ type = 'daily'; phase = 'collecting'; startedAt = (Get-IsoNow) })
        (Enter-GuardianLock -Name 'daily') | Should Be $true      # a dead process holds no mutex
        Exit-GuardianLock -Name 'daily'
        (Get-RunState).running.phase | Should Be 'collecting'     # Daily.ps1 logs run:previous-interrupted and clears it
    }
}
Remove-TestRoot $root
