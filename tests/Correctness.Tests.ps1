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
Describe 'Audit events match the action-event schema' {
    It 'a remediation event with structured data validates' {
        $e = Write-GuardianEvent -Category remediation -Action 'remediation:service.disable' -Target 'name=Fax' -Actor user -Data ([ordered]@{ subject = 'service:Fax'; verified = $true; undo = [ordered]@{ action = 'service.enable'; params = [ordered]@{ name = 'Fax' } } })
        $line = (Read-JsonLines (Get-GuardianPath 'Actions') | Where-Object { $_.id -eq $e.id } | Select-Object -First 1)
        @(Test-JsonSchema -Value $line -Schema (Get-Schema 'action-event')).Count | Should Be 0
        $line.data.subject | Should Be 'service:Fax'
    }
}

Describe 'Installed copy versus development checkout' {
    # The program files are copied to a temp "Program Files" with an install.json; a child PowerShell loads THAT copy.
    function New-FakeInstall {
        $base = Join-Path $env:TEMP ('lg-inst-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        $prog = Join-Path $base 'program'; $data = Join-Path $base 'data'; $elev = Join-Path $base 'elevated'
        New-Item -ItemType Directory -Path "$prog\src" -Force | Out-Null
        Copy-Item (Join-Path $script:RepoRoot 'src\powershell') "$prog\src\powershell" -Recurse
        [pscustomobject]@{ base = $base; prog = $prog; data = $data; elev = $elev }
    }
    function Invoke-InFakeInstall($fi, [string]$Body) {
        $cmd = "`$env:GUARDIAN_ROOT = 'C:\decoy-from-environment';. '$($fi.prog)\src\powershell\Common\Load.ps1'; $Body"
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $cmd 2>&1 | Out-String
    }
    It 'takes every folder from install.json, ignores GUARDIAN_ROOT, and defaults to port 7878' {
        $fi = New-FakeInstall
        try {
            ([pscustomobject]@{ dataRoot = $fi.data; elevatedDir = $fi.elev } | ConvertTo-Json) | Set-Content -LiteralPath (Join-Path $fi.prog 'install.json') -Encoding UTF8
            $o = Invoke-InFakeInstall $fi "[pscustomobject]@{ data = (Get-GuardianDataRoot); code = (Get-GuardianCodeRoot); port = (Get-DefaultBridgePort); cfg = (Get-GuardianPath 'Config'); results = (Get-GuardianPath 'ActionResults'); audit = (Get-GuardianPath 'ElevatedAudit'); backups = (Get-GuardianPath 'ElevatedBackups'); roots = @(Get-GuardianRoots) } | ConvertTo-Json -Compress"
            $j = $o | ConvertFrom-Json
            $j.data | Should Be $fi.data
            $j.code | Should Be $fi.prog
            $j.port | Should Be 7878
            $j.cfg | Should Be (Join-Path $fi.data 'config\config.json')
            $j.results | Should Be (Join-Path $fi.elev 'results')
            $j.audit | Should Be (Join-Path $fi.elev 'audit\actions.jsonl')
            $j.backups | Should Be (Join-Path $fi.elev 'backups')
            (@($j.roots) -contains $fi.data -and @($j.roots) -contains $fi.prog) | Should Be $true
        } finally { Remove-Item $fi.base -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It 'refuses to guess when install.json is damaged or incomplete' {
        $fi = New-FakeInstall
        try {
            Set-Content -LiteralPath (Join-Path $fi.prog 'install.json') '{ nope'
            (Invoke-InFakeInstall $fi "Get-GuardianDataRoot") | Should Match 'damaged'
            Set-Content -LiteralPath (Join-Path $fi.prog 'install.json') ('{ "dataRoot": "relative" , "elevatedDir": "' + ($fi.elev -replace '\\', '\\\\') + '" }')
            (Invoke-InFakeInstall $fi "Get-GuardianDataRoot") | Should Match 'dataRoot'
        } finally { Remove-Item $fi.base -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It 'a development checkout keeps everything under the data folder, with port 7879' {
        (Get-DefaultBridgePort) | Should Be 7879
        (Get-GuardianPath 'ActionResults') | Should Be (Join-Path (Get-GuardianRoot) 'data\state\action-results')
        (Get-GuardianPath 'ElevatedAudit') | Should Be (Get-GuardianPath 'Actions')
    }
}

Describe 'UTF-8 on the pipe' {
    It 'loading Common\Load.ps1 puts stdout and stdin on UTF-8 without a byte-order mark' {
        $load = Join-Path $script:RepoRoot 'src\powershell\Common\Load.ps1'
        $o = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ". '$load'; ([Console]::OutputEncoding.WebName + '|' + [Console]::OutputEncoding.GetPreamble().Length + '|' + [Console]::InputEncoding.WebName)" 2>&1 | Out-String
        $o.Trim() | Should Be 'utf-8|0|utf-8'
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
