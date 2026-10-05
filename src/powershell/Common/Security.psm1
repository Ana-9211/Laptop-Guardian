#requires -Version 5.1
# Security: protected processes/paths, command allowlist, recycle-bin deletion, AI output validation.
Set-StrictMode -Version 2.0

# Processes that must never be terminated by Guardian, regardless of policy or user request.
$script:ProtectedProcessNames = @(
    'system', 'idle', 'registry', 'memory compression', 'secure system', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso',
    'svchost', 'dwm', 'fontdrvhost', 'explorer', 'sihost', 'taskhostw', 'ctfmon', 'runtimebroker', 'shellexperiencehost', 'startmenuexperiencehost',
    'searchhost', 'textinputhost', 'applicationframehost', 'conhost', 'dllhost', 'wudfhost', 'spoolsv', 'audiodg', 'logonui', 'userinit',
    'msmpeng', 'nissrv', 'securityhealthservice', 'securityhealthsystray', 'smartscreen', 'mpdefendercoreservice', 'wlms', 'sgrmbroker',
    'msedgewebview2', 'taskmgr', 'powershell', 'pwsh', 'cmd', 'node', 'claude', 'wmiprvse', 'dasHost', 'lsm', 'vmmem', 'vmcompute', 'vmwp'
) | ForEach-Object { $_.ToLowerInvariant() }

$script:ProtectedServiceNames = @('wdfilter', 'windefend', 'wscsvc', 'mpssvc', 'bfe', 'rpcss', 'dcomlaunch', 'eventlog', 'lsm', 'samss', 'wuauserv', 'trustedinstaller', 'winmgmt', 'sppsvc', 'cryptsvc', 'dnscache', 'dhcp', 'netlogon', 'schedule', 'profsvc', 'power', 'plugplay', 'sens', 'themes', 'audiosrv', 'spooler', 'securityhealthservice', 'sense', 'wlidsvc')

# Windows' own process names. A process using one of these names is only treated as the real thing when it runs from the Windows
# folder or carries a valid Microsoft signature; a copy anywhere else is a lookalike (see Test-ProcessKillAllowed). Every name here is also in
# ProtectedProcessNames above, so the name-based protection is unchanged for genuine ones.
$script:WindowsCoreProcessNames = @('smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso', 'svchost', 'dwm', 'fontdrvhost', 'explorer', 'sihost', 'taskhostw', 'ctfmon', 'runtimebroker', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost', 'textinputhost', 'applicationframehost', 'conhost', 'dllhost', 'wudfhost', 'spoolsv', 'audiodg', 'logonui', 'userinit', 'wmiprvse', 'dashost', 'lsm') | ForEach-Object { $_.ToLowerInvariant() }

function Get-ProtectedProcessNames { $script:ProtectedProcessNames }
function Get-WindowsCoreProcessNames { $script:WindowsCoreProcessNames }
function Test-UnderSystemRoot {
    # With the trailing backslash: C:\WindowsFake\x.exe is NOT under C:\Windows.
    param([string]$Path)
    if (-not $Path -or -not $env:SystemRoot) { return $false }
    return $Path.StartsWith($env:SystemRoot.TrimEnd([char]92) + [char]92, [System.StringComparison]::OrdinalIgnoreCase)
}
function Get-ImageTrust {
    # Thin wrapper (mocked in tests): is the file's signature valid, and is it Microsoft's?
    param([string]$Path)
    try {
        $s = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
        return [pscustomobject]@{ valid = ([string]$s.Status -eq 'Valid'); microsoft = [bool]($s.SignerCertificate -and $s.SignerCertificate.Subject -match 'O=Microsoft Corporation') }
    } catch { return [pscustomobject]@{ valid = $false; microsoft = $false } }
}
function Get-ProtectedServiceNames { $script:ProtectedServiceNames }

function Get-ProtectedPathPrefixes {
    $list = New-Object System.Collections.ArrayList
    foreach ($p in @($env:SystemRoot, $env:windir, ${env:ProgramFiles}, ${env:ProgramFiles(x86)}, $env:ProgramData, (Join-Path $env:SystemDrive '\Recovery'), (Join-Path $env:SystemDrive '\$Recycle.Bin'), (Join-Path $env:SystemDrive '\System Volume Information'), (Join-Path $env:SystemDrive '\Boot'), (Join-Path $env:SystemDrive '\EFI'))) {
        if ($p) { [void]$list.Add($p.TrimEnd('\')) }
    }
    return @($list | Select-Object -Unique)
}

function Get-LongPathName {
    <# Expands 8.3 short names (PROGRA~1) so a prefix check cannot be dodged by spelling a protected folder the short way. Resolves the longest part that exists. #>
    param([string]$Path)
    try {
        if (-not ('Guardian.NativePath' -as [type])) {
            Add-Type -Namespace Guardian -Name NativePath -UsingNamespace System.Text -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetLongPathName(string shortPath, StringBuilder longPath, uint size);'
        }
        $existing = $Path; $tail = ''
        while ($existing -and -not (Test-Path -LiteralPath $existing)) {
            $parent = Split-Path -Parent $existing
            if (-not $parent -or $parent -eq $existing) { return $Path }
            $tail = '\' + (Split-Path -Leaf $existing) + $tail; $existing = $parent
        }
        $sb = New-Object System.Text.StringBuilder 1024
        $n = [Guardian.NativePath]::GetLongPathName($existing, $sb, 1024)
        if ($n -gt 0 -and $n -lt 1024) { return $sb.ToString().TrimEnd('\') + $tail }
    } catch { }
    return $Path
}

function Test-ProtectedPath {
    param([string]$Path, [string[]]$ExtraProtected = @())
    if ([string]::IsNullOrWhiteSpace($Path)) { return $true }
    try { $full = Get-LongPathName ([System.IO.Path]::GetFullPath($Path).TrimEnd('\')) } catch { return $true }
    # Other people's profiles: only the current user's own folders may be touched under C:\Users.
    if ($env:SystemDrive -and $env:USERPROFILE) {
        $usersRoot = (Join-Path $env:SystemDrive 'Users').TrimEnd('\'); $mine = $env:USERPROFILE.TrimEnd('\')
        if ($full -ieq $usersRoot) { return $true }
        if ($full.StartsWith($usersRoot + '\', [System.StringComparison]::OrdinalIgnoreCase) -and -not ($full -ieq $mine -or $full.StartsWith($mine + '\', [System.StringComparison]::OrdinalIgnoreCase))) { return $true }
    }
    # Drive root or user profile root
    if ($full -match '^[A-Za-z]:$') { return $true }
    if ($env:USERPROFILE -and ($full -ieq $env:USERPROFILE.TrimEnd('\'))) { return $true }
    $all = @(Get-ProtectedPathPrefixes) + @($ExtraProtected | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') })
    foreach ($pre in $all) {
        if ($full -ieq $pre -or $full.StartsWith($pre + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Test-ProcessKillAllowed {
    <# Returns @{Allowed;Reason}. Never allows protected names, Windows-directory binaries, or Guardian's own process chain. #>
    param([string]$Name, [string]$Path, [int]$ProcessId)
    $n = ($Name -replace '\.exe$', '').ToLowerInvariant()
    if ($ProcessId -le 4) { return [pscustomobject]@{ Allowed = $false; Suspicious = $false; Reason = 'PID is a reserved system PID' } }
    if ($ProcessId -eq $PID) { return [pscustomobject]@{ Allowed = $false; Suspicious = $false; Reason = 'Cannot terminate the Guardian process itself' } }
    # A Windows system name running from somewhere else, without a valid Microsoft signature, is a lookalike: possibly malware hiding
    # behind a trusted name. It is allowed to be stopped, but only with an extra acknowledgement and never automatically.
    if ($script:WindowsCoreProcessNames -contains $n -and $Path -and -not (Test-UnderSystemRoot $Path)) {
        $trust = Get-ImageTrust -Path $Path
        if (-not ($trust.valid -and $trust.microsoft)) {
            return [pscustomobject]@{ Allowed = $true; Suspicious = $true; Reason = "'$n' is a Windows system name, but this copy is not in the Windows folder and is not signed by Microsoft" }
        }
    }
    if ($script:ProtectedProcessNames -contains $n) { return [pscustomobject]@{ Allowed = $false; Suspicious = $false; Reason = "'$n' is on the protected process list" } }
    if (Test-UnderSystemRoot $Path) {
        return [pscustomobject]@{ Allowed = $false; Suspicious = $false; Reason = 'Executable lives under the Windows directory' }
    }
    return [pscustomobject]@{ Allowed = $true; Suspicious = $false; Reason = 'ok' }
}

# ---------- Command allowlist (display-only commands shown on the dashboard; never executed by Guardian from strings) ----------
$script:AllowedCommandPatterns = @(
    '^Stop-Process -Id \d{1,10}( -Force)?$',
    '^Stop-Process -Name [A-Za-z0-9_.\-]{1,64}( -Force)?$',
    '^taskkill /PID \d{1,10}( /F)?$',
    '^Stop-Service -Name [A-Za-z0-9_.\-]{1,64}( -Force)?$',
    '^Set-Service -Name [A-Za-z0-9_.\-]{1,64} -StartupType (Disabled|Manual|Automatic)$',
    '^Disable-ScheduledTask -TaskName ''[^''`;|&<>$]{1,120}''( -TaskPath ''[^''`;|&<>$]{1,120}'')?$',
    '^Remove-ItemProperty -Path ''(HKCU|HKLM):\\Software\\(WOW6432Node\\)?Microsoft\\Windows\\CurrentVersion\\Run(Once)?'' -Name ''[^''`;|&<>$]{1,120}''$',
    '^Get-Process -Id \d{1,10}$',
    '^Get-CimInstance Win32_Service -Filter "Name=''[A-Za-z0-9_.\-]{1,64}''"$',
    '^Start-Process ms-settings:startupapps$',
    '^Start-Process taskschd\.msc$',
    '^Start-Process appwiz\.cpl$',
    '^Remove-Item -LiteralPath ''[^''`;|&<>$]{1,260}'' -WhatIf$'
)

function Test-CommandAllowed {
    param([string]$Command)
    if ([string]::IsNullOrWhiteSpace($Command)) { return $false }
    if ($Command.Length -gt 400) { return $false }
    if ($Command -match '[\r\n\x00-\x08\x0B\x0C\x0E-\x1F]') { return $false }
    $okPattern = $false
    foreach ($p in $script:AllowedCommandPatterns) { if ($Command -match $p) { $okPattern = $true; break } }
    if (-not $okPattern) { return $false }
    # Never allow commands that target protected processes/services or reserved PIDs
    if ($Command -match '^(Stop-Process|Stop-Service|Set-Service) -Name ([A-Za-z0-9_.\-]+)') { $n = ($Matches[2] -replace '\.exe$', '').ToLowerInvariant(); if ($script:ProtectedProcessNames -contains $n -or $script:ProtectedServiceNames -contains $n) { return $false } }
    if ($Command -match '^(Stop-Process -Id|taskkill /PID) (\d+)') { if ([int64]$Matches[2] -le 4) { return $false } }
    return $true
    return $false
}

# ---------- Recycle Bin ----------
function Get-RecycleVolumeFacts {
    # Thin wrapper (mocked in tests): what kind of volume holds this path, and which Recycle Bin settings apply to it.
    param([string]$Drive)   # "C:"
    $ld = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$Drive'" -ErrorAction SilentlyContinue
    $vol = Get-CimInstance Win32_Volume -Filter "DriveLetter='$Drive'" -ErrorAction SilentlyContinue
    $guid = $null; if ($vol -and $vol.DeviceID -match '\{[0-9a-fA-F-]+\}') { $guid = $Matches[0] }
    $nuke = $false; $maxMB = $null
    if ($guid) {
        try { $k = Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\$guid" -ErrorAction Stop
            if ($k.PSObject.Properties['NukeOnDelete']) { $nuke = ([int]$k.NukeOnDelete -eq 1) }
            if ($k.PSObject.Properties['MaxCapacity']) { $maxMB = [int64]$k.MaxCapacity } } catch { }
    }
    [pscustomobject]@{ driveType = $(if ($ld) { [int]$ld.DriveType } else { 0 }); fileSystem = $(if ($ld) { [string]$ld.FileSystem } else { '' }); capacityBytes = $(if ($ld) { [int64]$ld.Size } else { 0 }); nukeOnDelete = $nuke; maxCapacityMB = $maxMB }
}

function Test-RecycleBinSafe {
    <# $null when the Recycle Bin will really keep this file; otherwise the reason it would not (the file would be deleted permanently). #>
    param([string]$Path, [int64]$SizeBytes)
    $drive = [IO.Path]::GetPathRoot($Path).TrimEnd('\')
    if ($drive -notmatch '^[A-Za-z]:$') { return 'Only files on a local drive letter are recycled.' }
    $f = Get-RecycleVolumeFacts -Drive $drive
    if ($f.driveType -ne 3) { return "$drive is not a fixed disk. Windows deletes files from removable and network drives permanently instead of recycling them." }
    if ($f.fileSystem -notin 'NTFS', 'ReFS') { return "$drive uses $($f.fileSystem). Only NTFS and ReFS volumes have a working Recycle Bin." }
    if ($f.nukeOnDelete) { return "The Recycle Bin is switched off for $drive (files are deleted immediately). Turn it on in the Recycle Bin properties first." }
    $limit = if ($f.maxCapacityMB) { [int64]$f.maxCapacityMB * 1MB } else { [int64]($f.capacityBytes * 0.10) }
    if ($limit -gt 0 -and $SizeBytes -gt $limit) { return 'This file is larger than the Recycle Bin can hold, so Windows would delete it permanently.' }
    return $null
}

function Find-RecycledItem {
    <# $true when this user's Recycle Bin on the drive holds an entry whose original path is $OriginalPath (read from the $I metadata files). #>
    param([string]$OriginalPath, [int]$WithinMinutes = 5)
    try {
        $drive = [IO.Path]::GetPathRoot($OriginalPath)
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $bin = Join-Path $drive "`$Recycle.Bin\$sid"
        if (-not (Test-Path -LiteralPath $bin)) { return $false }
        $cut = (Get-Date).AddMinutes(-$WithinMinutes)
        foreach ($i in @(Get-ChildItem -LiteralPath $bin -Force -Filter '$I*' -ErrorAction Stop | Where-Object { $_.LastWriteTime -gt $cut })) {
            $b = [IO.File]::ReadAllBytes($i.FullName)
            if ($b.Length -lt 28) { continue }
            $ver = [BitConverter]::ToInt64($b, 0)
            $p = if ($ver -eq 2) { $n = [BitConverter]::ToInt32($b, 24); [Text.Encoding]::Unicode.GetString($b, 28, [math]::Min([math]::Max(0, ($n - 1) * 2), $b.Length - 28)) } else { [Text.Encoding]::Unicode.GetString($b, 24, [math]::Min(520, $b.Length - 24)).TrimEnd([char]0) }
            if ($p -ieq $OriginalPath) { return $true }
        }
    } catch { }
    return $false
}

function Move-ToRecycleBin {
    param([Parameter(Mandatory)][string]$Path, [string[]]$ProtectedDirs = @())
    if (Test-ProtectedPath -Path $Path -ExtraProtected $ProtectedDirs) { throw "Path is protected: $Path" }
    if (-not (Test-Path -LiteralPath $Path)) { throw "Path no longer exists: $Path" }
    Add-Type -AssemblyName Microsoft.VisualBasic
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer) { throw 'Directories are not recycled by Guardian; select individual files.' }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not recycled.' }
    $why = Test-RecycleBinSafe -Path $item.FullName -SizeBytes ([int64]$item.Length)
    if ($why) { throw "Not recycled: $why" }
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($item.FullName, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
    if (-not (Find-RecycledItem -OriginalPath $item.FullName)) { throw 'The file is gone, but it was not found in the Recycle Bin, so it may have been deleted permanently. Check the Recycle Bin before assuming it can be restored.' }
    return $true
}

# ---------- AI response validation ----------
$script:AiRisk = @('LOW', 'MEDIUM', 'HIGH', 'UNKNOWN')
$script:AiActions = @('Leave running', 'Review', 'Stop temporarily', 'Disable startup', 'Disable scheduled task', 'Uninstall associated application', 'Investigate further')
$script:AiClass = @('windows-component', 'known-application', 'third-party-service', 'driver-utility', 'user-application', 'development-tool', 'security-software', 'unknown', 'potentially-unwanted', 'suspicious')

function Clean-AiText {
    param($Value, [int]$Max = 600)
    if ($null -eq $Value) { return '' }
    $s = [string]$Value
    $s = $s -replace '[\x00-\x08\x0B\x0C\x0E-\x1F]', ''
    $s = $s -replace '<[^>]{0,200}>', ''    # strip markup
    if ($s.Length -gt $Max) { $s = $s.Substring(0, $Max) }
    return $s.Trim()
}

function Test-AiAnalysis {
    <# Validate a parsed Gemini process analysis. Returns @{Valid;Errors;Value}. Value is a sanitised, schema-clean object. #>
    param($Raw)
    $errors = New-Object System.Collections.ArrayList
    if ($null -eq $Raw -or $Raw -isnot [psobject]) { return [pscustomobject]@{ Valid = $false; Errors = @('Response is not a JSON object'); Value = $null } }
    $names = @((Get-PropNames $Raw))
    foreach ($req in 'classification', 'what_is_it', 'why_flagged', 'risk', 'suggested_action', 'confidence') {
        if ($names -notcontains $req) { [void]$errors.Add("Missing field: $req") }
    }
    if ($errors.Count -gt 0) { return [pscustomobject]@{ Valid = $false; Errors = @($errors); Value = $null } }

    $opt = @{}; foreach ($n in 'warnings', 'evidence', 'persistence', 'consequences', 'temporary_stop_method', 'persistence_removal_method') { $opt[$n] = $(if ((Get-PropNames $Raw) -contains $n) { $Raw.$n } else { $null }) }
    $risk = ([string]$Raw.risk).ToUpperInvariant()
    if ($script:AiRisk -notcontains $risk) { [void]$errors.Add("Invalid risk '$($Raw.risk)'") }
    $action = [string]$Raw.suggested_action
    $match = $script:AiActions | Where-Object { $_ -ieq $action } | Select-Object -First 1
    if (-not $match) { [void]$errors.Add("Invalid suggested_action '$action'") } else { $action = $match }
    $conf = 0.0
    if (-not [double]::TryParse(([string]$Raw.confidence), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$conf)) { [void]$errors.Add('confidence not numeric') }
    elseif ($conf -gt 1 -and $conf -le 100) { $conf = $conf / 100 }
    if ([double]::IsNaN($conf) -or [double]::IsInfinity($conf) -or -not ($conf -ge 0 -and $conf -le 1)) { [void]$errors.Add('confidence out of range') }
    $cls = [string]$Raw.classification
    $clsMatch = $script:AiClass | Where-Object { $_ -ieq $cls } | Select-Object -First 1
    $cls = if ($clsMatch) { $clsMatch } else { 'unknown' }
    if ($errors.Count -gt 0) { return [pscustomobject]@{ Valid = $false; Errors = @($errors); Value = $null } }

    $warnings = New-Object System.Collections.ArrayList
    foreach ($w in @($opt.warnings)) { if ($w) { [void]$warnings.Add((Clean-AiText $w 300)) } }

    $stop = Clean-AiText $opt.temporary_stop_method 400
    if ($stop -and -not (Test-CommandAllowed $stop)) {
        [void]$warnings.Add('AI-suggested stop command rejected by local allowlist; use the locally generated command.')
        $stop = ''
    }
    $remove = Clean-AiText $opt.persistence_removal_method 400
    if ($remove -and -not (Test-CommandAllowed $remove)) {
        [void]$warnings.Add('AI-suggested persistence-removal command rejected by local allowlist; use the locally generated procedure.')
        $remove = ''
    }
    $ev = @(); foreach ($e in @($opt.evidence)) { if ($e) { $ev += (Clean-AiText $e 300) } }

    $val = [ordered]@{
        classification = $cls; what_is_it = (Clean-AiText $Raw.what_is_it 800); why_flagged = (Clean-AiText $Raw.why_flagged 800)
        risk = $risk; persistence = (Clean-AiText $opt.persistence 400); suggested_action = $action
        temporary_stop_method = $stop; persistence_removal_method = $remove; consequences = (Clean-AiText $opt.consequences 600)
        confidence = [math]::Round($conf, 2); evidence = @($ev | Select-Object -First 8); warnings = @($warnings | Select-Object -First 8)
        validated = $true
    }
    return [pscustomobject]@{ Valid = $true; Errors = @(); Value = [pscustomobject]$val }
}

Export-ModuleMember -Function *
