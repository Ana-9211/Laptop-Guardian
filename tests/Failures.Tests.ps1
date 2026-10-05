. "$PSScriptRoot\Helpers.ps1"
$root = New-TestRoot; Import-Guardian; Initialize-GuardianDirectories
$cfg = Get-GuardianConfig

Describe 'Windows tooling failures degrade gracefully' {
    It 'Defender status command failing yields available=false, not an exception' {
        function global:Get-MpComputerStatus { throw 'Defender is not running' }
        function global:Get-MpThreatDetection { throw 'nope' }
        try { $s = Get-DefenderStatus; $s.available | Should Be $false; $s.error | Should Match 'not running' }
        finally { Remove-Item function:\Get-MpComputerStatus, function:\Get-MpThreatDetection -ErrorAction SilentlyContinue }
    }
    It 'Defender scan failure is logged and reported' {
        Mock Invoke-JobWithTimeout -ModuleName Defender { [pscustomobject]@{ Ok = $false; TimedOut = $false; Output = $null; Error = 'Access denied' } }
        $r = Invoke-DefenderScan -Type QuickScan -TimeoutSec 30
        $r.result | Should Be 'failed'
        $r.error | Should Match 'denied'
        (Read-JsonLines (Get-GuardianPath 'Actions') | Where-Object { $_.action -eq 'defender:QuickScan-finished' -and $_.result -eq 'failure' }) | Should Not BeNullOrEmpty
    }
    It 'Defender scan timeout is reported as timeout' {
        Mock Invoke-JobWithTimeout -ModuleName Defender { [pscustomobject]@{ Ok = $false; TimedOut = $true; Output = $null; Error = 'timeout' } }
        (Invoke-DefenderScan -Type QuickScan -TimeoutSec 3).result | Should Be 'timeout'
    }
    It 'the real timeout helper kills a runaway job' {
        $r = Invoke-JobWithTimeout -TimeoutSec 2 -ScriptBlock { Start-Sleep -Seconds 60 }
        $r.TimedOut | Should Be $true
    }
    It 'Defender signature update failure is logged, not thrown' {
        Mock Invoke-JobWithTimeout -ModuleName Defender { [pscustomobject]@{ Ok = $false; TimedOut = $false; Output = $null; Error = 'No network' } }
        { Update-DefenderSignatures } | Should Not Throw
    }
    It 'SFC and DISM need admin: reported as requires-admin when not elevated' {
        function global:Test-IsAdmin { $false }
        try { (Invoke-SfcVerify).result | Should Be 'requires-admin'; (Invoke-DismCheck).result | Should Be 'requires-admin' } finally { Remove-Item function:\Test-IsAdmin }
        Import-Guardian
    }
    It 'DISM failure (tool error) is captured' {
        function global:Test-IsAdmin { $true }
        function global:Invoke-GuardianCommand { [pscustomobject]@{ ExitCode = 1; Output = 'Error: 0x800f081f'; TimedOut = $false; Error = $null; DurationSec = 1 } }
        try { (Invoke-DismCheck -Mode CheckHealth).result | Should Be 'failed' } finally { Remove-Item function:\Test-IsAdmin, function:\Invoke-GuardianCommand }
        Import-Guardian
    }
    It 'SFC timeout is captured and recorded as incomplete data' {
        function global:Test-IsAdmin { $true }
        function global:Invoke-GuardianCommand { [pscustomobject]@{ ExitCode = $null; Output = ''; TimedOut = $true; Error = $null; DurationSec = 1800 } }
        try { $r = Invoke-SfcVerify; $r.result | Should Be 'timeout'; $r.ran | Should Be $false } finally { Remove-Item function:\Test-IsAdmin, function:\Invoke-GuardianCommand }
        Import-Guardian
    }
    It 'SFC clean and violation outputs are parsed' {
        function global:Test-IsAdmin { $true }
        function global:Invoke-GuardianCommand { [pscustomobject]@{ ExitCode = 0; Output = 'Windows Resource Protection did not find any integrity violations.'; TimedOut = $false; Error = $null; DurationSec = 1 } }
        try { (Invoke-SfcVerify).result | Should Be 'clean' } finally { Remove-Item function:\Test-IsAdmin, function:\Invoke-GuardianCommand }
        Import-Guardian
        function global:Test-IsAdmin { $true }
        function global:Invoke-GuardianCommand { [pscustomobject]@{ ExitCode = 0; Output = 'Windows Resource Protection found integrity violations but was unable to fix some of them.'; TimedOut = $false; Error = $null; DurationSec = 1 } }
        try { (Invoke-SfcVerify).result | Should Be 'violations-unrepaired' } finally { Remove-Item function:\Test-IsAdmin, function:\Invoke-GuardianCommand }
        Import-Guardian
    }
    It 'event log access failure does not abort Get-WindowsHealth' {
        function global:Get-WinEvent { throw 'Access is denied' }
        try { $h = Get-WindowsHealth; $h.eventErrors.system | Should Be 0 } finally { Remove-Item function:\Get-WinEvent }
    }
    It 'network unavailable: probes fail without throwing' {
        function global:Test-Connection { throw 'no network' }
        function global:Get-NetAdapter { throw 'no adapters' }
        try { $n = Get-NetworkHealth; $n.internet | Should Be $false } finally { Remove-Item function:\Test-Connection, function:\Get-NetAdapter -ErrorAction SilentlyContinue }
    }
    It 'firewall query failure is reported as a problem' {
        function global:Get-NetFirewallProfile { throw 'service stopped' }
        try { (Get-FirewallStatus).problems[0] | Should Match 'Could not read' } finally { Remove-Item function:\Get-NetFirewallProfile }
    }
    It 'a collector that throws is recorded and the run continues' {
        Start-RunContext -RunType 'daily'
        $x = Invoke-Safely 'a' { throw 'permission denied' } $null
        $y = Invoke-Safely 'b' { 42 } 0
        $x | Should BeNullOrEmpty; $y | Should Be 42
        @(Get-RunErrors).Count | Should Be 1
    }
}

Describe 'Full pipeline with everything broken still yields a report' {
    It 'Invoke-Collection + New-RunReport survive failing collectors (no admin, no Defender, no network)' {
        function global:Get-MpComputerStatus { throw 'x' }
        function global:Test-Connection { throw 'x' }
        function global:Get-WinEvent { throw 'Access is denied' }
        function global:Get-NetFirewallProfile { throw 'x' }
        try {
            Start-RunContext -RunType 'daily'
            $ctx = Invoke-Collection -Config $cfg -Type daily -SkipDefenderScan -NoAI -Fast
            $rep = New-RunReport -Config $cfg -Ctx $ctx -Type 'daily' -Id '2026-01-01' -Started (Get-Date) -Events (Get-RunEvents) -Errors (Get-RunErrors) -Status 'partial'
            $rep.sections.system.ram.totalGB | Should BeGreaterThan 0
            $rep.sections.defender.available | Should Be $false
            @(Test-JsonSchema -Value ($rep | ConvertTo-Json -Depth 14 | ConvertFrom-Json) -Schema (Get-Schema 'report')).Count | Should Be 0
        } finally { Remove-Item function:\Get-MpComputerStatus, function:\Test-Connection, function:\Get-WinEvent, function:\Get-NetFirewallProfile -ErrorAction SilentlyContinue }
    }
}

Describe 'Permission denied' {
    It 'recycling an inaccessible/missing file throws a clear error' { { Move-ToRecycleBin -Path "$root\nope.txt" } | Should Throw }
    It 'file hashing a locked file returns null rather than throwing' {
        $f = Join-Path $root 'locked.bin'; Set-Content $f 'abc'; $fs = [IO.File]::Open($f, 'Open', 'Read', 'None')
        try { Get-FileHashCached -Path $f -Size 5 -MTimeTicks 1 -Cache @{} | Should BeNullOrEmpty } finally { $fs.Dispose() }
    }
    It 'bridge kill script refuses protected processes' {
        $r = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $script:RepoRoot 'src\powershell\Actions\Stop-GuardianProcess.ps1') -ProcessId (Get-Process lsass).Id -Name 'lsass' -Path 'C:\Windows\System32\lsass.exe' | ConvertFrom-Json
        $r.ok | Should Be $false
        $r.message | Should Match 'protected|verify'
    }
    It 'bridge recycle script refuses protected paths' {
        $r = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $script:RepoRoot 'src\powershell\Actions\Move-ToRecycleBin.ps1') -Path 'C:\Windows\notepad.exe' | ConvertFrom-Json
        $r.ok | Should Be $false
    }
}
Remove-TestRoot $root
