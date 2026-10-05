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

Describe 'Scheduler never downgrades elevated tasks' {
    Import-Module (Join-Path $script:RepoRoot 'src\powershell\Scheduling\TaskPlan.psm1') -Force -DisableNameChecking
    $want = @(
        [pscustomobject]@{ kind = 'daily'; enabled = $true; time = '19:00'; day = $null; needsScheduledFlag = $true; wantsHighest = $true }
        [pscustomobject]@{ kind = 'weekly'; enabled = $true; time = '02:00'; day = 'Saturday'; needsScheduledFlag = $true; wantsHighest = $true }
    )
    function Ex($kind, $level = 'Highest', $flag = $true, $time = '19:00', $days = @(), $exists = $true, $script = $true) { [pscustomobject]@{ kind = $kind; exists = $exists; runLevel = $level; scheduledFlag = $flag; scriptCurrent = $script; time = $time; days = $days } }
    $good = @((Ex 'daily'), (Ex 'weekly' 'Highest' $true '02:00' @('Saturday')))
    function Outcome($plan, $kind) { @($plan | Where-Object { $_.kind -eq $kind })[0] }

    It 'leaves matching elevated tasks alone when a standard user saves settings' {
        $p = Get-TaskRegistrationPlan -Desired $want -Existing $good -IsAdmin $false
        (Outcome $p 'daily').outcome | Should Be 'unchanged'; (Outcome $p 'weekly').outcome | Should Be 'unchanged'
    }
    It 'refuses to replace an elevated task from a standard process when the time changed (no silent downgrade)' {
        $changed = @((Ex 'daily' 'Highest' $true '18:00'), (Ex 'weekly' 'Highest' $true '02:00' @('Saturday')))
        $o = Outcome (Get-TaskRegistrationPlan -Desired $want -Existing $changed -IsAdmin $false) 'daily'
        $o.outcome | Should Be 'elevation-required'; $o.runLevel | Should Be 'Highest'; ($o.reasons -join ' ') | Should Match '18:00'
    }
    It 'requires elevation to repair an elevated task that lacks the -Scheduled marker' {
        $old = @((Ex 'daily' 'Highest' $false), (Ex 'weekly' 'Highest' $true '02:00' @('Saturday')))
        $o = Outcome (Get-TaskRegistrationPlan -Desired $want -Existing $old -IsAdmin $false) 'daily'
        $o.outcome | Should Be 'elevation-required'; ($o.reasons -join ' ') | Should Match '-Scheduled'
    }
    It 'requires elevation to turn off an elevated task' {
        $off = @([pscustomobject]@{ kind = 'daily'; enabled = $false; time = '19:00'; day = $null; needsScheduledFlag = $true; wantsHighest = $true })
        (Outcome (Get-TaskRegistrationPlan -Desired $off -Existing $good -IsAdmin $false) 'daily').outcome | Should Be 'elevation-required'
        (Outcome (Get-TaskRegistrationPlan -Desired $off -Existing $good -IsAdmin $true) 'daily').outcome | Should Be 'remove'
    }
    It 'updates a non-elevated task normally and registers new ones with a standard level' {
        $std = @((Ex 'daily' 'Limited' $true '18:00'))
        $u = Outcome (Get-TaskRegistrationPlan -Desired $want -Existing $std -IsAdmin $false) 'daily'
        $u.outcome | Should Be 'update'; $u.runLevel | Should Be 'Limited'
        $c = Outcome (Get-TaskRegistrationPlan -Desired $want -Existing @((Ex 'weekly' 'Limited' $true '02:00' @() $false)) -IsAdmin $false) 'weekly'
        $c.outcome | Should Be 'create'; $c.runLevel | Should Be 'Limited'
    }
    It 'an elevated process raises a standard task to Highest and may update elevated ones' {
        $std = @((Ex 'daily' 'Limited'), (Ex 'weekly' 'Highest' $true '03:00' @('Saturday')))
        $p = Get-TaskRegistrationPlan -Desired $want -Existing $std -IsAdmin $true
        (Outcome $p 'daily').outcome | Should Be 'update'; (Outcome $p 'daily').runLevel | Should Be 'Highest'
        (Outcome $p 'weekly').outcome | Should Be 'update'; (Outcome $p 'weekly').runLevel | Should Be 'Highest'
    }
    It 'detects a task that points at another installation, and a wrong weekday' {
        $x = @((Ex 'daily' 'Limited' $true '19:00' @() $true $false), (Ex 'weekly' 'Limited' $true '02:00' @('Sunday')))
        $p = Get-TaskRegistrationPlan -Desired $want -Existing $x -IsAdmin $false
        ((Outcome $p 'daily').reasons -join ' ') | Should Match 'different script'; ((Outcome $p 'weekly').reasons -join ' ') | Should Match 'Saturday'
    }
    It 'the elevation entry point is one fixed Register command and never a general shell' {
        $src = Get-Content (Join-Path $script:RepoRoot 'src\powershell\Scheduler.ps1') -Raw
        ([regex]::Matches($src, '-Verb RunAs')).Count | Should Be 1
        $src | Should Match "'-Action', 'Register'"
        $src | Should Not Match 'Invoke-Expression|\biex\b|-EncodedCommand'
    }
    It 'saving the same schedule twice leaves registered test tasks untouched' {
        $env:GUARDIAN_ROOT = $root
        Write-JsonFile -Path (Get-GuardianPath 'Config') -Object @{ schedule = @{ daily = @{ enabled = $true; time = '19:00' }; weekly = @{ enabled = $true; day = 'Saturday'; time = '02:00'; shutdownTime = '05:30'; shutdownEnabled = $true } } }
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sched -Action Register -Json -TaskFolder $testFolder | Out-Null
        $r = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sched -Action Register -Json -TaskFolder $testFolder | ConvertFrom-Json
        @($r.report | Where-Object { $_.kind -ne 'dashboard' } | ForEach-Object { $_.outcome } | Select-Object -Unique) | Should Be 'unchanged'
        $d = @($r.tasks | Where-Object { $_.kind -eq 'daily' })[0]
        $d.scheduledFlag | Should Be $true; $d.scriptCurrent | Should Be $true; $d.time | Should Be '19:00'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sched -Action Unregister -Json -TaskFolder $testFolder | Out-Null
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
