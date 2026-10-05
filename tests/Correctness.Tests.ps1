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
Describe 'Report retention' {
    It 'only deletes report-id folders, never links or other names' {
        $rp = Join-Path (Get-GuardianPath 'Reports') 'daily'; New-Item -ItemType Directory -Path $rp -Force | Out-Null
        $old = (Get-Date).AddDays(-400)
        foreach ($n in '2020-01-01', 'precious-notes') { $d = Join-Path $rp $n; New-Item -ItemType Directory -Path $d -Force | Out-Null; Set-Content (Join-Path $d 'x.txt') 'x'; (Get-Item $d).LastWriteTime = $old }
        $target = Join-Path $root 'outside'; New-Item -ItemType Directory -Path $target -Force | Out-Null; Set-Content (Join-Path $target 'keep.txt') 'keep'
        $link = Join-Path $rp '2020-02-02'; cmd /c mklink /J "$link" "$target" | Out-Null
        Invoke-Retention -Config ([pscustomobject]@{ retention = [pscustomobject]@{ reportsDays = 30 } })
        (Test-Path (Join-Path $rp '2020-01-01')) | Should Be $false
        (Test-Path (Join-Path $rp 'precious-notes')) | Should Be $true
        (Test-Path (Join-Path $target 'keep.txt')) | Should Be $true
        cmd /c rmdir "$link" | Out-Null
    }
}
Describe 'Recycle Bin pre-checks' {
    It 'refuses removable drives, non-NTFS volumes, a disabled bin and oversize files' {
        $global:T_F = [pscustomobject]@{ driveType = 2; fileSystem = 'NTFS'; capacityBytes = 100GB; nukeOnDelete = $false; maxCapacityMB = $null }
        Mock -ModuleName Security Get-RecycleVolumeFacts { $global:T_F }
        Test-RecycleBinSafe -Path 'E:\x.bin' -SizeBytes 10 | Should Match 'not a fixed disk'
        $global:T_F = [pscustomobject]@{ driveType = 3; fileSystem = 'exFAT'; capacityBytes = 100GB; nukeOnDelete = $false; maxCapacityMB = $null }
        Test-RecycleBinSafe -Path 'D:\x.bin' -SizeBytes 10 | Should Match 'exFAT'
        $global:T_F = [pscustomobject]@{ driveType = 3; fileSystem = 'NTFS'; capacityBytes = 100GB; nukeOnDelete = $true; maxCapacityMB = $null }
        Test-RecycleBinSafe -Path 'C:\x.bin' -SizeBytes 10 | Should Match 'switched off'
        $global:T_F = [pscustomobject]@{ driveType = 3; fileSystem = 'NTFS'; capacityBytes = 100GB; nukeOnDelete = $false; maxCapacityMB = 1024 }
        Test-RecycleBinSafe -Path 'C:\x.bin' -SizeBytes 2GB | Should Match 'larger than the Recycle Bin'
        Test-RecycleBinSafe -Path 'C:\x.bin' -SizeBytes 5MB | Should BeNullOrEmpty
        Test-RecycleBinSafe -Path '\\server\share\x.bin' -SizeBytes 5 | Should Match 'local drive'
    }
}
Describe 'Shared file lock' {
    It 'is exclusive, is released afterwards, and a stale lock is broken' {
        $f = Join-Path $root 'locked.json'
        $global:T_Ran = $false; $global:T_Held = $false
        Invoke-WithFileLock -Path $f -ScriptBlock { $global:T_Ran = $true; $global:T_Held = (Test-Path "$f.lock") }
        $global:T_Ran | Should Be $true; $global:T_Held | Should Be $true; (Test-Path "$f.lock") | Should Be $false
        Set-Content "$f.lock" 'x'; (Get-Item "$f.lock").LastWriteTime = (Get-Date).AddMinutes(-5)
        $global:T_Ran = $false; Invoke-WithFileLock -Path $f -ScriptBlock { $global:T_Ran = $true }; $global:T_Ran | Should Be $true
    }
    It 'runs anyway when the lock stays held, instead of freezing the caller' {
        $f = Join-Path $root 'held.json'; Set-Content "$f.lock" 'x'
        $global:T_Ran = $false; Invoke-WithFileLock -Path $f -TimeoutMs 300 -ScriptBlock { $global:T_Ran = $true }; $global:T_Ran | Should Be $true
        Remove-Item "$f.lock" -Force
    }
}
Remove-TestRoot $root
