. "$PSScriptRoot\Helpers.ps1"
$root = New-TestRoot; Import-Guardian; Initialize-GuardianDirectories

Describe 'ISO week id (Thursday rule)' {
    It 'handles year boundaries' {
        Get-IsoWeekId ([datetime]'2025-12-29') | Should Be '2026-W01'
        Get-IsoWeekId ([datetime]'2026-01-01') | Should Be '2026-W01'
        Get-IsoWeekId ([datetime]'2021-01-03') | Should Be '2020-W53'
        Get-IsoWeekId ([datetime]'2024-12-30') | Should Be '2025-W01'
        Get-IsoWeekId ([datetime]'2026-10-05') | Should Be '2026-W41'
    }
}

Describe 'Overnight shutdown window' {
    It 'puts an earlier shutdown time on the next day once the run has started' {
        $evening = [datetime]'2026-10-03 23:30'
        (Get-ShutdownDateTime -TimeOfDay '05:00' -StartTime '23:00' -Now $evening) | Should Be ([datetime]'2026-10-04 05:00')
        $after = [datetime]'2026-10-04 01:30'
        (Get-ShutdownDateTime -TimeOfDay '05:00' -StartTime '23:00' -Now $after) | Should Be ([datetime]'2026-10-04 05:00')
    }
    It 'keeps a same-day window on the same day' {
        (Get-ShutdownDateTime -TimeOfDay '05:00' -StartTime '02:00' -Now ([datetime]'2026-10-03 02:10')) | Should Be ([datetime]'2026-10-03 05:00')
    }
}

Describe 'DISM result order' {
    It 'reports not-repairable, not repairable' {
        function global:Test-IsAdmin { $true }
        function global:Invoke-GuardianCommand { [pscustomobject]@{ TimedOut = $false; Error = $null; Output = 'The component store is not repairable.'; ExitCode = 0 } }
        try { (Invoke-DismCheck -Mode CheckHealth).result | Should Be 'not-repairable' } finally { Remove-Item function:\Test-IsAdmin, function:\Invoke-GuardianCommand -ErrorAction SilentlyContinue }
    }
}

Describe 'Defender threats' {
    It 'counts only unresolved detections once per threat and resolves the name' {
        function global:Get-MpComputerStatus { [pscustomobject]@{ AMServiceEnabled = $true; RealTimeProtectionEnabled = $true; AntivirusSignatureVersion = '1'; AntivirusSignatureLastUpdated = (Get-Date); QuickScanEndTime = (Get-Date); FullScanEndTime = (Get-Date); IsTamperProtected = $true } }
        function global:Get-MpThreatDetection {
            $t = (Get-Date).AddDays(-1)
            @(
                [pscustomobject]@{ ThreatID = 10; ThreatStatusID = 3; InitialDetectionTime = $t }   # quarantined
                [pscustomobject]@{ ThreatID = 11; ThreatStatusID = 4; InitialDetectionTime = $t }   # removed
                [pscustomobject]@{ ThreatID = 12; ThreatStatusID = 1; InitialDetectionTime = $t }   # detected, unresolved
                [pscustomobject]@{ ThreatID = 12; ThreatStatusID = 1; InitialDetectionTime = $t.AddHours(-1) }  # duplicate
                [pscustomobject]@{ ThreatID = 13; ThreatStatusID = 102; InitialDetectionTime = $t } # quarantine failed
            )
        }
        function global:Get-MpThreat { @([pscustomobject]@{ ThreatID = 12; ThreatName = 'Trojan:Win32/Test' }) }
        try {
            $s = Get-DefenderStatus
            $s.threats | Should Be 2
            (@($s.scan.threats | ForEach-Object { $_.name }) -contains 'Trojan:Win32/Test') | Should Be $true
            (@($s.scan.threats | ForEach-Object { $_.name }) -contains 'Threat ID 13') | Should Be $true
        } finally { Remove-Item function:\Get-MpComputerStatus, function:\Get-MpThreatDetection, function:\Get-MpThreat -ErrorAction SilentlyContinue }
    }
    It 'reports a quick scan still running at the deadline as running when asked to leave it' {
        Mock Invoke-JobWithTimeout -ModuleName Defender { [pscustomobject]@{ Ok = $false; TimedOut = $true; Output = $null; Error = 'timeout' } }
        (Invoke-DefenderScan -Type QuickScan -TimeoutSec 3 -LeaveRunning).result | Should Be 'running'
    }
}

Describe 'Policy entries that are switched off' {
    It 'are ignored by every list, not only the blacklist' {
        $pol = [pscustomobject]@{
            blacklist = @(); ignored = @()
            whitelist = @([pscustomobject]@{ id = 'w1'; name = 'Thing.exe'; enabled = $false })
        }
        (Find-PolicyMatch -Policy $pol -Name 'Thing.exe' -Path 'C:\x\Thing.exe').list | Should Be 'none'
        $pol.whitelist[0].enabled = $true
        (Find-PolicyMatch -Policy $pol -Name 'Thing.exe' -Path 'C:\x\Thing.exe').list | Should Be 'whitelist'
    }
}

Describe 'Recommendation sweep' {
    It 'does not resolve the weekly file review, and drops a stale PID stop command' {
        $weekly = Add-RecommendationItem -Kind 'storage' -Key 'weekly-file-candidates' -Title 'files'
        $proc = Add-RecommendationItem -Kind 'process' -Key 'p1' -Title 'proc'
        $proc.stopCommand = [pscustomobject]@{ command = 'Stop-Process -Id 99999' }
        $weekly.lastSeen = (Get-Date).AddDays(-5).ToString('o'); $proc.lastSeen = (Get-Date).AddDays(-5).ToString('o')
        Save-RecommendationStore @($weekly, $proc)
        $out = Update-RecommendationStore -Fresh @() -SweepKinds @('process', 'storage')
        ($out | Where-Object { $_.id -eq $weekly.id }).status | Should Be 'open'
        ($out | Where-Object { $_.id -eq $proc.id }).status | Should Be 'resolved'
        ($out | Where-Object { $_.id -eq $proc.id }).stopCommand | Should BeNullOrEmpty
    }
}
Remove-TestRoot $root
