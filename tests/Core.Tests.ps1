. "$PSScriptRoot\Helpers.ps1"
$root = New-TestRoot; Import-Guardian; Initialize-GuardianDirectories

Describe 'Configuration' {
    It 'returns safe defaults when config.json is missing' {
        $c = Get-GuardianConfig
        $c.safety.safeMode | Should Be $true
        $c.schedule.daily.time | Should Be '19:00'
        $c.schedule.weekly.day | Should Be 'Saturday'
        $c.schedule.weekly.time | Should Be '02:00'
        $c.schedule.weekly.shutdownTime | Should Be '05:00'
        $c.ai.enabled | Should Be $false
    }
    It 'merges partial user config over defaults' {
        Write-JsonFile -Path (Get-GuardianPath 'Config') -Object @{ safety = @{ safeMode = $false }; thresholds = @{ cpuPct = 80 } }
        $c = Get-GuardianConfig
        $c.safety.safeMode | Should Be $false
        $c.thresholds.cpuPct | Should Be 80
        $c.thresholds.memoryMB | Should Be 1500
    }
    It 'survives a corrupt config file by falling back to defaults' {
        Set-Content (Get-GuardianPath 'Config') '{ this is not json'
        (Get-GuardianConfig).safety.safeMode | Should Be $true
    }
    It 'config.cleanup is the only source of cleanup settings (a stray cleanup-policy.json is ignored)' {
        Write-JsonFile -Path (Get-GuardianPath 'Config') -Object @{ cleanup = @{ tempFiles = $false } }
        Write-JsonFile -Path (Join-Path (Split-Path (Get-GuardianPath 'Config')) 'cleanup-policy.json') -Object @{ tempFiles = $true; recycleBin = 'always' }
        $c = Get-GuardianConfig
        $c.cleanup.tempFiles | Should Be $false
        $c.cleanup.recycleBin | Should Be 'never'
    }
    It 'the default config carries the network block with deep capture and DNS filtering off' {
        Write-JsonFile -Path (Get-GuardianPath 'Config') -Object @{}
        $c = Get-GuardianConfig
        $c.network.deep.enabled | Should Be $false; $c.network.dnsFiltering.enabled | Should Be $false; $c.network.snapshot.everyMinutes | Should Be 60
    }
}

Describe 'JSON IO and event log' {
    It 'writes JSON atomically and reads it back' {
        $p = Join-Path $root 'x.json'
        Write-JsonFile -Path $p -Object ([ordered]@{ a = 1; list = @(1); empty = @() })
        $o = Read-JsonFile -Path $p
        $o.a | Should Be 1
        @($o.list).Count | Should Be 1
        @(Get-ChildItem $root -Filter '*.tmp').Count | Should Be 0
    }
    It 'skips torn JSONL lines (machine shut down mid-write)' {
        $p = Join-Path $root 'l.jsonl'
        Add-JsonLine -Path $p -Object @{ n = 1 }
        [IO.File]::AppendAllText($p, '{"n": 2, "trunc')
        Add-JsonLine -Path $p -Object @{ n = 3 }
        @(Read-JsonLines -Path $p).Count | Should Be 2
    }
    It 'records events with required fields' {
        Start-RunContext -RunType 'daily'
        $e = Write-GuardianEvent -Category scan -Action 'test:event' -Target 't' -Result success -Reason 'because'
        $e.id | Should Not BeNullOrEmpty
        $e.actor | Should Be 'agent'
        $line = (Read-JsonLines -Path (Get-GuardianPath 'Actions') | Select-Object -Last 1)
        $line.action | Should Be 'test:event'
        @(Test-JsonSchema -Value $line -Schema (Get-Schema 'action-event')).Count | Should Be 0
    }
}

Describe 'Safe command execution' {
    It 'runs a command and captures output' {
        $r = Invoke-GuardianCommand -FilePath "$env:SystemRoot\System32\hostname.exe" -TimeoutSec 20
        $r.ExitCode | Should Be 0
        $r.TimedOut | Should Be $false
        $r.Output | Should Not BeNullOrEmpty
    }
    It 'kills and reports a command that exceeds its timeout' {
        $r = Invoke-GuardianCommand -FilePath "$env:SystemRoot\System32\ping.exe" -Arguments @('-n', '30', '127.0.0.1') -TimeoutSec 2
        $r.TimedOut | Should Be $true
        $r.DurationSec | Should BeLessThan 15
    }
    It 'reports an error for a missing executable instead of throwing' {
        $r = Invoke-GuardianCommand -FilePath 'C:\definitely\not\here.exe' -TimeoutSec 5
        $r.Error | Should Not BeNullOrEmpty
    }
    It 'Invoke-Safely swallows failures, records them, and returns the default' {
        Start-RunContext -RunType 'daily'
        $v = Invoke-Safely 'unit' { throw 'boom' } 'fallback'
        $v | Should Be 'fallback'
        @(Get-RunErrors).Count | Should Be 1
    }
    It 'enforces a single instance per lock name' {
        (Enter-GuardianLock -Name 'unit-test') | Should Be $true
        $j = Start-Job { $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $m = New-Object System.Threading.Mutex($false, "Global\LaptopGuardian-$sid-unit-test"); $m.WaitOne(0) }
        (Receive-Job -Job $j -Wait) | Should Be $false
        Remove-Job $j
        Exit-GuardianLock -Name 'unit-test'
    }
}

Describe 'Misc helpers' {
    It 'produces ISO week ids' {
        Get-IsoWeekId ([datetime]'2027-01-03') | Should Be '2026-W53'
        Get-IsoWeekId ([datetime]'2026-10-03') | Should Be '2026-W40'
    }
}
Remove-TestRoot $root
