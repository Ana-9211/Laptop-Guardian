. "$PSScriptRoot\Helpers.ps1"
# Every system touchpoint of the remediation module is mocked: nothing here stops a process, changes a service, task, startup
# entry, firewall profile or Defender, recycles a real file, flushes DNS, or starts Revo.
$root = New-TestRoot; Import-Guardian; Initialize-GuardianDirectories
Import-Module (Join-Path $script:RepoRoot 'src\powershell\Actions\Remediation.psm1') -Force -DisableNameChecking
$M = 'Remediation'
function Run($action, $params, $mode = 'Execute') { Invoke-GuardianRemediation -Action $action -Mode $mode -Params $params }
function First($r) { @($r.errors)[0] }

Describe 'Action catalog' {
    $cat = Get-ActionCatalog
    It 'has unique ids and every action has a handler, summary, consequences and undo text' {
        @($cat.actions | ForEach-Object { $_.id } | Select-Object -Unique).Count | Should Be @($cat.actions).Count
        foreach ($a in $cat.actions) { $a.summary | Should Not BeNullOrEmpty; $a.consequences | Should Not BeNullOrEmpty; $a.undo | Should Not BeNullOrEmpty; $a.label | Should Not BeNullOrEmpty }
        foreach ($a in @($cat.actions | Where-Object { -not ($_.PSObject.Properties.Name -contains 'handler') })) { (Run $a.id @{} 'Validate').errors -join '' | Should Not Match 'not an allowlisted|No handler' }
    }
    It 'every undoId points at another catalog action' {
        foreach ($a in @($cat.actions | Where-Object { $_.PSObject.Properties.Name -contains 'undoId' })) { (Get-ActionSpec -Id $a.undoId) | Should Not BeNullOrEmpty }
    }
    It 'no action exposes a parameter that could carry a command' {
        foreach ($a in $cat.actions) { foreach ($p in $a.params.PSObject.Properties.Name) { $p | Should Not Match '(?i)^(command|script|args|arguments|cmd|shell|expression|exe|executable)$' } }
    }
    It 'every pattern compiles and rejects shell metacharacters used as values' {
        foreach ($n in $cat.patterns.PSObject.Properties.Name) { { [regex]::new($cat.patterns.$n) } | Should Not Throw }
        'a; calc' | Should Not Match $cat.patterns.processName
        'x`$(calc)' | Should Not Match $cat.patterns.serviceName
    }
}

Describe 'Parameter validation and allowlist' {
    It 'refuses an unknown action, including AI-style command text' {
        (Run 'shell.run' @{ command = 'calc' }).ok | Should Be $false
        (First (Run 'Stop-Process -Id 4' @{})) | Should Match 'not an allowlisted'
    }
    It 'refuses unexpected and malformed parameters' {
        (First (Run 'process.stop' @{ pid = 1234; name = 'a'; command = 'calc' })) | Should Match "Unexpected parameter 'command'"
        (First (Run 'process.stop' @{ pid = 'abc'; name = 'a' })) | Should Match 'invalid format'
        (First (Run 'process.stop' @{ pid = 1234; name = 'a; calc' })) | Should Match 'invalid format'
        (First (Run 'firewall.enable-profile' @{ profile = 'Everything' })) | Should Match 'must be one of'
        (First (Run 'file.recycle' @{ path = 'relative\file.txt' })) | Should Match 'invalid format'
        (First (Run 'file.recycle' @{ path = '\\server\share\x.txt' })) | Should Match 'invalid format'
        (First (Run 'service.disable' @{})) | Should Match "Missing parameter 'name'"
    }
}

Describe 'process.stop' {
    $live = { [pscustomobject]@{ Name = 'updater'; Path = 'C:\Users\u\AppData\Local\Temp\updater.exe'; StartTime = '2026-10-05T10:00:00'; CommandLine = '"C:\Users\u\AppData\Local\Temp\updater.exe"' } }
    $p = @{ pid = 4242; name = 'updater'; path = 'C:\Users\u\AppData\Local\Temp\updater.exe'; startTime = '2026-10-05T10:00:00' }
    It 'validates a live, unprotected process and returns its identity' {
        Mock -ModuleName $M Get-LiveProcessInfo $live
        $r = Run 'process.stop' $p 'Validate'; $r.ok | Should Be $true; $r.identityKey | Should Match '4242'
    }
    It 'refuses when the process is gone' { Mock -ModuleName $M Get-LiveProcessInfo { $null }; (First (Run 'process.stop' $p)) | Should Match 'no longer running' }
    It 'refuses PID reuse: same PID, different program' {
        Mock -ModuleName $M Get-LiveProcessInfo { [pscustomobject]@{ Name = 'notepad'; Path = 'C:\Windows\notepad.exe'; StartTime = '2026-10-05T11:00:00'; CommandLine = '' } }
        (First (Run 'process.stop' $p)) | Should Match 'PID was reused'
    }
    It 'refuses PID reuse: same name, started at a different time' {
        Mock -ModuleName $M Get-LiveProcessInfo { [pscustomobject]@{ Name = 'updater'; Path = 'C:\Users\u\AppData\Local\Temp\updater.exe'; StartTime = '2026-10-05T12:00:00'; CommandLine = '' } }
        (First (Run 'process.stop' $p)) | Should Match 'different time'
    }
    It 'refuses when the executable path differs from the one reviewed' {
        Mock -ModuleName $M Get-LiveProcessInfo { [pscustomobject]@{ Name = 'updater'; Path = 'C:\Other\updater.exe'; StartTime = '2026-10-05T10:00:00'; CommandLine = '' } }
        (First (Run 'process.stop' $p)) | Should Match 'differs'
    }
    It 'fails closed when the live path cannot be read' {
        Mock -ModuleName $M Get-LiveProcessInfo { [pscustomobject]@{ Name = 'updater'; Path = $null; StartTime = '2026-10-05T10:00:00'; CommandLine = '' } }
        (First (Run 'process.stop' $p)) | Should Match 'cannot read'
    }
    foreach ($n in 'explorer', 'lsass', 'MsMpEng', 'svchost', 'powershell', 'csrss', 'SecurityHealthService', 'node') {
        It "never stops protected process '$n', even when everything else matches" {
            $global:T_Name = $n
            # Windows' own names are protected when they run from the Windows folder; dev tools and security software stay protected by name anywhere.
            $global:T_Path = if ($n -in (Get-WindowsCoreProcessNames)) { "$env:SystemRoot\System32\$n.exe" } else { "C:\Program Files\X\$n.exe" }
            Mock -ModuleName $M Get-LiveProcessInfo { [pscustomobject]@{ Name = $global:T_Name; Path = $global:T_Path; StartTime = 't'; CommandLine = '' } }
            $r = Run 'process.stop' @{ pid = 4242; name = $n }; $r.ok | Should Be $false; (First $r) | Should Match 'Protected'
        }
    }
    It 'lets a lookalike of a Windows process through validation, flagged suspicious with a warning (the dashboard then demands an extra acknowledgement)' {
        Mock -ModuleName $M Get-LiveProcessInfo { [pscustomobject]@{ Name = 'svchost'; Path = 'C:\Users\u\AppData\Local\Temp\svchost.exe'; StartTime = 't'; CommandLine = '' } }
        Mock -ModuleName Security Get-ImageTrust { [pscustomobject]@{ valid = $false; microsoft = $false } }
        $r = Run 'process.stop' @{ pid = 4242; name = 'svchost' } 'Validate'
        $r.ok | Should Be $true; $r.details.suspicious | Should Be $true; (@($r.warnings) -join ' ') | Should Match 'Suspicious'
    }
    It 'never stops a binary under the Windows directory' {
        Mock -ModuleName $M Get-LiveProcessInfo { [pscustomobject]@{ Name = 'foo'; Path = "$env:SystemRoot\System32\foo.exe"; StartTime = 't'; CommandLine = '' } }
        (First (Run 'process.stop' @{ pid = 4242; name = 'foo' })) | Should Match 'Protected'
    }
    It 'never stops a process that belongs to Laptop Guardian itself' {
        $env:GUARDIAN_ROOT = $root
        Mock -ModuleName $M Get-LiveProcessInfo { [pscustomobject]@{ Name = 'helper'; Path = 'C:\Tools\helper.exe'; StartTime = 't'; CommandLine = "C:\Tools\helper.exe $env:GUARDIAN_ROOT\src\x.js" } }
        (First (Run 'process.stop' @{ pid = 4242; name = 'helper' })) | Should Match 'Laptop Guardian itself'
    }
    It 'refuses reserved PIDs' { (Run 'process.stop' @{ pid = 4; name = 'system' }).ok | Should Be $false }
    It 'stops the process, verifies it is gone, and reports a relaunch' {
        $global:T_Calls = 0
        Mock -ModuleName $M Get-LiveProcessInfo { $global:T_Calls++; if ($global:T_Calls -le 2) { [pscustomobject]@{ Name = 'updater'; Path = 'C:\Users\u\AppData\Local\Temp\updater.exe'; StartTime = '2026-10-05T10:00:00'; CommandLine = '' } } else { $null } }
        Mock -ModuleName $M Stop-Process { } ; Mock -ModuleName $M Get-Process { @() }
        $r = Run 'process.stop' $p; $r.ok | Should Be $true; $r.verified | Should Be $true
        Assert-MockCalled -ModuleName $M Stop-Process -Exactly 1
    }
    It 'reports failure when the process is still running after the request' {
        Mock -ModuleName $M Get-LiveProcessInfo $live; Mock -ModuleName $M Stop-Process { }
        $r = Run 'process.stop' $p; $r.ok | Should Be $false; (First $r) | Should Match 'still running'
    }
    It 'asks for elevation when Windows denies access' {
        Mock -ModuleName $M Get-LiveProcessInfo $live; Mock -ModuleName $M Stop-Process { throw 'Access is denied' }
        $r = Run 'process.stop' $p; $r.needsElevation | Should Be $true
    }
    It 'does nothing when the identity changed between review and action' {
        $global:T_Stops = 0; Mock -ModuleName $M Get-LiveProcessInfo $live; Mock -ModuleName $M Stop-Process { $global:T_Stops++ }
        $x = $p.Clone(); $x['_identityKey'] = 'something|else'
        $r = Run 'process.stop' $x; $r.ok | Should Be $false; (First $r) | Should Match 'identity mismatch'
        $global:T_Stops | Should Be 0
    }
    It 'Validate mode never stops anything' {
        $global:T_Stops = 0; Mock -ModuleName $M Get-LiveProcessInfo $live; Mock -ModuleName $M Stop-Process { $global:T_Stops++ }
        (Run 'process.stop' $p 'Validate').ok | Should Be $true
        $global:T_Stops | Should Be 0
    }
}

Describe 'startup.disable / startup.enable' {
    $reg = @{ kind = 'registry'; name = 'Updater'; location = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' }
    It 'refuses locations that are not standard Windows startup locations' {
        (Run 'startup.disable' @{ kind = 'registry'; name = 'x'; location = 'HKCU:\Software\Foo\Run' }).ok | Should Be $false
        (Run 'startup.disable' @{ kind = 'folder'; name = 'x'; location = 'C:\Users\u\Documents' }).ok | Should Be $false
        (Run 'startup.disable' @{ kind = 'folder'; name = 'x'; location = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' }).ok | Should Be $false
    }
    It 'refuses when the entry no longer exists' { Mock -ModuleName $M Test-StartupEntryExists { $null }; (First (Run 'startup.disable' $reg)) | Should Match 'no longer exists' }
    It 'disables via the StartupApproved flag, verifies it, and offers re-enable as undo' {
        $global:T_State = 2
        Mock -ModuleName $M Test-StartupEntryExists { 'Updater' }
        Mock -ModuleName $M Get-StartupApprovedByte { $global:T_State }
        Mock -ModuleName $M Set-StartupApprovedByte { param($ApprovedKey, $ValueName, $Enabled) $global:T_State = $(if ($Enabled) { 2 } else { 3 }) }
        $r = Run 'startup.disable' $reg; $r.ok | Should Be $true; $r.verified | Should Be $true
        $r.undo.action | Should Be 'startup.enable'; $r.undo.params.name | Should Be 'Updater'
        (First (Run 'startup.disable' $reg)) | Should Match 'already disabled'
        (Run 'startup.enable' $reg).ok | Should Be $true
        $global:T_State | Should Be 2
    }
    It 'fails honestly when Windows did not record the change' {
        Mock -ModuleName $M Test-StartupEntryExists { 'Updater' }; Mock -ModuleName $M Get-StartupApprovedByte { 2 }; Mock -ModuleName $M Set-StartupApprovedByte { }
        $r = Run 'startup.disable' $reg; $r.ok | Should Be $false; (First $r) | Should Match 'did not record'
    }
    It 'needs elevation for all-users (HKLM) entries when not elevated' {
        Mock -ModuleName $M Test-StartupEntryExists { 'Updater' }; Mock -ModuleName $M Get-StartupApprovedByte { 2 }; Mock -ModuleName $M Test-AdminNow { $false }
        $r = Run 'startup.disable' @{ kind = 'registry'; name = 'Updater'; location = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run' }
        $r.ok | Should Be $false; $r.needsElevation | Should Be $true
    }
}

Describe 'task.disable / task.enable' {
    $t = @{ taskPath = '\Vendor\'; taskName = 'Updater' }
    It 'never touches Windows or Laptop Guardian tasks' {
        (First (Run 'task.disable' @{ taskPath = '\Microsoft\Windows\Defrag\'; taskName = 'ScheduledDefrag' })) | Should Match 'Protected'
        (First (Run 'task.disable' @{ taskPath = '\LaptopGuardian\'; taskName = 'Daily Audit' })) | Should Match 'Protected'
        (First (Run 'task.enable' @{ taskPath = '\microsoft\'; taskName = 'x' })) | Should Match 'Protected'
    }
    It 'refuses a task that does not exist' { Mock -ModuleName $M Get-TaskForAction { $null }; (First (Run 'task.disable' $t)) | Should Match 'no longer exists' }
    It 'disables, verifies and offers re-enable' {
        $global:T_TS = 'Ready'
        Mock -ModuleName $M Get-TaskForAction { [pscustomobject]@{ State = $global:T_TS; Principal = [pscustomobject]@{ RunLevel = 'Limited'; UserId = 'me' } } }
        Mock -ModuleName $M Disable-ScheduledTask { $global:T_TS = 'Disabled' }
        $r = Run 'task.disable' $t; $r.ok | Should Be $true; $r.verified | Should Be $true; $r.undo.action | Should Be 'task.enable'
        (First (Run 'task.disable' $t)) | Should Match 'already disabled'
    }
    It 'needs elevation for system or elevated tasks' {
        Mock -ModuleName $M Get-TaskForAction { [pscustomobject]@{ State = 'Ready'; Principal = [pscustomobject]@{ RunLevel = 'Highest'; UserId = 'SYSTEM' } } }; Mock -ModuleName $M Test-AdminNow { $false }
        (Run 'task.disable' $t).needsElevation | Should Be $true
    }
}

Describe 'service.disable / service.enable' {
    $svc = { param($Name) [pscustomobject]@{ Name = $Name; StartMode = 'Auto'; State = 'Running'; PathName = '"C:\Program Files\Vendor\svc.exe"'; ServiceType = 'Own Process' } }
    It 'never changes protected Windows and security services' {
        foreach ($n in 'WinDefend', 'mpssvc', 'wuauserv', 'RpcSs', 'EventLog', 'Dnscache') { (First (Run 'service.disable' @{ name = $n })) | Should Match 'Protected' }
    }
    It 'never changes services that run from the Windows directory or inside svchost' {
        Mock -ModuleName $M Get-ServiceForAction { [pscustomobject]@{ Name = 'Foo'; StartMode = 'Auto'; State = 'Running'; PathName = "$env:SystemRoot\System32\svchost.exe -k netsvcs"; ServiceType = 'Share Process' } }
        (First (Run 'service.disable' @{ name = 'Foo' })) | Should Match 'part of Windows'
        Mock -ModuleName $M Get-ServiceForAction { [pscustomobject]@{ Name = 'Foo'; StartMode = 'Auto'; State = 'Running'; PathName = "$env:SystemRoot\foo.exe"; ServiceType = 'Own Process' } }
        (First (Run 'service.disable' @{ name = 'Foo' })) | Should Match 'part of Windows'
    }
    It 'never changes drivers' {
        Mock -ModuleName $M Get-ServiceForAction { [pscustomobject]@{ Name = 'Foo'; StartMode = 'Auto'; State = 'Running'; PathName = 'C:\Drivers\foo.sys'; ServiceType = 'Kernel Driver' } }
        (First (Run 'service.disable' @{ name = 'Foo' })) | Should Match 'drivers'
    }
    It 'needs elevation when not administrator' { Mock -ModuleName $M Get-ServiceForAction $svc; Mock -ModuleName $M Test-AdminNow { $false }; (Run 'service.disable' @{ name = 'Vendor' }).needsElevation | Should Be $true }
    It 'disables, verifies, and records the previous start type for undo' {
        $global:T_Mode = 'Auto'
        Mock -ModuleName $M Test-AdminNow { $true }
        Mock -ModuleName $M Get-ServiceForAction { [pscustomobject]@{ Name = 'Vendor'; StartMode = $global:T_Mode; State = 'Running'; PathName = '"C:\Program Files\Vendor\svc.exe"'; ServiceType = 'Own Process' } }
        Mock -ModuleName $M Set-Service { param($Name, $StartupType) $global:T_Mode = $StartupType }
        $r = Run 'service.disable' @{ name = 'Vendor' }; $r.ok | Should Be $true; $r.verified | Should Be $true
        $r.undo.action | Should Be 'service.enable'; $r.undo.params.startMode | Should Be 'Automatic'
        (Run 'service.enable' @{ name = 'Vendor'; startMode = 'Automatic' }).ok | Should Be $true
        $global:T_Mode | Should Be 'Automatic'
    }
}

Describe 'file.recycle' {
    $dir = Join-Path $env:TEMP ('lg-rem-' + [guid]::NewGuid().ToString('N').Substring(0, 8)); New-Item -ItemType Directory -Path $dir | Out-Null
    $f = Join-Path $dir 'old-installer.exe'; Set-Content $f 'x'
    $fi = Get-Item $f
    function Set-Candidates($class) {
        Write-JsonFile -Path (Get-GuardianPath 'LatestFiles') -Object @{ generatedAt = (Get-IsoNow); candidates = @(@{ id = 'c1'; path = $f; classification = $class; lastModified = $fi.LastWriteTime.ToString('o'); whyFlagged = @('Old installer') }) }
    }
    It 'refuses protected locations, wildcards, UNC paths and Guardian files' {
        (First (Run 'file.recycle' @{ path = "$env:SystemRoot\notepad.exe" })) | Should Match 'Protected path'
        (First (Run 'file.recycle' @{ path = 'C:\Program Files\X\x.dll' })) | Should Match 'Protected path'
        (First (Run 'file.recycle' @{ path = "$env:ProgramData\x.dat" })) | Should Match 'Protected path'
        (First (Run 'file.recycle' @{ path = "$env:USERPROFILE" })) | Should Match 'Protected path'
        (Run 'file.recycle' @{ path = "$dir\*.exe" }).ok | Should Be $false
        $env:GUARDIAN_ROOT = $root
        (First (Run 'file.recycle' @{ path = (Join-Path $root 'data\actions\actions.jsonl') })) | Should Match 'Protected path|Guardian'
    }
    It 'refuses a file that is not a current Guardian finding' { Write-JsonFile -Path (Get-GuardianPath 'LatestFiles') -Object @{ candidates = @() }; (First (Run 'file.recycle' @{ path = $f })) | Should Match 'not in the latest' }
    It 'refuses KEEP, HIGH_RISK and UNKNOWN classifications' { foreach ($c in 'KEEP', 'HIGH_RISK', 'UNKNOWN') { Set-Candidates $c; (First (Run 'file.recycle' @{ path = $f })) | Should Match $c } }
    It 'refuses folders' { Write-JsonFile -Path (Get-GuardianPath 'LatestFiles') -Object @{ candidates = @(@{ path = $dir; classification = 'REVIEW' }) }; (First (Run 'file.recycle' @{ path = $dir })) | Should Match 'Folders' }
    It 'refuses when the file changed since it was analysed' { Set-Candidates 'REVIEW'; (Get-Item $f).LastWriteTime = (Get-Date).AddDays(-3); (First (Run 'file.recycle' @{ path = $f })) | Should Match 'changed since'; $fi.LastWriteTime = (Get-Item $f).LastWriteTime; Set-Candidates 'REVIEW' }
    It 'shows size and age on validation and recycles only through the Recycle Bin wrapper' {
        Set-Candidates 'LIKELY_UNNECESSARY'
        $v = Run 'file.recycle' @{ path = $f } 'Validate'; $v.ok | Should Be $true; $v.details.sizeBytes | Should BeGreaterThan 0
        Mock -ModuleName $M Move-FileToRecycle { param($Path) Remove-Item -LiteralPath $Path -Force }
        $r = Run 'file.recycle' @{ path = $f }; $r.ok | Should Be $true; $r.verified | Should Be $true
        Assert-MockCalled -ModuleName $M Move-FileToRecycle -Exactly 1
    }
    It 'reports failure when the file is still there after the request' {
        Set-Content $f 'x'; $fi = Get-Item $f; Set-Candidates 'REVIEW'; Mock -ModuleName $M Move-FileToRecycle { }
        $r = Run 'file.recycle' @{ path = $f }; $r.ok | Should Be $false; (First $r) | Should Match 'still there'
    }
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'administrator-only maintenance actions' {
    It 'ask for elevation instead of running when not administrator' {
        Mock -ModuleName $M Test-AdminNow { $false }
        foreach ($a in 'defender.update-signatures', 'defender.quick-scan', 'system.integrity-check', 'dns.flush') { $r = Run $a @{}; $r.ok | Should Be $false; $r.needsElevation | Should Be $true }
        Mock -ModuleName $M Get-FirewallProfileForAction { [pscustomobject]@{ Enabled = 'False' } }
        (Run 'firewall.enable-profile' @{ profile = 'Public' }).needsElevation | Should Be $true
    }
    It 'Defender update: verifies fresh signatures, and fails honestly when they stay old' {
        Mock -ModuleName $M Test-AdminNow { $true }; Mock -ModuleName $M Update-MpSignature { }
        Mock -ModuleName $M Get-DefenderStatusForAction { [pscustomobject]@{ AntivirusSignatureLastUpdated = (Get-Date) } }
        (Run 'defender.update-signatures' @{}).verified | Should Be $true
        Mock -ModuleName $M Get-DefenderStatusForAction { [pscustomobject]@{ AntivirusSignatureLastUpdated = (Get-Date).AddDays(-5) } }
        (First (Run 'defender.update-signatures' @{})) | Should Match 'still look old'
    }
    It 'Defender quick scan: needs a newer scan time to claim success' {
        $global:T_Scan = 0; $global:T_Old = (Get-Date).AddDays(-1)
        Mock -ModuleName $M Test-AdminNow { $true }; Mock -ModuleName $M Start-MpScan { }
        Mock -ModuleName $M Get-DefenderStatusForAction { $global:T_Scan++; [pscustomobject]@{ QuickScanEndTime = $(if ($global:T_Scan -le 1) { $global:T_Old } else { Get-Date }) } }
        (Run 'defender.quick-scan' @{}).verified | Should Be $true
        Mock -ModuleName $M Get-DefenderStatusForAction { [pscustomobject]@{ QuickScanEndTime = $global:T_Old } }
        (First (Run 'defender.quick-scan' @{})) | Should Match 'did not record'
    }
    It 'integrity check is read-only tooling and reports clean and dirty results' {
        Mock -ModuleName $M Test-AdminNow { $true }
        Mock -ModuleName $M Invoke-IntegrityTools { [pscustomobject]@{ dismExit = 0; dismText = 'No component store corruption detected.'; sfcExit = 0; sfcText = '' } }
        (Run 'system.integrity-check' @{}).details.dismClean | Should Be $true
        Mock -ModuleName $M Invoke-IntegrityTools { [pscustomobject]@{ dismExit = 0; dismText = 'The component store is repairable.'; sfcExit = 1; sfcText = '' } }
        $d = (Run 'system.integrity-check' @{}).details; $d.dismClean | Should Be $false; $d.sfcClean | Should Be $false
        (Get-RemediationSource) | Should Not Match '/scannow|/RestoreHealth|/ScanHealth'
    }
    It 'firewall: only ever turns a profile ON, and refuses when it is already on' {
        Mock -ModuleName $M Test-AdminNow { $true }
        $global:T_Fw = 'False'
        Mock -ModuleName $M Get-FirewallProfileForAction { [pscustomobject]@{ Enabled = $global:T_Fw } }
        Mock -ModuleName $M Set-NetFirewallProfile { param($Name, $Enabled) $global:T_Fw = [string]$Enabled }
        (Run 'firewall.enable-profile' @{ profile = 'Public' }).verified | Should Be $true
        (First (Run 'firewall.enable-profile' @{ profile = 'Public' })) | Should Match 'already on'
        (Get-RemediationSource) | Should Not Match 'Enabled False'
    }
    It 'DNS flush: verifies the cache did not grow' {
        Mock -ModuleName $M Test-AdminNow { $true }; Mock -ModuleName $M Clear-DnsClientCache { }
        $global:T_Dns = 0; Mock -ModuleName $M Get-DnsCacheCount { $global:T_Dns++; if ($global:T_Dns -eq 1) { 40 } else { 2 } }
        (Run 'dns.flush' @{}).verified | Should Be $true
        $global:T_Dns = 0; Mock -ModuleName $M Get-DnsCacheCount { $global:T_Dns++; if ($global:T_Dns -eq 1) { 2 } else { 40 } }
        (First (Run 'dns.flush' @{})) | Should Match 'did not shrink'
    }
}

Describe 'Revo Uninstaller integration' {
    $revoOk = { [pscustomobject]@{ available = $true; target = 'C:\Program Files\VS Revo Group\Revo Uninstaller\RevoUnin.exe'; version = '2.7.0.0'; reason = $null } }
    $app = { @([pscustomobject]@{ name = 'Old Tool'; version = '1.0'; publisher = 'Acme'; installLocation = 'C:\Program Files\Acme\Old Tool'; systemComponent = $false; isUpdate = $false }) }
    It 'is offered only for a recognised installed application' {
        Mock -ModuleName $M Find-InstalledProgram { @() }; Mock -ModuleName $M Get-RevoInfo $revoOk
        (First (Run 'app.revo-launch' @{ appName = 'random.txt' })) | Should Match 'not in the installed programs'
    }
    It 'refuses ambiguous matches, system components, updates, and security/driver/runtime software' {
        Mock -ModuleName $M Get-RevoInfo $revoOk
        Mock -ModuleName $M Find-InstalledProgram { @([pscustomobject]@{ name = 'A'; systemComponent = $false; isUpdate = $false; publisher = ''; installLocation = '' }, [pscustomobject]@{ name = 'A'; systemComponent = $false; isUpdate = $false; publisher = ''; installLocation = '' }) }
        (First (Run 'app.revo-launch' @{ appName = 'A' })) | Should Match 'ambiguous'
        Mock -ModuleName $M Find-InstalledProgram { @([pscustomobject]@{ name = 'Thing'; systemComponent = $true; isUpdate = $false; publisher = ''; installLocation = '' }) }
        (First (Run 'app.revo-launch' @{ appName = 'Thing' })) | Should Match 'system component'
        foreach ($n in 'Microsoft Defender Antivirus', 'NVIDIA Graphics Driver 551', 'Microsoft Visual C++ 2015 Redistributable', 'Windows Security', 'Intel Chipset Device Software') { (First (Run 'app.revo-launch' @{ appName = $n })) | Should Match 'Protected' }
    }
    It 'falls back gracefully when Revo is unavailable or the shortcut is not trusted' {
        Mock -ModuleName $M Find-InstalledProgram $app; Mock -ModuleName $M Get-RevoInfo { [pscustomobject]@{ available = $false; target = $null; version = $null; reason = 'The shortcut target no longer exists.' } }
        $r = Run 'app.revo-launch' @{ appName = 'Old Tool' }; $r.ok | Should Be $false; (First $r) | Should Match 'Windows Settings'
    }
    It 'launches Revo with no arguments, never claims success of the uninstall, and never targets files' {
        Mock -ModuleName $M Find-InstalledProgram $app; Mock -ModuleName $M Get-RevoInfo $revoOk
        Mock -ModuleName $M Start-RevoProcess { [pscustomobject]@{ Id = 999 } }
        $r = Run 'app.revo-launch' @{ appName = 'Old Tool' }
        $r.ok | Should Be $true; $r.verified | Should Be $false; $r.details.pendingVerification | Should Be $true; $r.message | Should Match 'has not uninstalled'
        Assert-MockCalled -ModuleName $M Start-RevoProcess -Exactly 1 -ParameterFilter { $Exe -like '*RevoUnin.exe' }
        (Get-RemediationSource) | Should Not Match 'RevoUnin\.exe.{0,40}(/|-)(path|file|mode|delete)'
    }
    It 'verification reports uninstalled only when the program is really gone' {
        Mock -ModuleName $M Find-InstalledProgram $app
        $r = Run 'app.verify-removed' @{ appName = 'Old Tool' }; $r.verified | Should Be $false; $r.details.removed | Should Be $false; $r.message | Should Match 'still listed'
        Mock -ModuleName $M Find-InstalledProgram { @() }
        $r = Run 'app.verify-removed' @{ appName = 'Old Tool' }; $r.verified | Should Be $true; $r.details.removed | Should Be $true
    }
    It 'Revo shortcut inspection never launches anything and reports a clear reason when untrusted' {
        $src = Get-Content (Join-Path $script:RepoRoot 'src\powershell\Actions\Remediation\Apps.ps1') -Raw
        $i = $src.IndexOf('function Get-RevoInfo'); $j = $src.IndexOf('# ---------- protections'); $body = $src.Substring($i, $j - $i)
        $body | Should Not Match 'Start-Process|Invoke-Item|&\s'
    }
}

Describe 'Entry scripts' {
    $entry = Get-Content (Join-Path $script:RepoRoot 'src\powershell\Actions\Invoke-GuardianAction.ps1') -Raw
    $elev = Get-Content (Join-Path $script:RepoRoot 'src\powershell\Actions\Request-ElevatedAction.ps1') -Raw
    It 'have no way to run a supplied command' {
        foreach ($s in $entry, $elev, (Get-RemediationSource)) { $s | Should Not Match 'Invoke-Expression|\biex\b|-EncodedCommand|ScriptBlock\]::Create|Add-Type.*DllImport' }
    }
    It 'elevation has exactly one RunAs and only for the fixed entry script' {
        ([regex]::Matches($elev, '-Verb RunAs')).Count | Should Be 1
        $elev | Should Match 'Invoke-GuardianAction\.ps1'
    }
    It 'never offers elevation for an action that does not need it' {
        $r = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $script:RepoRoot 'src\powershell\Actions\Request-ElevatedAction.ps1') -Action 'process.stop' -ParamsB64 'e30=' -Ticket ('a' * 32) | ConvertFrom-Json
        $r.requested | Should Be $false; $r.message | Should Match 'does not need'
    }
    It 'rejects an unknown action name and a malformed ticket at the parameter layer' {
        $oldEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $script:RepoRoot 'src\powershell\Actions\Request-ElevatedAction.ps1') -Action 'process.stop' -ParamsB64 'e30=' -Ticket '../../x' 2>&1 | Out-Null
        $LASTEXITCODE | Should Not Be 0
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $script:RepoRoot 'src\powershell\Actions\Invoke-GuardianAction.ps1') -Action 'x; calc' 2>&1 | Out-Null
        $LASTEXITCODE | Should Not Be 0
        $ErrorActionPreference = $oldEap
    }
    It 'Validate through the real entry script is read-only and refuses an unknown action' {
        $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{}'))
        $r = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $script:RepoRoot 'src\powershell\Actions\Invoke-GuardianAction.ps1') -Action 'shell.run' -Mode Validate -ParamsB64 $b64 | ConvertFrom-Json
        $r.ok | Should Be $false; @($r.errors)[0] | Should Match 'not an allowlisted'
    }
}
Remove-TestRoot $root
