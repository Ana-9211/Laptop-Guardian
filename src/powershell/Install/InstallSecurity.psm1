#requires -Version 5.1
# Install security: what makes a folder safe to run administrator code from, how the administrators-only data folder is created and
# verified, and how elevated runs treat files that ordinary programs can edit (config, policy, ignore lists) as untrusted input.
Set-StrictMode -Version 2.0

# Principals that may change files that elevated code runs from: SYSTEM, Administrators, TrustedInstaller. (CREATOR OWNER only ever
# applies to what its owner creates, and the owner is checked separately.)
$script:TrustedWriterSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', 'S-1-3-0')
$script:TrustedOwnerSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$script:ReaderSids = @('S-1-5-32-545')   # Users: read only
# Every right that lets someone change, add, delete or take over a file or folder (including the generic write and all bits).
$script:WriteRightsMask = [int](
    [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor
    0x40000000 -bor 0x10000000)   # GenericWrite, GenericAll

function Get-PathAcl { param([string]$Path) Get-Acl -LiteralPath $Path }   # thin wrapper (mocked in tests)

function ConvertTo-Sid {
    param($Identity)
    try { return $Identity.Translate([Security.Principal.SecurityIdentifier]).Value } catch { return [string]$Identity }
}

function Get-UntrustedWriters {
    <# Who, other than SYSTEM / Administrators / TrustedInstaller, can modify this path (or owns it)? Returns descriptions; empty = safe. #>
    param([Parameter(Mandatory)][string]$Path, [string[]]$AllowedOwnerSids = $script:TrustedOwnerSids)
    $found = New-Object System.Collections.ArrayList
    $acl = Get-PathAcl -Path $Path
    $owner = ConvertTo-Sid $acl.GetOwner([Security.Principal.SecurityIdentifier])
    if ($AllowedOwnerSids -notcontains $owner) { [void]$found.Add("owner $owner") }
    foreach ($r in $acl.Access) {
        if ($r.AccessControlType -ne 'Allow') { continue }
        if (([int]$r.FileSystemRights -band $script:WriteRightsMask) -eq 0) { continue }
        $sid = ConvertTo-Sid $r.IdentityReference
        if ($script:TrustedWriterSids -contains $sid) { continue }
        [void]$found.Add("$($r.IdentityReference) ($sid)")
    }
    return @($found | Select-Object -Unique)
}

function Test-InstallTrusted {
    <# Can administrator code safely run from this copy of Laptop Guardian? Not in a development checkout (no install.json), and not
       from any folder an ordinary program can change: the program folder, its parents, the PowerShell tree, and the catalog.
       Returns @{ trusted; install; problems; fix }. There is no switch or variable that makes an untrusted copy trusted. #>
    param([string]$CodeRoot = (Get-GuardianCodeRoot), $Install = (Get-GuardianInstall), [string[]]$AllowedOwnerSids = $script:TrustedOwnerSids)
    $problems = New-Object System.Collections.ArrayList
    if (-not $Install) {
        [void]$problems.Add("This is a development checkout ($CodeRoot), not an installed copy. Files in a checkout can be edited by your own account and by any program you run.")
    } else {
        $targets = New-Object System.Collections.ArrayList
        $p = $CodeRoot.TrimEnd([char]92)
        while ($p) { [void]$targets.Add($p); $parent = Split-Path -Parent $p; if (-not $parent -or $parent -eq $p) { break }; $p = $parent }
        foreach ($rel in 'src\powershell', 'src\shared\action-catalog.json', 'install.json') { [void]$targets.Add((Join-Path $CodeRoot $rel)) }
        $psDir = Join-Path $CodeRoot 'src\powershell'
        if (Test-Path -LiteralPath $psDir) { foreach ($d in @(Get-ChildItem -LiteralPath $psDir -Directory -Recurse -ErrorAction SilentlyContinue)) { [void]$targets.Add($d.FullName) } }
        foreach ($t in @($targets | Select-Object -Unique)) {
            if (-not (Test-Path -LiteralPath $t)) { [void]$problems.Add("$t is missing."); continue }
            $w = @(Get-UntrustedWriters -Path $t -AllowedOwnerSids $AllowedOwnerSids)
            if ($w.Count) { [void]$problems.Add("$t can be changed by: $($w -join ', ').") }
        }
    }
    $fix = if (-not $Install) { "To use administrator actions, open PowerShell as administrator, go to the Laptop Guardian folder, run  .\Install-LaptopGuardian.ps1  and then open Laptop Guardian from the Start Menu shortcut it creates." } else { "Run  .\Install-LaptopGuardian.ps1  again from a PowerShell window opened as administrator. It reinstalls the program files into Program Files with administrator-only permissions." }
    [pscustomobject]@{ trusted = ($problems.Count -eq 0); install = $Install; problems = @($problems); fix = $fix }
}

function Get-UntrustedInstallMessage {
    param($Result)
    "Administrator actions are refused from this copy of Laptop Guardian. $(@($Result.problems | Select-Object -First 3) -join ' ') $($Result.fix)"
}

function Assert-ElevatedCodeTrusted {
    <# Entry points that run (or start) administrator code call this. Standard-user runs are never blocked. Throws with the exact fix. #>
    param([switch]$WillElevate)
    if (-not $WillElevate -and -not (Test-IsAdmin)) { return }
    $r = Test-InstallTrusted
    if ($r.trusted) { return }
    $msg = Get-UntrustedInstallMessage -Result $r
    try { [void](Write-GuardianEvent -Category system -Action 'install:untrusted-refused' -Result skipped -Severity warning -Reason $msg) } catch { }
    throw $msg
}

# ---------- the administrators-only folder (elevated results, audit lines, backups) ----------
function New-ProtectedDirectory {
    <# Creates the folder with an explicit ACL: SYSTEM and Administrators full control, Users read-only, NO inheritance from the parent.
       Then verifies it by reading the ACL back and throws loudly if it is not exactly that. #>
    param([Parameter(Mandatory)][string]$Path, [string[]]$AllowedOwnerSids = $script:TrustedOwnerSids)
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)   # no inheritance, and drop whatever was inherited
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $none = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $sid), [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $none, $allow)))
    }
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545'), [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inherit, $none, $allow)))
    # Only the permissions are written (not owner or group), so this needs nothing beyond the right to change permissions on the folder.
    [IO.Directory]::SetAccessControl($Path, $acl)
    $problems = @(Test-ProtectedDirectoryAcl -Path $Path -AllowedOwnerSids $AllowedOwnerSids)
    if ($problems.Count) { throw "The permissions on '$Path' are not what the installer set: $($problems -join '; '). Nothing was trusted. Run the installer again from an administrator PowerShell, and check the folder's Security tab." }
}

function Test-ProtectedDirectoryAcl {
    <# Returns what is wrong with the folder's permissions (empty = exactly as intended). #>
    param([Parameter(Mandatory)][string]$Path, [string[]]$AllowedOwnerSids = $script:TrustedOwnerSids)
    $bad = New-Object System.Collections.ArrayList
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return @("'$Path' does not exist") }
    $acl = Get-PathAcl -Path $Path
    if (-not $acl.AreAccessRulesProtected) { [void]$bad.Add('it inherits permissions from its parent folder') }
    $owner = ConvertTo-Sid $acl.GetOwner([Security.Principal.SecurityIdentifier])
    if ($AllowedOwnerSids -notcontains $owner) { [void]$bad.Add("it is owned by $owner") }
    $sawAdmins = $false; $sawSystem = $false
    foreach ($r in $acl.Access) {
        if ($r.AccessControlType -ne 'Allow') { continue }
        $sid = ConvertTo-Sid $r.IdentityReference
        $writes = (([int]$r.FileSystemRights -band $script:WriteRightsMask) -ne 0)
        if ($r.IsInherited) { [void]$bad.Add("rule for $sid is inherited") }
        if ($sid -eq 'S-1-5-32-544' -and $writes) { $sawAdmins = $true }
        elseif ($sid -eq 'S-1-5-18' -and $writes) { $sawSystem = $true }
        elseif ($writes -and ($script:TrustedWriterSids -notcontains $sid)) { [void]$bad.Add("$($r.IdentityReference) can write") }
        elseif (-not $writes -and ($script:ReaderSids -notcontains $sid) -and ($script:TrustedWriterSids -notcontains $sid)) { [void]$bad.Add("unexpected permission for $($r.IdentityReference)") }
    }
    if (-not $sawAdmins) { [void]$bad.Add('Administrators do not have full control') }
    if (-not $sawSystem) { [void]$bad.Add('SYSTEM does not have full control') }
    return @($bad)
}

# ---------- elevated runs do not trust files that ordinary programs can edit ----------
$script:ConfigLimits = [ordered]@{
    'cleanup.tempMinAgeDays' = @(1, 365); 'storage.minLargeFileMB' = @(1, 1000000); 'storage.oldFileDays' = @(1, 3650); 'storage.duplicateMinMB' = @(1, 100000)
    'thresholds.cpuPct' = @(1, 100); 'thresholds.memoryMB' = @(50, 1000000); 'thresholds.diskFreeWarnPct' = @(1, 90); 'thresholds.diskFreeCritPct' = @(1, 89)
    'retention.reportsDays' = @(0, 3650); 'retention.metricsRawDays' = @(30, 730); 'retention.auditRawDays' = @(30, 730); 'ai.maxRequestsPerRun' = @(0, 500); 'ai.maxProcessesPerRun' = @(0, 100); 'ai.dailyTokenBudget' = @(0, 50000000)
}

function Limit-ConfigForElevation {
    <# config.json lives in a folder the user (and any program the user runs) can edit, and an elevated run must not let it steer
       administrator work. Numbers are clamped to the same ranges the dashboard enforces, booleans are coerced, drive letters are
       validated, and malformed folder entries are dropped. No path from the config is ever used as something to delete: cleanup
       targets are a fixed list in the program. #>
    param([Parameter(Mandatory)]$Config)
    $c = $Config
    foreach ($key in $script:ConfigLimits.Keys) {
        $parts = $key.Split('.'); $section = $c.($parts[0])
        if ($null -eq $section -or -not $section.PSObject.Properties[$parts[1]]) { continue }
        $lo, $hi = $script:ConfigLimits[$key]
        $v = 0.0
        if ([double]::TryParse([string]$section.($parts[1]), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$v) -and -not [double]::IsNaN($v)) {
            # clamp as doubles first: a value like 1e12 must be pulled back, not overflow a 32-bit integer
            $section.($parts[1]) = [int][math]::Min([double]$hi, [math]::Max([double]$lo, [math]::Round($v)))
        } else { $section.($parts[1]) = $lo }
    }
    if ($c.thresholds.diskFreeCritPct -ge $c.thresholds.diskFreeWarnPct) { $c.thresholds.diskFreeCritPct = [math]::Max(1, $c.thresholds.diskFreeWarnPct - 1) }
    foreach ($b in 'tempFiles', 'crashDumps', 'caches') { if ($c.cleanup.$b -isnot [bool]) { $c.cleanup.$b = $false } }
    if ($c.cleanup.recycleBin -notin 'never', 'always') { $c.cleanup.recycleBin = 'never' }
    if ($c.storage.duplicateScan -isnot [bool]) { $c.storage.duplicateScan = $false }
    $c.storage.drives = @(@($c.storage.drives) | Where-Object { $_ -is [string] -and $_ -match '^[A-Za-z]:$' } | Select-Object -First 8)
    if (-not @($c.storage.drives).Count) { $c.storage.drives = @($env:SystemDrive) }
    foreach ($k in 'excludedDirs', 'protectedDirs') {
        $c.storage.$k = @(@($c.storage.$k) | Where-Object { $_ -is [string] -and $_.Length -le 500 -and $_ -match '^[A-Za-z]:\\' -and $_ -notmatch '[*?<>|"]' } | Select-Object -First 200)
    }
    return $c
}

function Get-SafeIgnoredIds {
    <# The ignored-files list is a plain array of file ids written by the dashboard. Only well-formed ids are used (and only as lookup keys). #>
    param($Raw)
    $ids = if ($Raw -is [array]) { @($Raw) } elseif ($Raw -and $Raw.PSObject.Properties['ids']) { @($Raw.ids) } else { @() }
    return @($ids | Where-Object { $_ -is [string] -and $_ -match '^[0-9a-f]{12}$' } | Select-Object -First 100000)
}

Export-ModuleMember -Function Get-PathAcl, Get-UntrustedWriters, Test-InstallTrusted, Get-UntrustedInstallMessage, Assert-ElevatedCodeTrusted, New-ProtectedDirectory, Test-ProtectedDirectoryAcl, Limit-ConfigForElevation, Get-SafeIgnoredIds
