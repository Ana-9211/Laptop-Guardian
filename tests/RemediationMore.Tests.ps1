. "$PSScriptRoot\Helpers.ps1"
# The remediation actions added for "an action for every finding". Every system touchpoint is mocked or pointed at a temp folder:
# nothing here changes Defender, a service, the audit policy or Task Scheduler, empties the Recycle Bin or deletes a real file.
$root = New-TestRoot; Import-Guardian; Initialize-GuardianDirectories
Import-Module (Join-Path $script:RepoRoot 'src\powershell\Actions\Remediation.psm1') -Force -DisableNameChecking
$M = 'Remediation'
function Run($action, $params, $mode = 'Execute') { Invoke-GuardianRemediation -Action $action -Mode $mode -Params $params }
function First($r) { @($r.errors)[0] }
function New-TempDir { $d = Join-Path $env:TEMP ('lg-rem-' + [guid]::NewGuid().ToString('N').Substring(0, 8)); New-Item -ItemType Directory -Path $d | Out-Null; $d }

Describe 'catalog: the new actions' {
    $cat = Get-ActionCatalog
    $new = 'scan.run-now', 'scan.queue-next-run', 'scan.schedule-once', 'scan.cancel-once', 'setup.register-tasks', 'setup.enable-safe-defaults', 'setup.enable-dns-log', 'setup.enable-firewall-audit', 'setup.disable-firewall-audit', 'defender.enable-realtime', 'system.run-windows-update-scan', 'system.open-settings', 'service.stop', 'service.start', 'storage.clean-temp', 'cleanup.empty-recycle-bin', 'file.delete-permanent'
    It 'all exist with a verify step, risk, admin mode and undo text' {
        foreach ($id in $new) { $a = Get-ActionSpec -Id $id; $a | Should Not BeNullOrEmpty; $a.verify | Should Not BeNullOrEmpty; $a.risk | Should Not BeNullOrEmpty; $a.undo | Should Not BeNullOrEmpty; ($a.PSObject.Properties.Name -contains 'admin') | Should Be $true }
    }
    It 'every action in the catalog has a verify step' { foreach ($a in $cat.actions) { $a.verify | Should Not BeNullOrEmpty } }
    It 'every PowerShell-handled new action has a handler' {
        foreach ($id in $new) { $a = Get-ActionSpec -Id $id; if ($a.PSObject.Properties.Name -contains 'handler') { continue }; (& (Get-Module Remediation) { param($i) Get-RemediationHandler -Id $i } $id) | Should Not BeNullOrEmpty }
    }
    It 'refuses malformed parameters before anything runs' {
        (First (Run 'system.open-settings' @{ page = 'cmd.exe' })) | Should Match 'must be one of'
        (First (Run 'scan.schedule-once' @{ kind = 'daily'; at = 'tomorrow' })) | Should Match 'invalid format'
        (First (Run 'scan.cancel-once' @{ taskName = 'Microsoft\Windows\Defrag' })) | Should Match 'invalid format'
        (First (Run 'storage.clean-temp' @{ scope = 'windows' })) | Should Match 'must be one of'
    }
}

Describe 'defender.enable-realtime' {
    It 'needs administrator permission' { Mock -ModuleName $M Test-AdminNow { $false }; $r = Run 'defender.enable-realtime' @{}; $r.ok | Should Be $false; $r.needsElevation | Should Be $true }
    It 'refuses when Defender is replaced by another antivirus, or already on' {
        Mock -ModuleName $M Test-AdminNow { $true }
        Mock -ModuleName $M Get-DefenderStatusForAction { [pscustomobject]@{ AntivirusEnabled = $false; RealTimeProtectionEnabled = $false } }
        (First (Run 'defender.enable-realtime' @{})) | Should Match 'another antivirus'
        Mock -ModuleName $M Get-DefenderStatusForAction { [pscustomobject]@{ AntivirusEnabled = $true; RealTimeProtectionEnabled = $true } }
        (First (Run 'defender.enable-realtime' @{})) | Should Match 'already on'
    }
    It 'turns it on and verifies by reading the state back; reports a refusal honestly' {
        $global:T_Rt = $false
        Mock -ModuleName $M Test-AdminNow { $true }
        Mock -ModuleName $M Get-DefenderStatusForAction { [pscustomobject]@{ AntivirusEnabled = $true; RealTimeProtectionEnabled = $global:T_Rt } }
        Mock -ModuleName $M Set-DefenderRealtimeForAction { $global:T_Rt = $true }
        $r = Run 'defender.enable-realtime' @{}; $r.ok | Should Be $true; $r.verified | Should Be $true
        $global:T_Rt = $false
        Mock -ModuleName $M Set-DefenderRealtimeForAction { throw 'Tamper Protection is on' }
        (First (Run 'defender.enable-realtime' @{})) | Should Match 'Tamper'
        Mock -ModuleName $M Set-DefenderRealtimeForAction { }   # claims success but the state did not change
        (First (Run 'defender.enable-realtime' @{})) | Should Match 'did not report'
    }
}

Describe 'system.run-windows-update-scan and system.open-settings' {
    It 'reports waiting updates, a clean state, and a failed search' {
        Mock -ModuleName $M Search-WindowsUpdatesForAction { @([pscustomobject]@{ title = 'Security Update'; sizeMB = 10; security = $true }, [pscustomobject]@{ title = 'Driver'; sizeMB = 5; security = $false }) }
        $r = Run 'system.run-windows-update-scan' @{}; $r.ok | Should Be $true; $r.details.pending | Should Be 2; $r.details.security | Should Be 1; $r.message | Should Match '2 update'
        Mock -ModuleName $M Search-WindowsUpdatesForAction { @() }
        (Run 'system.run-windows-update-scan' @{}).message | Should Match 'up to date'
        Mock -ModuleName $M Search-WindowsUpdatesForAction { throw 'offline' }
        (First (Run 'system.run-windows-update-scan' @{})) | Should Match 'could not be searched'
    }
    It 'opens only the fixed page chosen by name' {
        $global:T_Uri = $null
        Mock -ModuleName $M Start-SettingsPage { param($Uri) $global:T_Uri = $Uri }
        (Run 'system.open-settings' @{ page = 'windows-update' }).ok | Should Be $true
        $global:T_Uri | Should Be 'ms-settings:windowsupdate'
        (Run 'system.open-settings' @{ page = 'protection-history' }).ok | Should Be $true
        $global:T_Uri | Should Be 'windowsdefender://threat'
    }
}

Describe 'firewall connection logging (audit policy)' {
    BeforeEach {
        $global:T_Bk = Join-Path (New-TempDir) 'prev.json'
        $global:T_Aud = [ordered]@{ connection = 1; 'packet-drop' = 0 }
        Mock -ModuleName $M Test-AdminNow { $true }
        Mock -ModuleName $M Get-WfpAuditBackupPath { $global:T_Bk }
        Mock -ModuleName $M Get-WfpAuditState { $global:T_Aud }
        Mock -ModuleName $M Set-WfpAuditState { param($State) $global:T_Aud = [ordered]@{ connection = [int]$State['connection']; 'packet-drop' = [int]$State['packet-drop'] } }
    }
    It 'needs administrator permission' { Mock -ModuleName $M Test-AdminNow { $false }; (Run 'setup.enable-firewall-audit' @{}).needsElevation | Should Be $true }
    It 'turns logging on, remembers the previous state, and turning it off restores exactly that' {
        $r = Run 'setup.enable-firewall-audit' @{}; $r.ok | Should Be $true; $r.verified | Should Be $true; $r.undo.action | Should Be 'setup.disable-firewall-audit'
        $global:T_Aud['connection'] | Should Be 3; $global:T_Aud['packet-drop'] | Should Be 3
        Test-Path $global:T_Bk | Should Be $true
        $r2 = Run 'setup.disable-firewall-audit' @{}; $r2.ok | Should Be $true
        $global:T_Aud['connection'] | Should Be 1; $global:T_Aud['packet-drop'] | Should Be 0
        Test-Path $global:T_Bk | Should Be $false
    }
    It 'refuses to enable twice' { $global:T_Aud = [ordered]@{ connection = 3; 'packet-drop' = 3 }; (First (Run 'setup.enable-firewall-audit' @{})) | Should Match 'already on' }
    It 'reports an auditpol failure and does not claim success' {
        Mock -ModuleName $M Set-WfpAuditState { throw 'auditpol failed for connection (exit 5)' }
        (First (Run 'setup.enable-firewall-audit' @{})) | Should Match 'auditpol failed'
    }
}

Describe 'auditpol parsing' {
    It 'parses auditpol backup rows by subcategory GUID, independent of the display language' {
        Mock -ModuleName $M Invoke-AuditPol { param($Arguments) $f = ($Arguments | Where-Object { $_ -like '/file:*' }) -replace '^/file:', ''; if ($f) { "Machine Name,Policy Target,Subcategory,Subcategory GUID,Inclusion Setting,Exclusion Setting,Setting Value`nPC,System,Filtrage,{0CCE9226-69AE-11D9-BED3-505054503030},Succes et echec,,3`nPC,System,Abandon,{0CCE9225-69AE-11D9-BED3-505054503030},Aucun audit,,0" | Set-Content -LiteralPath $f -Encoding UTF8 }; [pscustomobject]@{ exit = 0; text = '' } }
        $real = & (Get-Module Remediation) { Get-WfpAuditState }
        $real['connection'] | Should Be 3; $real['packet-drop'] | Should Be 0
    }
}

Describe 'service.stop and service.start' {
    BeforeEach { Mock -ModuleName $M Test-AdminNow { $true } }
    It 'never stops a protected, Windows-owned or driver service' {
        $prot = @(Get-ProtectedServiceNames)[0]
        (First (Run 'service.stop' @{ name = $prot })) | Should Match 'Protected'
        Mock -ModuleName $M Get-ServiceForAction { [pscustomobject]@{ Name = 'Thing'; State = 'Running'; StartMode = 'Auto'; PathName = 'C:\Windows\System32\svchost.exe -k netsvcs'; ServiceType = 'Own Process' } }
        (First (Run 'service.stop' @{ name = 'Thing' })) | Should Match 'part of Windows'
        Mock -ModuleName $M Get-ServiceForAction { [pscustomobject]@{ Name = 'Drv'; State = 'Running'; StartMode = 'Auto'; PathName = 'D:\x\d.sys'; ServiceType = 'Kernel Driver' } }
        (First (Run 'service.stop' @{ name = 'Drv' })) | Should Match 'drivers'
    }
    It 'stops a running third-party service, verifies the state and offers the undo' {
        $global:T_Svc = 'Running'
        Mock -ModuleName $M Get-ServiceForAction { [pscustomobject]@{ Name = 'Acme'; State = $global:T_Svc; StartMode = 'Auto'; PathName = 'D:\Acme\acme.exe'; ServiceType = 'Own Process' } }
        Mock -ModuleName $M Set-ServiceRunStateForAction { param($Name, $Running) $global:T_Svc = $(if ($Running) { 'Running' } else { 'Stopped' }) }
        $r = Run 'service.stop' @{ name = 'Acme' }; $r.ok | Should Be $true; $r.verified | Should Be $true; $r.undo.action | Should Be 'service.start'
        (First (Run 'service.stop' @{ name = 'Acme' })) | Should Match 'not running'
        $r2 = Run 'service.start' @{ name = 'Acme' }; $r2.ok | Should Be $true; $r2.undo.action | Should Be 'service.stop'
    }
    It 'does not start a disabled service and reports a stop that Windows did not perform' {
        Mock -ModuleName $M Get-ServiceForAction { [pscustomobject]@{ Name = 'Acme'; State = 'Stopped'; StartMode = 'Disabled'; PathName = 'D:\Acme\acme.exe'; ServiceType = 'Own Process' } }
        (First (Run 'service.start' @{ name = 'Acme' })) | Should Match 'disabled'
        Mock -ModuleName $M Get-ServiceForAction { [pscustomobject]@{ Name = 'Acme'; State = 'Running'; StartMode = 'Auto'; PathName = 'D:\Acme\acme.exe'; ServiceType = 'Own Process' } }
        Mock -ModuleName $M Set-ServiceRunStateForAction { }
        (First (Run 'service.stop' @{ name = 'Acme' })) | Should Match 'did not report'
    }
    It 'asks for elevation when not administrator' {
        Mock -ModuleName $M Test-AdminNow { $false }
        Mock -ModuleName $M Get-ServiceForAction { [pscustomobject]@{ Name = 'Acme'; State = 'Running'; StartMode = 'Auto'; PathName = 'D:\Acme\acme.exe'; ServiceType = 'Own Process' } }
        (Run 'service.stop' @{ name = 'Acme' }).needsElevation | Should Be $true
    }
}

Describe 'storage.clean-temp' {
    It 'deletes only files older than the age setting inside the allowlisted location; folders and young files stay' {
        $d = New-TempDir
        New-Item -ItemType Directory -Path "$d\sub" | Out-Null
        foreach ($n in 'old1.tmp', 'sub\old2.tmp', 'young.tmp') { Set-Content -LiteralPath "$d\$n" -Value ('x' * 2048) }
        foreach ($n in 'old1.tmp', 'sub\old2.tmp') { (Get-Item "$d\$n").LastWriteTime = (Get-Date).AddDays(-30) }
        $global:T_Dir = $d
        Mock -ModuleName $M Get-CleanupTargetsForAction { [pscustomobject]@{ kind = 'temp'; path = $global:T_Dir } }
        $v = Run 'storage.clean-temp' @{ scope = 'temp' } 'Validate'; $v.ok | Should Be $true; $v.details.files | Should Be 2
        $r = Run 'storage.clean-temp' @{ scope = 'temp' }; $r.ok | Should Be $true; $r.verified | Should Be $true
        Test-Path "$d\old1.tmp" | Should Be $false; Test-Path "$d\sub\old2.tmp" | Should Be $false
        Test-Path "$d\young.tmp" | Should Be $true; Test-Path "$d\sub" | Should Be $true
        (First (Run 'storage.clean-temp' @{ scope = 'temp' } 'Validate')) | Should Match 'Nothing to clean'
        Remove-Item $d -Recurse -Force
    }
    It 'reports no safe location when none exists' { Mock -ModuleName $M Get-CleanupTargetsForAction { @() }; (First (Run 'storage.clean-temp' @{ scope = 'all' } 'Validate')) | Should Match 'no cleanup location' }
}

Describe 'cleanup.empty-recycle-bin' {
    It 'never touches the real Recycle Bin here; verifies it is empty afterwards and fails honestly otherwise' {
        $global:T_Bin = 5
        Mock -ModuleName $M Get-RecycleBinSizeForAction { [pscustomobject]@{ bytes = [int64]($global:T_Bin * 1MB); items = $global:T_Bin } }
        Mock -ModuleName $M Clear-RecycleBinForAction { $global:T_Bin = 0 }
        $r = Run 'cleanup.empty-recycle-bin' @{}; $r.ok | Should Be $true; $r.verified | Should Be $true; $r.message | Should Match '5 item'
        (First (Run 'cleanup.empty-recycle-bin' @{} 'Validate')) | Should Match 'already empty'
        $global:T_Bin = 3
        Mock -ModuleName $M Clear-RecycleBinForAction { }
        (First (Run 'cleanup.empty-recycle-bin' @{})) | Should Match 'still in the Recycle Bin'
    }
}

Describe 'file.delete-permanent' {
    It 'only accepts files in the user''s own Recycle Bin or in a cleanup location' {
        Mock -ModuleName $M Get-CurrentUserSid { 'S-1-5-21-1-2-3-1001' }
        Mock -ModuleName $M Get-CleanupTargetsForAction { [pscustomobject]@{ kind = 'temp'; path = 'C:\Users\x\AppData\Local\Temp' } }
        (& (Get-Module Remediation) { Test-PermanentDeleteLocation -FullPath 'C:\$Recycle.Bin\S-1-5-21-1-2-3-1001\$R1.txt' }) | Should Be 'recycle-bin'
        (& (Get-Module Remediation) { Test-PermanentDeleteLocation -FullPath 'C:\$Recycle.Bin\S-1-5-21-9-9-9-1002\$R1.txt' }) | Should BeNullOrEmpty
        (& (Get-Module Remediation) { Test-PermanentDeleteLocation -FullPath 'C:\Users\x\AppData\Local\Temp\a.tmp' }) | Should Be 'cleanup:temp'
        (& (Get-Module Remediation) { Test-PermanentDeleteLocation -FullPath 'C:\Users\x\Documents\a.docx' }) | Should BeNullOrEmpty
    }
    It 'refuses anything outside those places, even if it exists' {
        $d = New-TempDir; Set-Content "$d\keep.txt" 'x'
        Mock -ModuleName $M Get-CleanupTargetsForAction { @() }
        (First (Run 'file.delete-permanent' @{ path = "$d\keep.txt" } 'Validate')) | Should Match 'Recycle Bin or in a temp'
        Test-Path "$d\keep.txt" | Should Be $true
        Remove-Item $d -Recurse -Force
    }
    It 'deletes a single file in a cleanup location, verifies it is gone, and refuses folders and wildcards' {
        $d = New-TempDir; New-Item -ItemType Directory -Path "$d\dir" | Out-Null; Set-Content "$d\a.tmp" 'x'
        $global:T_Dir = $d
        Mock -ModuleName $M Get-CleanupTargetsForAction { [pscustomobject]@{ kind = 'temp'; path = $global:T_Dir } }
        Mock -ModuleName $M Test-ProtectedPath { $false }
        (First (Run 'file.delete-permanent' @{ path = "$d\*.tmp" } 'Validate')) | Should Match '(Wildcards|invalid format)'
        (First (Run 'file.delete-permanent' @{ path = "$d\dir" } 'Validate')) | Should Match 'Folders'
        $r = Run 'file.delete-permanent' @{ path = "$d\a.tmp" }; $r.ok | Should Be $true; $r.verified | Should Be $true
        Test-Path "$d\a.tmp" | Should Be $false
        Remove-Item $d -Recurse -Force
    }
    It 'refuses a protected path even inside a cleanup location' {
        $d = New-TempDir; Set-Content "$d\a.tmp" 'x'; $global:T_Dir = $d
        Mock -ModuleName $M Get-CleanupTargetsForAction { [pscustomobject]@{ kind = 'temp'; path = $global:T_Dir } }
        Mock -ModuleName $M Test-ProtectedPath { $true }
        (First (Run 'file.delete-permanent' @{ path = "$d\a.tmp" } 'Validate')) | Should Match 'Protected'
        Test-Path "$d\a.tmp" | Should Be $true
        Remove-Item $d -Recurse -Force
    }
}

Describe 'scan.schedule-once and scan.cancel-once' {
    BeforeEach { $global:T_Once = @{}; Mock -ModuleName $M Get-OnceTaskForAction { param($Name) if ($global:T_Once.ContainsKey($Name)) { [pscustomobject]@{ TaskName = $Name } } }
        Mock -ModuleName $M Register-OnceTaskForAction { param($Name, $Kind, $At) $global:T_Once[$Name] = "$Kind|$At" }
        Mock -ModuleName $M Unregister-OnceTaskForAction { param($Name) $global:T_Once.Remove($Name) } }
    It 'plans a future one-time scan, verifies the task exists and offers the cancel as undo' {
        $at = (Get-Date).AddHours(3).ToString('yyyy-MM-ddTHH:mm')
        $v = Run 'scan.schedule-once' @{ kind = 'weekly'; at = $at } 'Validate'; $v.ok | Should Be $true; $v.details.taskName | Should Match '^Guardian one-time weekly scan [0-9]{8}-[0-9]{4}$'
        $r = Run 'scan.schedule-once' @{ kind = 'weekly'; at = $at }; $r.ok | Should Be $true; $r.verified | Should Be $true; $r.undo.action | Should Be 'scan.cancel-once'
        $global:T_Once.Count | Should Be 1
        (First (Run 'scan.schedule-once' @{ kind = 'weekly'; at = $at } 'Validate')) | Should Match 'already planned'
        (Run 'scan.cancel-once' $r.undo.params).ok | Should Be $true
        $global:T_Once.Count | Should Be 0
    }
    It 'refuses a time in the past or too far away' {
        (First (Run 'scan.schedule-once' @{ kind = 'daily'; at = (Get-Date).AddHours(-2).ToString('yyyy-MM-ddTHH:mm') } 'Validate')) | Should Match 'future'
        (First (Run 'scan.schedule-once' @{ kind = 'daily'; at = (Get-Date).AddDays(90).ToString('yyyy-MM-ddTHH:mm') } 'Validate')) | Should Match '60 days'
    }
    It 'cancels only Guardian''s own one-time tasks and says so when the task is gone' {
        (First (Run 'scan.cancel-once' @{ taskName = 'Guardian one-time daily scan 20300101-0000' } 'Validate')) | Should Match 'not planned'
    }
    It 'the weekly one-time task runs with -NoShutdown and standard rights' {
        $src = Get-RemediationSource
        $src | Should Match "'\s-NoShutdown'"
        $src | Should Match '-RunLevel Limited'
    }
}

Describe 'a queued full run (scan.queue-next-run) is honoured once' {
    It 'matches by kind, is consumed, and leaves a different kind alone' {
        $f = Get-GuardianPath 'QueuedRun'; New-Item -ItemType Directory -Path (Split-Path -Parent $f) -Force | Out-Null
        Write-JsonFile -Path $f -Object ([ordered]@{ kind = 'weekly'; full = $true; queuedAt = '2026-10-07T10:00:00+05:30' })
        (Use-QueuedFullRun -Kind daily) | Should Be $false; Test-Path $f | Should Be $true
        (Use-QueuedFullRun -Kind weekly) | Should Be $true; Test-Path $f | Should Be $false
        (Use-QueuedFullRun -Kind weekly) | Should Be $false
    }
    It 'Daily.ps1 and Weekly.ps1 read it' {
        foreach ($s in 'Daily', 'Weekly') { (Get-Content (Join-Path $script:RepoRoot "src\powershell\$s.ps1") -Raw) | Should Match "Use-QueuedFullRun -Kind $($s.ToLower())" }
    }
}
Remove-TestRoot $root
