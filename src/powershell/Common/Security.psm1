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

function Get-ProtectedProcessNames { $script:ProtectedProcessNames }

function Get-ProtectedPathPrefixes {
    $list = New-Object System.Collections.ArrayList
    foreach ($p in @($env:SystemRoot, $env:windir, ${env:ProgramFiles}, ${env:ProgramFiles(x86)}, $env:ProgramData, (Join-Path $env:SystemDrive '\Recovery'), (Join-Path $env:SystemDrive '\$Recycle.Bin'), (Join-Path $env:SystemDrive '\System Volume Information'), (Join-Path $env:SystemDrive '\Boot'), (Join-Path $env:SystemDrive '\EFI'))) {
        if ($p) { [void]$list.Add($p.TrimEnd('\')) }
    }
    return @($list | Select-Object -Unique)
}

function Test-ProtectedPath {
    param([string]$Path, [string[]]$ExtraProtected = @())
    if ([string]::IsNullOrWhiteSpace($Path)) { return $true }
    try { $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\') } catch { return $true }
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
    if ($ProcessId -le 4) { return [pscustomobject]@{ Allowed = $false; Reason = 'PID is a reserved system PID' } }
    if ($ProcessId -eq $PID) { return [pscustomobject]@{ Allowed = $false; Reason = 'Cannot terminate the Guardian process itself' } }
    if ($script:ProtectedProcessNames -contains $n) { return [pscustomobject]@{ Allowed = $false; Reason = "'$n' is on the protected process list" } }
    if ($Path -and $env:SystemRoot -and $Path.StartsWith($env:SystemRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'Executable lives under the Windows directory' }
    }
    return [pscustomobject]@{ Allowed = $true; Reason = 'ok' }
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
function Move-ToRecycleBin {
    param([Parameter(Mandatory)][string]$Path, [string[]]$ProtectedDirs = @())
    if (Test-ProtectedPath -Path $Path -ExtraProtected $ProtectedDirs) { throw "Path is protected: $Path" }
    if (-not (Test-Path -LiteralPath $Path)) { throw "Path no longer exists: $Path" }
    Add-Type -AssemblyName Microsoft.VisualBasic
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer) { throw 'Directories are not recycled by Guardian; select individual files.' }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not recycled.' }
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($item.FullName, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
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
