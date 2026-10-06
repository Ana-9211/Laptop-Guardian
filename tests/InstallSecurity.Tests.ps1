. "$PSScriptRoot\Helpers.ps1"
$root = New-TestRoot; Import-Guardian; Initialize-GuardianDirectories
Import-Module (Join-Path $script:RepoRoot 'src\powershell\Install\InstallSecurity.psm1') -Force -DisableNameChecking -Global
$M = 'InstallSecurity'
$global:adminSid = New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'
$global:usersSid = New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545'
$global:systemSid = New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'
$global:meSid = [Security.Principal.WindowsIdentity]::GetCurrent().User

function global:E($Sid, $Rights) { [pscustomobject]@{ Sid = $Sid; Rights = $Rights } }
# An in-memory ACL (nothing on disk is touched): owner plus (sid, rights) entries.
function global:New-FakeAcl([Security.Principal.SecurityIdentifier]$Owner, $Entries) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($Owner)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($e in $Entries) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($e.Sid, [Security.AccessControl.FileSystemRights]$e.Rights, [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))) }
    $acl
}
$global:trustedAcl = { New-FakeAcl $global:adminSid @((E $global:adminSid 'FullControl'), (E $global:systemSid 'FullControl'), (E $global:usersSid 'ReadAndExecute')) }

Describe 'Who may change files that administrator code runs from' {
    It 'is empty for SYSTEM and Administrators with Users read-only' {
        Mock -ModuleName $M Get-PathAcl { & $global:T_Acl }
        $global:T_Acl = $global:trustedAcl
        @(Get-UntrustedWriters -Path 'C:\x').Count | Should Be 0
    }
    It 'names a standard-user group that can modify, and an owner that is an ordinary account' {
        Mock -ModuleName $M Get-PathAcl { & $global:T_Acl }
        $global:T_Acl = { New-FakeAcl $global:meSid @((E $global:adminSid 'FullControl'), (E $global:usersSid 'Modify')) }
        $w = @(Get-UntrustedWriters -Path 'C:\x')
        ($w -join ' ') | Should Match 'S-1-5-32-545'
        ($w -join ' ') | Should Match 'owner'
    }
    It 'treats the account that owns a development checkout as an untrusted writer' {
        Mock -ModuleName $M Get-PathAcl { & $global:T_Acl }
        $global:T_Acl = { New-FakeAcl $global:meSid @((E $global:meSid 'FullControl'), (E $global:adminSid 'FullControl')) }
        (@(Get-UntrustedWriters -Path 'C:\x') -join ' ') | Should Match ([regex]::Escape($global:meSid.Value))
    }
}

Describe 'Administrator code runs only from a trusted installed copy' {
    function New-FakeProgramDir {
        $d = Join-Path $env:TEMP ('lg-trust-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path "$d\src\powershell\Common", "$d\src\shared" -Force | Out-Null
        Set-Content "$d\src\shared\action-catalog.json" '{}'; Set-Content "$d\install.json" '{}'
        $d
    }
    $install = [pscustomobject]@{ dataRoot = 'C:\d'; elevatedDir = 'C:\e' }

    It 'refuses a development checkout and says exactly what to do' {
        $r = Test-InstallTrusted -CodeRoot 'C:\anywhere' -Install $null
        $r.trusted | Should Be $false
        $msg = Get-UntrustedInstallMessage -Result $r
        $msg | Should Match 'development checkout'
        $msg | Should Match 'Install-LaptopGuardian\.ps1'
        $msg | Should Match 'administrator'
    }
    It 'trusts an installed copy whose every folder is administrators-only' {
        $d = New-FakeProgramDir
        try {
            Mock -ModuleName $M Get-PathAcl { & $global:T_Acl }
            $global:T_Acl = $global:trustedAcl
            (Test-InstallTrusted -CodeRoot $d -Install $install -AllowedOwnerSids @($global:adminSid.Value)).trusted | Should Be $true
        } finally { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It 'refuses an installed copy when any folder inside it can be changed by ordinary users, naming the folder' {
        $d = New-FakeProgramDir
        try {
            Mock -ModuleName $M Get-PathAcl { param($Path) if ($Path -like '*\src\powershell') { & $global:T_Bad } else { & $global:T_Acl } }
            $global:T_Acl = $global:trustedAcl
            $global:T_Bad = { New-FakeAcl $global:adminSid @((E $global:adminSid 'FullControl'), (E $global:usersSid 'Modify')) }
            $r = Test-InstallTrusted -CodeRoot $d -Install $install -AllowedOwnerSids @($global:adminSid.Value)
            $r.trusted | Should Be $false
            ($r.problems -join ' ') | Should Match 'src\\powershell'
            $r.fix | Should Match 'again'
        } finally { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It 'does not block standard-user runs, and blocks elevated ones, from a checkout' {
        Mock -ModuleName $M Test-IsAdmin { $false }
        { Assert-ElevatedCodeTrusted } | Should Not Throw
        Mock -ModuleName $M Test-IsAdmin { $true }
        { Assert-ElevatedCodeTrusted } | Should Throw 'development checkout'
    }
    It 'also blocks the step that would start administrator code (the UAC request) when the copy is untrusted' {
        Mock -ModuleName $M Test-IsAdmin { $false }
        { Assert-ElevatedCodeTrusted -WillElevate } | Should Throw 'Install-LaptopGuardian'
    }
    It 'has no environment variable or switch that overrides the refusal' {
        Mock -ModuleName $M Test-IsAdmin { $true }
        $env:GUARDIAN_ALLOW_UNTRUSTED = '1'; $env:GUARDIAN_DEV_ELEVATION = '1'; $env:GUARDIAN_ROOT = $root
        try { { Assert-ElevatedCodeTrusted } | Should Throw } finally { Remove-Item Env:\GUARDIAN_ALLOW_UNTRUSTED, Env:\GUARDIAN_DEV_ELEVATION -ErrorAction SilentlyContinue }
        (Get-Command Assert-ElevatedCodeTrusted).Parameters.Keys | Where-Object { $_ -match 'Force|Bypass|Skip|Allow|Ignore|Dev' } | Should BeNullOrEmpty
    }
}

Describe 'The administrators-only folder' {
    function New-TempDir { $d = Join-Path $env:TEMP ('lg-acl-' + [guid]::NewGuid().ToString('N').Substring(0, 8)); New-Item -ItemType Directory -Path $d | Out-Null; $d }
    function Remove-ProtectedTempDir($d) {
        # the owner can always rewrite the permissions of what it owns, so the test folder can be cleaned up
        try { $acl = New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($false, $false); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($global:meSid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))); [IO.Directory]::SetAccessControl($d, $acl) } catch { }
        Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue
    }
    It 'is created with explicit rules and no inheritance, and reads back clean' {
        $d = New-TempDir
        try {
            New-ProtectedDirectory -Path $d -AllowedOwnerSids @($global:meSid.Value)     # the real installer runs elevated, so the owner is Administrators
            @(Test-ProtectedDirectoryAcl -Path $d -AllowedOwnerSids @($global:meSid.Value)).Count | Should Be 0
            $acl = Get-Acl -LiteralPath $d
            $acl.AreAccessRulesProtected | Should Be $true
            $sids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value })
            ($sids -contains 'S-1-5-18' -and $sids -contains 'S-1-5-32-544' -and $sids -contains 'S-1-5-32-545') | Should Be $true
            (@($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-32-545' } | Where-Object { ([int]$_.FileSystemRights -band 0x116) -ne 0 })).Count | Should Be 0   # Users: no write bits
        } finally { Remove-ProtectedTempDir $d }
    }
    It 'fails loudly when the owner is not an administrator (an ordinary account created it)' {
        $d = New-TempDir
        try { { New-ProtectedDirectory -Path $d } | Should Throw 'not what the installer set' } finally { Remove-ProtectedTempDir $d }
    }
    It 'reports a folder that inherits permissions, or that ordinary users can write to' {
        $d = New-TempDir
        try {
            $inheriting = @(Test-ProtectedDirectoryAcl -Path $d -AllowedOwnerSids @($global:meSid.Value))
            ($inheriting -join ' ') | Should Match 'inherits'
            New-ProtectedDirectory -Path $d -AllowedOwnerSids @($global:meSid.Value)
            $acl = Get-Acl -LiteralPath $d
            $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($global:usersSid, [Security.AccessControl.FileSystemRights]::Modify, [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)))
            [IO.Directory]::SetAccessControl($d, $acl)
            ((@(Test-ProtectedDirectoryAcl -Path $d -AllowedOwnerSids @($global:meSid.Value))) -join ' ') | Should Match 'can write'
        } finally { Remove-ProtectedTempDir $d }
    }
}

Describe 'Elevated runs do not trust config, policy or ignore lists' {
    function New-WildConfig {
        [pscustomobject]@{
            cleanup = [pscustomobject]@{ tempFiles = 'yes'; crashDumps = $true; caches = $null; recycleBin = 'older-than-30-days'; tempMinAgeDays = -5 }
            storage = [pscustomobject]@{ drives = @('C:', 'D:\', '\\evil\share', 'notadrive', 5, 'e:'); excludedDirs = @('D:\keep', '..\..\x', 'C:\a*b', 7); protectedDirs = @('E:\prot'); minLargeFileMB = 0; oldFileDays = 99999; duplicateScan = 'true'; duplicateMinMB = 'abc' }
            thresholds = [pscustomobject]@{ cpuPct = 0; memoryMB = 1e12; diskFreeWarnPct = 10; diskFreeCritPct = 40 }
            retention = [pscustomobject]@{ reportsDays = 1e9 }
            ai = [pscustomobject]@{ maxRequestsPerRun = -1; maxProcessesPerRun = 1000000; dailyTokenBudget = 'NaN' }
        }
    }
    It 'clamps numbers to the ranges the dashboard enforces and repairs inconsistent thresholds' {
        $c = Limit-ConfigForElevation -Config (New-WildConfig)
        $c.cleanup.tempMinAgeDays | Should Be 1
        $c.storage.minLargeFileMB | Should Be 1; $c.storage.oldFileDays | Should Be 3650; $c.storage.duplicateMinMB | Should Be 1
        $c.thresholds.cpuPct | Should Be 1; $c.thresholds.memoryMB | Should Be 1000000
        ($c.thresholds.diskFreeCritPct -lt $c.thresholds.diskFreeWarnPct) | Should Be $true
        $c.retention.reportsDays | Should Be 3650
        $c.ai.maxRequestsPerRun | Should Be 0; $c.ai.maxProcessesPerRun | Should Be 100; $c.ai.dailyTokenBudget | Should Be 0
    }
    It 'coerces switches, falls back to the safe Recycle Bin policy and keeps only real drive letters and absolute folders' {
        $c = Limit-ConfigForElevation -Config (New-WildConfig)
        $c.cleanup.tempFiles | Should Be $false; $c.cleanup.caches | Should Be $false; $c.cleanup.crashDumps | Should Be $true
        $c.cleanup.recycleBin | Should Be 'never'
        $c.storage.duplicateScan | Should Be $false
        (@($c.storage.drives) -join ',') | Should Be 'C:,e:'
        (@($c.storage.excludedDirs) -join ',') | Should Be 'D:\keep'
        (@($c.storage.protectedDirs) -join ',') | Should Be 'E:\prot'
    }
    It 'uses only well-formed ids from the ignored-files list' {
        (@(Get-SafeIgnoredIds -Raw @('0123456789ab', '../../etc', 'ZZZZZZZZZZZZ', '0123456789abcdef', 5)) -join ',') | Should Be '0123456789ab'
        (@(Get-SafeIgnoredIds -Raw ([pscustomobject]@{ ids = @('aaaaaaaaaaaa') })) -join ',') | Should Be 'aaaaaaaaaaaa'
        @(Get-SafeIgnoredIds -Raw $null).Count | Should Be 0
    }
}
Remove-TestRoot $root
