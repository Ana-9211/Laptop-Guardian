#requires -Version 5.1
# Remediation: the ONLY executable fixes Laptop Guardian offers. Every action is a fixed, allowlisted template from
# src/shared/action-catalog.json. Parameters are validated against the catalog, live identity is re-checked immediately
# before acting, protected targets are refused, and the outcome is verified by reading the system back.
# Nothing here ever runs a string supplied by a user, a recommendation, or an AI model.
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'RemHelpers.psm1') -Force -DisableNameChecking -Global
Import-Module (Join-Path $PSScriptRoot 'NetworkActions.psm1') -Force -DisableNameChecking -Global

$script:CatalogPath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'shared\action-catalog.json'
$script:Catalog = $null
$script:RevoShortcut = 'C:\Users\Public\Desktop\Revo Uninstaller.lnk'

function Get-ActionCatalog {
    if (-not $script:Catalog) { $script:Catalog = Get-Content -LiteralPath $script:CatalogPath -Raw | ConvertFrom-Json }
    return $script:Catalog
}
function Get-ActionSpec {
    param([string]$Id)
    $c = Get-ActionCatalog
    return @($c.actions | Where-Object { $_.id -eq $Id })[0]
}

function Test-ActionParams {
    <# Validates a params hashtable against the catalog spec: no unknown keys, required keys present, patterns and enums respected. #>
    param($Spec, [hashtable]$Params)
    $errs = New-Object System.Collections.ArrayList
    $catalog = Get-ActionCatalog
    $declared = @($Spec.params.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($k in $Params.Keys) { if ($k -like '_*') { continue }; if ($declared -notcontains $k) { [void]$errs.Add("Unexpected parameter '$k'") } }
    foreach ($d in $declared) {
        $def = $Spec.params.$d
        $optional = ($def.PSObject.Properties.Name -contains 'optional') -and $def.optional
        $has = $Params.ContainsKey($d) -and $null -ne $Params[$d] -and ([string]$Params[$d]) -ne ''
        if (-not $has) { if (-not $optional) { [void]$errs.Add("Missing parameter '$d'") }; continue }
        $v = [string]$Params[$d]
        if ($def.PSObject.Properties.Name -contains 'enum') { if (@($def.enum) -cnotcontains $v) { [void]$errs.Add("Parameter '$d' must be one of: $(@($def.enum) -join ', ')") } }
        elseif ($def.PSObject.Properties.Name -contains 'pattern') {
            $rx = $catalog.patterns.($def.pattern)
            if ($v -notmatch $rx) { [void]$errs.Add("Parameter '$d' has an invalid format") }
        }
    }
    return $errs   # callers wrap the result in @() so zero errors really is an empty array
}

# ---------- thin wrappers over the system (mocked in tests) ----------
function Get-LiveProcessInfo {
    param([int]$ProcessId)
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { return $null }
    $path = $null; $cmd = $null
    try { $w = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop; $path = $w.ExecutablePath; $cmd = $w.CommandLine } catch { }
    if (-not $path) { try { $path = $p.Path } catch { } }
    $start = $null; try { $start = $p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss') } catch { }
    [pscustomobject]@{ Name = $p.ProcessName; Path = $path; StartTime = $start; CommandLine = $cmd }
}
function Test-AdminNow { Test-IsAdmin }
function Get-GuardianRootPath { if ($env:GUARDIAN_ROOT) { $env:GUARDIAN_ROOT } else { Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) } }

function Get-RunLocationInfo {
    <# Maps a startup entry location to the StartupApproved key that Windows itself uses to enable/disable it. #>
    param([string]$Kind, [string]$Location)
    $loc = $Location.TrimEnd('\')
    if ($Kind -eq 'registry') {
        $map = @{
            'HKCU:\software\microsoft\windows\currentversion\run'              = @{ Approved = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'; Hive = 'HKCU' }
            'HKLM:\software\microsoft\windows\currentversion\run'              = @{ Approved = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'; Hive = 'HKLM' }
            'HKLM:\software\wow6432node\microsoft\windows\currentversion\run'  = @{ Approved = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32'; Hive = 'HKLM' }
        }
        $k = $loc.ToLowerInvariant()
        if ($map.ContainsKey($k)) { return [pscustomobject]@{ Source = $Location; Approved = $map[$k].Approved; Hive = $map[$k].Hive } }
        return $null
    }
    $user = [Environment]::GetFolderPath('Startup'); $common = [Environment]::GetFolderPath('CommonStartup')
    if ($user -and ($loc -ieq $user.TrimEnd('\'))) { return [pscustomobject]@{ Source = $Location; Approved = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'; Hive = 'HKCU' } }
    if ($common -and ($loc -ieq $common.TrimEnd('\'))) { return [pscustomobject]@{ Source = $Location; Approved = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'; Hive = 'HKLM' } }
    return $null
}
function Test-StartupEntryExists {
    param([string]$Kind, [string]$Name, [string]$Location)
    if ($Kind -eq 'registry') {
        if (-not (Test-Path -LiteralPath $Location)) { return $null }
        $props = Get-ItemProperty -LiteralPath $Location -ErrorAction SilentlyContinue
        if ($props -and ($props.PSObject.Properties.Name -contains $Name)) { return $Name }
        return $null
    }
    $f = @(Get-ChildItem -LiteralPath $Location -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -ieq $Name -or $_.Name -ieq $Name })
    if ($f.Count -eq 1) { return $f[0].Name }
    return $null
}
function Get-StartupApprovedByte {
    param([string]$ApprovedKey, [string]$ValueName)
    try { $v = (Get-ItemProperty -LiteralPath $ApprovedKey -Name $ValueName -ErrorAction Stop).$ValueName; if ($v -is [byte[]] -and $v.Length -ge 1) { return [int]$v[0] } } catch { }
    return 2 # no flag recorded means enabled
}
function Set-StartupApprovedByte {
    param([string]$ApprovedKey, [string]$ValueName, [bool]$Enabled)
    if (-not (Test-Path -LiteralPath $ApprovedKey)) { New-Item -Path $ApprovedKey -Force | Out-Null }
    $bytes = New-Object byte[] 12
    if ($Enabled) { $bytes[0] = 2 } else { $bytes[0] = 3; $ft = [BitConverter]::GetBytes([DateTime]::UtcNow.ToFileTimeUtc()); [Array]::Copy($ft, 0, $bytes, 4, 8) }
    Set-ItemProperty -LiteralPath $ApprovedKey -Name $ValueName -Value $bytes -Type Binary -ErrorAction Stop
}

function Get-TaskForAction { param([string]$TaskPath, [string]$TaskName) Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue }
function Get-ServiceForAction { param([string]$Name) Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue }
function Move-FileToRecycle { param([string]$Path, [string[]]$ProtectedDirs) Move-ToRecycleBin -Path $Path -ProtectedDirs $ProtectedDirs }

function Get-InstalledPrograms {
    <# Read-only list from the standard Uninstall keys. #>
    $keys = @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')
    $out = New-Object System.Collections.ArrayList
    foreach ($k in $keys) {
        foreach ($i in @(Get-ItemProperty -Path $k -ErrorAction SilentlyContinue)) {
            $props = $i.PSObject.Properties.Name
            if ($props -notcontains 'DisplayName' -or -not $i.DisplayName) { continue }
            $sys = ($props -contains 'SystemComponent') -and ($i.SystemComponent -eq 1)
            $upd = ($props -contains 'ParentKeyName') -and $i.ParentKeyName
            [void]$out.Add([pscustomobject]@{
                    name = [string]$i.DisplayName; version = $(if ($props -contains 'DisplayVersion') { [string]$i.DisplayVersion } else { '' })
                    publisher = $(if ($props -contains 'Publisher') { [string]$i.Publisher } else { '' })
                    installLocation = $(if ($props -contains 'InstallLocation' -and $i.InstallLocation) { ([string]$i.InstallLocation).TrimEnd('\') } else { '' })
                    systemComponent = [bool]$sys; isUpdate = [bool]$upd
                })
        }
    }
    return @($out | Sort-Object name -Unique)
}

function Get-RevoInfo {
    <# Read-only inspection of the Revo Uninstaller shortcut: target, signature, version. Never launches anything. #>
    $info = [ordered]@{ available = $false; shortcut = $script:RevoShortcut; target = $null; arguments = $null; version = $null; signed = $false; publisher = $null; supportedOptions = 'none (Guardian starts Revo with no arguments and you choose the program inside Revo)'; reason = $null }
    try {
        if (-not (Test-Path -LiteralPath $script:RevoShortcut)) { $info.reason = 'Revo Uninstaller shortcut was not found.'; return [pscustomobject]$info }
        $l = (New-Object -ComObject WScript.Shell).CreateShortcut($script:RevoShortcut)
        $info.target = $l.TargetPath; $info.arguments = $l.Arguments
        if (-not $l.TargetPath -or -not (Test-Path -LiteralPath $l.TargetPath)) { $info.reason = 'The shortcut target no longer exists.'; return [pscustomobject]$info }
        if ((Split-Path -Leaf $l.TargetPath) -ine 'RevoUnin.exe') { $info.reason = 'The shortcut does not point at RevoUnin.exe, so Guardian will not use it.'; return [pscustomobject]$info }
        $pf = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
        if (-not ($pf | Where-Object { $l.TargetPath.StartsWith($_ + '\', [StringComparison]::OrdinalIgnoreCase) })) { $info.reason = 'Revo is not installed under Program Files, so Guardian will not use it.'; return [pscustomobject]$info }
        $sig = Get-AuthenticodeSignature -FilePath $l.TargetPath
        $info.signed = ($sig.Status -eq 'Valid'); $info.publisher = $(if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { $null })
        $info.version = (Get-Item -LiteralPath $l.TargetPath).VersionInfo.ProductVersion
        if (-not $info.signed) { $info.reason = 'RevoUnin.exe does not have a valid digital signature.'; return [pscustomobject]$info }
        if ($info.publisher -notmatch 'VS Revo') { $info.reason = 'RevoUnin.exe is not signed by VS Revo Group.'; return [pscustomobject]$info }
        $info.available = $true
    } catch { $info.reason = "Could not inspect Revo: $($_.Exception.Message)" }
    return [pscustomobject]$info
}

# ---------- protections ----------
$script:RemoveRefusePattern = '(?i)(defender|windows security|antivirus|anti-virus|firewall|endpoint|malware|\bdriver\b|chipset|firmware|\bbios\b|\.net (framework|runtime|desktop)|visual c\+\+|webview2|windows (update|defender|subsystem)|microsoft (edge|store|update health))'
$script:ProtectedTaskPathRx = '^\\(Microsoft|LaptopGuardian)(\\|$)'

# ---------- process.stop ----------
function Test-ProcessStop {
    param([hashtable]$P)
    $pid0 = [int]$P.pid; $name = [string]$P.name
    $live = Get-LiveProcessInfo -ProcessId $pid0
    if (-not $live) { return New-RemResult -Ok $false -Errors @('That process is no longer running.') }
    if (($live.Name -replace '\.exe$', '') -ine ($name -replace '\.exe$', '')) { return New-RemResult -Ok $false -Errors @("PID $pid0 now belongs to '$($live.Name)', not '$name'. The PID was reused; refresh and review again.") }
    if (-not $live.Path) { return New-RemResult -Ok $false -Errors @('Guardian cannot read this process''s executable path (it may need elevation), so it refuses to stop it.') }
    if ($P.ContainsKey('path') -and $P.path -and ($live.Path -ine [string]$P.path)) { return New-RemResult -Ok $false -Errors @('The running executable differs from the one you reviewed; refresh and review again.') }
    if ($P.ContainsKey('startTime') -and $P.startTime -and $live.StartTime -and ($live.StartTime -ne [string]$P.startTime)) { return New-RemResult -Ok $false -Errors @('This PID was started at a different time than the process you reviewed (PID reuse); refresh and review again.') }
    $chk = Test-ProcessKillAllowed -Name $name -Path $live.Path -ProcessId $pid0
    if (-not $chk.Allowed) { return New-RemResult -Ok $false -Errors @("Protected: $($chk.Reason). Guardian will never stop this process, even with confirmation.") }
    $root = Get-GuardianRootPath
    if ($root -and (($live.Path -and $live.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) -or ($live.CommandLine -and $live.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0))) {
        return New-RemResult -Ok $false -Errors @('Protected: this process belongs to Laptop Guardian itself.')
    }
    $key = Get-StringKey @($pid0, $live.Name, $live.Path, $live.StartTime)
    return New-RemResult -Ok $true -IdentityKey $key -Details ([ordered]@{ pid = $pid0; name = $live.Name; path = $live.Path; startedUtc = $live.StartTime })
}
function Invoke-ProcessStop {
    param([hashtable]$P, $Validated)
    $pid0 = [int]$P.pid
    $before = Get-LiveProcessInfo -ProcessId $pid0
    try { Stop-Process -Id $pid0 -ErrorAction Stop } catch {
        if ($_.Exception.Message -match 'Access is denied') { return New-RemResult -Ok $false -NeedsElevation $true -Errors @('Windows denied access to stop this process. It may be running with higher rights.') }
        return New-RemResult -Ok $false -Errors @($_.Exception.Message)
    }
    $deadline = (Get-Date).AddSeconds(4); $gone = $false
    while ((Get-Date) -lt $deadline) { $now = Get-LiveProcessInfo -ProcessId $pid0; if (-not $now -or $now.StartTime -ne $before.StartTime) { $gone = $true; break }; Start-Sleep -Milliseconds 200 }
    if (-not $gone) { return New-RemResult -Ok $false -Errors @("Windows accepted the request but PID $pid0 is still running.") }
    Start-Sleep -Milliseconds 1500
    $again = @(Get-Process -Name ($before.Name) -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -ieq $before.Path } catch { $false } })
    $relaunched = $again.Count -gt 0 -and -not (@($again | Where-Object { $_.Id -eq $pid0 }).Count)
    $msg = "Stopped $($before.Name) (PID $pid0)."
    if ($relaunched) { $msg += ' A new copy has already started: something relaunches it. Use Disable restart to stop that.' }
    return New-RemResult -Ok $true -Verified $true -Message $msg -Details ([ordered]@{ relaunched = $relaunched; name = $before.Name; pid = $pid0 })
}

# ---------- startup.disable / startup.enable ----------
function Test-StartupChange {
    param([hashtable]$P, [bool]$Enable)
    $kind = [string]$P.kind; $name = [string]$P.name; $loc = [string]$P.location
    if ($kind -eq 'registry' -and $loc -notmatch '^(HKCU|HKLM):') { return New-RemResult -Ok $false -Errors @('Registry startup entries must be in a standard Run key.') }
    if ($kind -eq 'folder' -and $loc -match '^(HKCU|HKLM):') { return New-RemResult -Ok $false -Errors @('A folder startup entry needs a folder location.') }
    $info = Get-RunLocationInfo -Kind $kind -Location $loc
    if (-not $info) { return New-RemResult -Ok $false -Errors @('This location is not a standard Windows startup location. Guardian only changes the Run keys and the two Startup folders.') }
    $found = Test-StartupEntryExists -Kind $kind -Name $name -Location $loc
    if (-not $found) { return New-RemResult -Ok $false -Errors @("The startup entry '$name' no longer exists at that location.") }
    $needsAdmin = ($info.Hive -eq 'HKLM')
    $state = Get-StartupApprovedByte -ApprovedKey $info.Approved -ValueName $found
    $isDisabled = ($state -band 1) -eq 1
    if ($Enable -and -not $isDisabled) { return New-RemResult -Ok $false -Errors @('This startup entry is already enabled.') }
    if (-not $Enable -and $isDisabled) { return New-RemResult -Ok $false -Errors @('This startup entry is already disabled.') }
    if ($needsAdmin -and -not (Test-AdminNow)) { return New-RemResult -Ok $false -NeedsAdmin $true -NeedsElevation $true -Errors @('This entry applies to all users, so changing it needs administrator permission.') }
    return New-RemResult -Ok $true -NeedsAdmin $needsAdmin -IdentityKey (Get-StringKey @($kind, $found, $loc, $state)) -Details ([ordered]@{ approvedKey = $info.Approved; valueName = $found; wasDisabled = $isDisabled })
}
function Invoke-StartupChange {
    param([hashtable]$P, $Validated, [bool]$Enable)
    $info = Get-RunLocationInfo -Kind ([string]$P.kind) -Location ([string]$P.location)
    $vn = [string]$Validated.details.valueName
    try { Set-StartupApprovedByte -ApprovedKey $info.Approved -ValueName $vn -Enabled $Enable } catch { return New-RemResult -Ok $false -NeedsElevation ($info.Hive -eq 'HKLM') -Errors @($_.Exception.Message) }
    $now = Get-StartupApprovedByte -ApprovedKey $info.Approved -ValueName $vn
    $ok = if ($Enable) { ($now -band 1) -eq 0 } else { ($now -band 1) -eq 1 }
    if (-not $ok) { return New-RemResult -Ok $false -Errors @('Windows did not record the change.') }
    $undoId = if ($Enable) { 'startup.disable' } else { 'startup.enable' }
    return New-RemResult -Ok $true -Verified $true -Message $(if ($Enable) { "Startup entry '$vn' will start at sign-in again." } else { "Startup entry '$vn' will no longer start at sign-in." }) -Undo ([ordered]@{ action = $undoId; params = [ordered]@{ kind = [string]$P.kind; name = [string]$P.name; location = [string]$P.location } })
}

# ---------- task.disable / task.enable ----------
function Test-TaskChange {
    param([hashtable]$P, [bool]$Enable)
    $tp = [string]$P.taskPath; $tn = [string]$P.taskName
    if ($tp -match $script:ProtectedTaskPathRx) { return New-RemResult -Ok $false -Errors @('Protected: Windows and Laptop Guardian scheduled tasks are never changed by Guardian.') }
    $t = Get-TaskForAction -TaskPath $tp -TaskName $tn
    if (-not $t) { return New-RemResult -Ok $false -Errors @("The scheduled task $tp$tn no longer exists.") }
    $disabled = ([string]$t.State -eq 'Disabled')
    if ($Enable -and -not $disabled) { return New-RemResult -Ok $false -Errors @('This task is already enabled.') }
    if (-not $Enable -and $disabled) { return New-RemResult -Ok $false -Errors @('This task is already disabled.') }
    $needsAdmin = ([string]$t.Principal.RunLevel -eq 'Highest') -or ([string]$t.Principal.UserId -match 'SYSTEM|LOCAL SERVICE|NETWORK SERVICE')
    if ($needsAdmin -and -not (Test-AdminNow)) { return New-RemResult -Ok $false -NeedsAdmin $true -NeedsElevation $true -Errors @('This task runs with elevated or system rights, so changing it needs administrator permission.') }
    return New-RemResult -Ok $true -NeedsAdmin $needsAdmin -IdentityKey (Get-StringKey @($tp, $tn, [string]$t.State)) -Details ([ordered]@{ state = [string]$t.State; runLevel = [string]$t.Principal.RunLevel })
}
function Invoke-TaskChange {
    param([hashtable]$P, $Validated, [bool]$Enable)
    $tp = [string]$P.taskPath; $tn = [string]$P.taskName
    try { if ($Enable) { Enable-ScheduledTask -TaskPath $tp -TaskName $tn -ErrorAction Stop | Out-Null } else { Disable-ScheduledTask -TaskPath $tp -TaskName $tn -ErrorAction Stop | Out-Null } }
    catch { return New-RemResult -Ok $false -NeedsElevation ($_.Exception.Message -match 'denied') -Errors @($_.Exception.Message) }
    $t = Get-TaskForAction -TaskPath $tp -TaskName $tn
    $ok = $t -and ((([string]$t.State) -eq 'Disabled') -ne $Enable)
    if (-not $ok) { return New-RemResult -Ok $false -Errors @('Task Scheduler did not report the new state.') }
    $undoId = if ($Enable) { 'task.disable' } else { 'task.enable' }
    return New-RemResult -Ok $true -Verified $true -Message "Task $tp$tn is now $(if ($Enable) { 'enabled' } else { 'disabled' })." -Undo ([ordered]@{ action = $undoId; params = [ordered]@{ taskPath = $tp; taskName = $tn } })
}

# ---------- service.disable / service.enable ----------
function Test-ServiceChange {
    param([hashtable]$P, [bool]$Enable)
    $n = [string]$P.name
    if ((Get-ProtectedServiceNames) -contains $n.ToLowerInvariant()) { return New-RemResult -Ok $false -Errors @("Protected: '$n' is a Windows or security service. Guardian will never change it.") }
    $s = Get-ServiceForAction -Name $n
    if (-not $s) { return New-RemResult -Ok $false -Errors @("The service '$n' does not exist.") }
    $pathName = [string]$s.PathName
    if ($pathName -match '(?i)svchost\.exe' -or ($env:SystemRoot -and $pathName.IndexOf($env:SystemRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0)) { return New-RemResult -Ok $false -Errors @('Protected: this service is part of Windows (it runs from the Windows directory or inside svchost).') }
    if ($s.ServiceType -and ([string]$s.ServiceType) -match 'Kernel|File System|Driver') { return New-RemResult -Ok $false -Errors @('Protected: Guardian never changes drivers.') }
    $mode = [string]$s.StartMode
    if (-not $Enable -and $mode -eq 'Disabled') { return New-RemResult -Ok $false -Errors @('This service is already disabled.') }
    if ($Enable -and $mode -ne 'Disabled') { return New-RemResult -Ok $false -Errors @('This service is not disabled.') }
    if (-not (Test-AdminNow)) { return New-RemResult -Ok $false -NeedsAdmin $true -NeedsElevation $true -Errors @('Changing a service needs administrator permission.') }
    return New-RemResult -Ok $true -NeedsAdmin $true -IdentityKey (Get-StringKey @($n, $mode, $pathName)) -Details ([ordered]@{ startMode = $mode; path = $pathName; state = [string]$s.State })
}
function Convert-StartMode { param([string]$Mode) switch ($Mode) { 'Auto' { 'Automatic' } 'Automatic' { 'Automatic' } 'Manual' { 'Manual' } default { 'Manual' } } }
function Invoke-ServiceChange {
    param([hashtable]$P, $Validated, [bool]$Enable)
    $n = [string]$P.name
    $prev = [string]$Validated.details.startMode
    $target = if ($Enable) { Convert-StartMode $(if ($P.ContainsKey('startMode') -and $P.startMode) { [string]$P.startMode } else { 'Manual' }) } else { 'Disabled' }
    try { Set-Service -Name $n -StartupType $target -ErrorAction Stop } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    $s = Get-ServiceForAction -Name $n
    $ok = $s -and (([string]$s.StartMode -eq 'Disabled') -eq (-not $Enable))
    if (-not $ok) { return New-RemResult -Ok $false -Errors @('Windows did not report the new start type.') }
    $undo = if ($Enable) { [ordered]@{ action = 'service.disable'; params = [ordered]@{ name = $n } } } else { [ordered]@{ action = 'service.enable'; params = [ordered]@{ name = $n; startMode = $(if ($prev -in 'Auto', 'Automatic', 'Manual', 'Boot', 'System') { $(if ($prev -eq 'Auto') { 'Automatic' } else { $prev }) } else { 'Manual' }) } } }
    return New-RemResult -Ok $true -Verified $true -Message "Service $n start type is now $target (was $prev)." -Undo $undo
}

# ---------- file.recycle ----------
function Test-FileRecycle {
    param([hashtable]$P)
    $path = [string]$P.path
    $cfg = Get-GuardianConfig
    if ($path -match '[*?]') { return New-RemResult -Ok $false -Errors @('Wildcards are never accepted.') }
    if (Test-ProtectedPath -Path $path -ExtraProtected @($cfg.storage.protectedDirs)) { return New-RemResult -Ok $false -Errors @('Protected path: Windows, Program Files, ProgramData, your profile root, Guardian data and your protected folders are never touched.') }
    $root = Get-GuardianRootPath
    if ($root -and ([IO.Path]::GetFullPath($path).StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))) { return New-RemResult -Ok $false -Errors @('Protected path: Laptop Guardian''s own files are never recycled.') }
    $files = Read-JsonFile -Path (Get-GuardianPath 'LatestFiles') -Default $null
    $cand = $null
    if ($files) { $cand = @($files.candidates | Where-Object { $_.path -ieq $path } | Select-Object -First 1)[0] }
    if (-not $cand) { return New-RemResult -Ok $false -Errors @('This file is not in the latest Guardian findings; refusing. Run a scan first.') }
    if ($cand.classification -in 'KEEP', 'HIGH_RISK', 'UNKNOWN') { return New-RemResult -Ok $false -Errors @("Guardian classified this file as $($cand.classification) and will not recycle it. Delete it yourself in Explorer if you are sure.") }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if (-not $item) { return New-RemResult -Ok $false -Errors @('The file no longer exists.') }
    if ($item.PSIsContainer) { return New-RemResult -Ok $false -Errors @('Folders are never recycled by Guardian; only single files.') }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return New-RemResult -Ok $false -Errors @('Links and junctions are never recycled.') }
    if ($item.Attributes -band [IO.FileAttributes]::System) { return New-RemResult -Ok $false -Errors @('System files are never recycled.') }
    if (Test-PathHasReparse -Path (Split-Path -Parent $path)) { return New-RemResult -Ok $false -Errors @('The path passes through a junction or symbolic link; refusing.') }
    $candModified = Get-OptionalProp $cand 'lastModified'
    if ($candModified -and ([math]::Abs(($item.LastWriteTime - [datetime]$candModified).TotalSeconds) -gt 2)) { return New-RemResult -Ok $false -Errors @('The file changed since it was analysed. Re-scan, then review again.') }
    $ageDays = [int]((Get-Date) - $item.LastWriteTime).TotalDays
    return New-RemResult -Ok $true -IdentityKey (Get-StringKey @($path, $item.Length, $item.LastWriteTimeUtc.ToString('o'))) -Details ([ordered]@{ path = $path; sizeBytes = [int64]$item.Length; ageDays = $ageDays; classification = [string]$cand.classification; reason = $(if (Get-OptionalProp $cand 'whyFlagged') { (@($cand.whyFlagged) -join ' ') } else { '' }) })
}
function Invoke-FileRecycle {
    param([hashtable]$P, $Validated)
    $cfg = Get-GuardianConfig
    try { [void](Move-FileToRecycle -Path ([string]$P.path) -ProtectedDirs @($cfg.storage.protectedDirs)) } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    if (Test-Path -LiteralPath ([string]$P.path)) { return New-RemResult -Ok $false -Errors @('The file is still there after the request.') }
    return New-RemResult -Ok $true -Verified $true -Message 'Moved to the Recycle Bin. Open the Recycle Bin and choose Restore to undo.' -Details ([ordered]@{ sizeBytes = $Validated.details.sizeBytes })
}

# ---------- admin maintenance actions ----------
function Get-DefenderStatusForAction { Get-MpComputerStatus -ErrorAction Stop }
function Test-AdminOnlyAction {
    param([string]$Needs)
    if (-not (Test-AdminNow)) { return New-RemResult -Ok $false -NeedsAdmin $true -NeedsElevation $true -Errors @("$Needs needs administrator permission.") }
    return New-RemResult -Ok $true -NeedsAdmin $true -IdentityKey 'admin'
}
function Test-DefenderUpdate { Test-AdminOnlyAction 'Updating Defender' }
function Invoke-DefenderUpdate {
    $before = $null; try { $before = (Get-DefenderStatusForAction).AntivirusSignatureLastUpdated } catch { }
    try { Update-MpSignature -ErrorAction Stop } catch { return New-RemResult -Ok $false -Errors @("Update-MpSignature failed: $($_.Exception.Message)") }
    $after = $null; try { $after = (Get-DefenderStatusForAction).AntivirusSignatureLastUpdated } catch { }
    $fresh = $after -and (((Get-Date) - $after).TotalDays -lt 1)
    if (-not $fresh) { return New-RemResult -Ok $false -Errors @('Defender ran the update but its signatures still look old. Check your connection and Windows Update.') }
    return New-RemResult -Ok $true -Verified $true -Message "Defender signatures updated ($after)." -Details ([ordered]@{ before = "$before"; after = "$after" })
}
function Test-DefenderQuickScan { Test-AdminOnlyAction 'A Defender scan' }
function Invoke-DefenderQuickScan {
    $before = $null; try { $before = (Get-DefenderStatusForAction).QuickScanEndTime } catch { }
    try { Start-MpScan -ScanType QuickScan -ErrorAction Stop } catch { return New-RemResult -Ok $false -Errors @("Start-MpScan failed: $($_.Exception.Message)") }
    $after = $null; try { $after = (Get-DefenderStatusForAction).QuickScanEndTime } catch { }
    if (-not $after -or ($before -and $after -le $before)) { return New-RemResult -Ok $false -Errors @('The scan finished but Defender did not record a new quick-scan time.') }
    return New-RemResult -Ok $true -Verified $true -Message "Quick scan finished ($after)." -Details ([ordered]@{ finished = "$after" })
}
function Invoke-IntegrityTools {
    $d = (& dism.exe /Online /Cleanup-Image /CheckHealth 2>&1 | Out-String); $dExit = $LASTEXITCODE
    $s = (& sfc.exe /verifyonly 2>&1 | Out-String); $sExit = $LASTEXITCODE
    [pscustomobject]@{ dismExit = $dExit; dismText = $d; sfcExit = $sExit; sfcText = ($s -replace "`0", '') }
}
function Test-IntegrityCheck { Test-AdminOnlyAction 'The integrity check' }
function Invoke-IntegrityCheck {
    $r = Invoke-IntegrityTools
    $dismOk = ($r.dismExit -eq 0) -and ($r.dismText -match 'No component store corruption detected')
    $sfcOk = ($r.sfcExit -eq 0)
    $msg = "DISM CheckHealth: $(if ($dismOk) { 'no corruption detected' } else { 'reported a problem or could not complete' }). SFC verify-only: $(if ($sfcOk) { 'no integrity violations' } else { 'found integrity violations or could not complete' })."
    return New-RemResult -Ok $true -Verified $true -Message $msg -Details ([ordered]@{ dismClean = $dismOk; sfcClean = $sfcOk; dismExit = $r.dismExit; sfcExit = $r.sfcExit })
}
function Get-FirewallProfileForAction { param([string]$Name) Get-NetFirewallProfile -Name $Name -ErrorAction Stop }
function Test-FirewallEnable {
    param([hashtable]$P)
    $pr = $null; try { $pr = Get-FirewallProfileForAction -Name ([string]$P.profile) } catch { return New-RemResult -Ok $false -Errors @("Could not read the $($P.profile) firewall profile: $($_.Exception.Message)") }
    if ([string]$pr.Enabled -eq 'True') { return New-RemResult -Ok $false -Errors @("The $($P.profile) firewall profile is already on.") }
    if (-not (Test-AdminNow)) { return New-RemResult -Ok $false -NeedsAdmin $true -NeedsElevation $true -Errors @('Changing the firewall needs administrator permission.') }
    return New-RemResult -Ok $true -NeedsAdmin $true -IdentityKey (Get-StringKey @('fw', $P.profile, [string]$pr.Enabled))
}
function Invoke-FirewallEnable {
    param([hashtable]$P)
    try { Set-NetFirewallProfile -Name ([string]$P.profile) -Enabled True -ErrorAction Stop } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    $pr = Get-FirewallProfileForAction -Name ([string]$P.profile)
    if ([string]$pr.Enabled -ne 'True') { return New-RemResult -Ok $false -Errors @('Windows did not report the firewall as enabled.') }
    return New-RemResult -Ok $true -Verified $true -Message "Windows Firewall is now on for the $($P.profile) profile."
}
function Get-DnsCacheCount { @(Get-DnsClientCache -ErrorAction SilentlyContinue).Count }
function Test-DnsFlush { Test-AdminOnlyAction 'Flushing the DNS cache' }
function Invoke-DnsFlush {
    $before = Get-DnsCacheCount
    try { Clear-DnsClientCache -ErrorAction Stop } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    $after = Get-DnsCacheCount
    if ($after -gt $before) { return New-RemResult -Ok $false -Errors @('The DNS cache did not shrink after the flush.') }
    return New-RemResult -Ok $true -Verified $true -Message "DNS cache cleared ($before entries before, $after now)." -Details ([ordered]@{ before = $before; after = $after })
}

# ---------- Revo ----------
function Find-InstalledProgram {
    param([string]$AppName)
    @(Get-InstalledPrograms | Where-Object { $_.name -ieq $AppName })
}
function Test-RevoLaunch {
    param([hashtable]$P)
    $name = [string]$P.appName
    if ($name -match $script:RemoveRefusePattern) { return New-RemResult -Ok $false -Errors @('Protected: Guardian does not offer to uninstall security software, drivers, firmware tools or Windows runtime components.') }
    $apps = @(Find-InstalledProgram -AppName $name)
    if ($apps.Count -eq 0) { return New-RemResult -Ok $false -Errors @("'$name' is not in the installed programs list. Revo is only used for a recognised installed application.") }
    if ($apps.Count -gt 1) { return New-RemResult -Ok $false -Errors @("More than one installed program is named '$name'; refusing because the target is ambiguous.") }
    $a = $apps[0]
    if ($a.systemComponent -or $a.isUpdate) { return New-RemResult -Ok $false -Errors @('This is a system component or an update, not a normal application.') }
    if ($a.publisher -match '(?i)^Microsoft Corporation$' -and $a.installLocation -and $env:SystemRoot -and $a.installLocation.StartsWith($env:SystemRoot, [StringComparison]::OrdinalIgnoreCase)) { return New-RemResult -Ok $false -Errors @('This Microsoft component lives in the Windows directory.') }
    $revo = Get-RevoInfo
    if (-not $revo.available) { return New-RemResult -Ok $false -Errors @("Revo Uninstaller is not usable: $($revo.reason) Use Windows Settings > Apps to uninstall it instead.") }
    return New-RemResult -Ok $true -IdentityKey (Get-StringKey @($a.name, $a.version, $a.publisher)) -Details ([ordered]@{ app = $a.name; version = $a.version; publisher = $a.publisher; installLocation = $a.installLocation; revo = $revo.target; revoVersion = $revo.version })
}
function Start-RevoProcess { param([string]$Exe) Start-Process -FilePath $Exe -WorkingDirectory (Split-Path -Parent $Exe) -PassThru }
function Invoke-RevoLaunch {
    param([hashtable]$P, $Validated)
    $revo = Get-RevoInfo
    if (-not $revo.available) { return New-RemResult -Ok $false -Errors @('Revo is no longer usable.') }
    try { $proc = Start-RevoProcess -Exe $revo.target } catch { return New-RemResult -Ok $false -Errors @("Could not start Revo: $($_.Exception.Message)") }
    $msg = "Revo Uninstaller opened. In Revo, select '$($P.appName)' and follow its steps. Guardian has not uninstalled anything; use Check that it is gone afterwards."
    return New-RemResult -Ok $true -Verified $false -Message $msg -Details ([ordered]@{ pendingVerification = $true; app = [string]$P.appName; revoPid = $(if ($proc) { $proc.Id } else { 0 }) }) -Undo $null
}
function Test-AppVerify { param([hashtable]$P) New-RemResult -Ok $true -IdentityKey ([string]$P.appName) }
function Invoke-AppVerify {
    param([hashtable]$P)
    $name = [string]$P.appName
    $still = @(Find-InstalledProgram -AppName $name)
    if ($still.Count -gt 0) { return New-RemResult -Ok $true -Verified $false -Message "'$name' is still listed as installed. It has not been uninstalled." -Details ([ordered]@{ removed = $false; reason = 'still-installed' }) }
    return New-RemResult -Ok $true -Verified $true -Message "'$name' is no longer in the installed programs list." -Details ([ordered]@{ removed = $true })
}

# ---------- dispatcher ----------
function Get-RemediationHandler {
    param([string]$Id)
    switch ($Id) {
        'process.stop' { return @{ V = { param($p) Test-ProcessStop $p }; E = { param($p, $v) Invoke-ProcessStop $p $v } } }
        'startup.disable' { return @{ V = { param($p) Test-StartupChange $p $false }; E = { param($p, $v) Invoke-StartupChange $p $v $false } } }
        'startup.enable' { return @{ V = { param($p) Test-StartupChange $p $true }; E = { param($p, $v) Invoke-StartupChange $p $v $true } } }
        'task.disable' { return @{ V = { param($p) Test-TaskChange $p $false }; E = { param($p, $v) Invoke-TaskChange $p $v $false } } }
        'task.enable' { return @{ V = { param($p) Test-TaskChange $p $true }; E = { param($p, $v) Invoke-TaskChange $p $v $true } } }
        'service.disable' { return @{ V = { param($p) Test-ServiceChange $p $false }; E = { param($p, $v) Invoke-ServiceChange $p $v $false } } }
        'service.enable' { return @{ V = { param($p) Test-ServiceChange $p $true }; E = { param($p, $v) Invoke-ServiceChange $p $v $true } } }
        'file.recycle' { return @{ V = { param($p) Test-FileRecycle $p }; E = { param($p, $v) Invoke-FileRecycle $p $v } } }
        'defender.update-signatures' { return @{ V = { param($p) Test-DefenderUpdate }; E = { param($p, $v) Invoke-DefenderUpdate } } }
        'defender.quick-scan' { return @{ V = { param($p) Test-DefenderQuickScan }; E = { param($p, $v) Invoke-DefenderQuickScan } } }
        'system.integrity-check' { return @{ V = { param($p) Test-IntegrityCheck }; E = { param($p, $v) Invoke-IntegrityCheck } } }
        'firewall.enable-profile' { return @{ V = { param($p) Test-FirewallEnable $p }; E = { param($p, $v) Invoke-FirewallEnable $p } } }
        'dns.flush' { return @{ V = { param($p) Test-DnsFlush }; E = { param($p, $v) Invoke-DnsFlush } } }
        'app.revo-launch' { return @{ V = { param($p) Test-RevoLaunch $p }; E = { param($p, $v) Invoke-RevoLaunch $p $v } } }
        'firewall.block-program' { return @{ V = { param($p) Test-FirewallCreate $p 'block-program' }; E = { param($p, $v) Invoke-FirewallCreate $p 'block-program' } } }
        'firewall.allow-program' { return @{ V = { param($p) Test-FirewallCreate $p 'allow-program' }; E = { param($p, $v) Invoke-FirewallCreate $p 'allow-program' } } }
        'firewall.block-port' { return @{ V = { param($p) Test-FirewallCreate $p 'block-port' }; E = { param($p, $v) Invoke-FirewallCreate $p 'block-port' } } }
        'firewall.block-remote' { return @{ V = { param($p) Test-FirewallCreate $p 'block-remote' }; E = { param($p, $v) Invoke-FirewallCreate $p 'block-remote' } } }
        'firewall.remove-rule' { return @{ V = { param($p) Test-FirewallManage $p 'remove' }; E = { param($p, $v) Invoke-FirewallManage $p 'remove' } } }
        'firewall.disable-rule' { return @{ V = { param($p) Test-FirewallManage $p 'disable' }; E = { param($p, $v) Invoke-FirewallManage $p 'disable' } } }
        'firewall.enable-rule' { return @{ V = { param($p) Test-FirewallManage $p 'enable' }; E = { param($p, $v) Invoke-FirewallManage $p 'enable' } } }
        'dns.block-domain' { return @{ V = { param($p) Test-DnsBlock $p 'block' }; E = { param($p, $v) Invoke-DnsBlock $p 'block' } } }
        'dns.unblock-domain' { return @{ V = { param($p) Test-DnsBlock $p 'unblock' }; E = { param($p, $v) Invoke-DnsBlock $p 'unblock' } } }
        'dns.rollback' { return @{ V = { param($p) Test-DnsRollback }; E = { param($p, $v) Invoke-DnsRollback } } }
        'deep.dnslog-enable' { return @{ V = { param($p) Test-DnsLogChange $true }; E = { param($p, $v) Invoke-DnsLogChange $true } } }
        'deep.dnslog-disable' { return @{ V = { param($p) Test-DnsLogChange $false }; E = { param($p, $v) Invoke-DnsLogChange $false } } }
        'app.verify-removed' { return @{ V = { param($p) Test-AppVerify $p }; E = { param($p, $v) Invoke-AppVerify $p } } }
        default { return $null }
    }
}

function Invoke-GuardianRemediation {
    <#
    .SYNOPSIS  Validate or execute one catalog action. Execute always re-validates first and refuses on any mismatch.
    .PARAMETER Params  Catalog parameters, plus optional _identityKey (from the earlier Validate) to detect change between review and action.
    #>
    param([Parameter(Mandatory)][string]$Action, [ValidateSet('Validate', 'Execute')][string]$Mode = 'Validate', [hashtable]$Params = @{})
    $spec = Get-ActionSpec -Id $Action
    if (-not $spec) { return New-RemResult -Ok $false -Action $Action -Mode $Mode -Errors @("'$Action' is not an allowlisted Guardian action.") }
    $perr = @(Test-ActionParams -Spec $spec -Params $Params)
    if ($perr.Count -gt 0) { return New-RemResult -Ok $false -Action $Action -Mode $Mode -Errors $perr }
    $h = Get-RemediationHandler -Id $Action
    if (-not $h) { return New-RemResult -Ok $false -Action $Action -Mode $Mode -Errors @('No handler for this action.') }
    $v = & $h.V $Params
    $v.action = $Action; $v.mode = $Mode
    if ($Mode -eq 'Validate') { return $v }
    if (-not $v.ok) { return $v }
    if ($Params.ContainsKey('_identityKey') -and $Params['_identityKey'] -and ([string]$Params['_identityKey'] -ne $v.identityKey)) {
        return New-RemResult -Ok $false -Action $Action -Mode $Mode -Errors @('The target changed between your review and this action (identity mismatch). Nothing was done; review it again.')
    }
    $r = & $h.E $Params $v
    $r.action = $Action; $r.mode = $Mode; $r.needsAdmin = $v.needsAdmin
    if (-not $r.identityKey) { $r.identityKey = $v.identityKey }
    return $r
}

Export-ModuleMember -Function Get-ActionCatalog, Get-ActionSpec, Test-ActionParams, Invoke-GuardianRemediation, Get-InstalledPrograms, Get-RevoInfo
