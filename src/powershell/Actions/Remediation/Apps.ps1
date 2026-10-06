# Installed programs and the Revo Uninstaller: inventory, launch, verify.
# Dot-sourced by Actions\Remediation.psm1 (same module scope, so Pester mocks and exports are unchanged).
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
function Get-AppRemovalRecordPath { Join-Path (Split-Path -Parent (Get-GuardianPath 'RunState')) 'app-removals.json' }
function Save-AppRemovalRecord {
    <# Remembers where an application lived before it is uninstalled, so the leftover check can tell what belonged to it. #>
    param($App)
    try {
        $f = Get-AppRemovalRecordPath
        $all = Read-JsonFile -Path $f -Default $null
        $map = [ordered]@{}
        if ($all) { foreach ($p in $all.PSObject.Properties) { $map[$p.Name] = $p.Value } }
        $get = { param($k) if ($App -is [System.Collections.IDictionary]) { if ($App.Contains($k)) { [string]$App[$k] } else { '' } } else { [string](Get-OptionalProp $App $k) } }
        $map[[string]$App['app']] = [ordered]@{ installLocation = (& $get 'installLocation'); publisher = (& $get 'publisher'); version = (& $get 'version'); recordedAt = (Get-IsoNow) }
        Write-JsonFile -Path $f -Object $map
    } catch { }
}
function Get-AppRemovalRecord { param([string]$Name) $all = Read-JsonFile -Path (Get-AppRemovalRecordPath) -Default $null; if ($all -and ($all.PSObject.Properties.Name -contains $Name)) { $all.$Name } else { $null } }
function Start-RevoProcess { param([string]$Exe) Start-Process -FilePath $Exe -WorkingDirectory (Split-Path -Parent $Exe) -PassThru }
function Invoke-RevoLaunch {
    param([hashtable]$P, $Validated)
    $revo = Get-RevoInfo
    if (-not $revo.available) { return New-RemResult -Ok $false -Errors @('Revo is no longer usable.') }
    try { $proc = Start-RevoProcess -Exe $revo.target } catch { return New-RemResult -Ok $false -Errors @("Could not start Revo: $($_.Exception.Message)") }
    Save-AppRemovalRecord -App $Validated.details
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

# ---------- app.cleanup-leftovers (read-only report: Guardian never deletes a leftover folder itself) ----------
function Get-LeftoverCandidates {
    <# Locations that can be tied to the application: the install folder recorded before the uninstall, and per-user or shared data folders
       named EXACTLY like the application. Nothing is matched loosely, so a leftover is only listed when there is evidence it belonged to the app. #>
    param([string]$AppName, $Record)
    $out = New-Object System.Collections.ArrayList
    $add = { param($Path, $Kind, $Evidence) if ($Path -and (Test-Path -LiteralPath $Path -PathType Container)) { [void]$out.Add([pscustomobject]@{ path = $Path; kind = $Kind; evidence = $Evidence }) } }
    if ($Record -and $Record.installLocation) { & $add ([string]$Record.installLocation) 'install-folder' 'This was the install folder recorded for the application before it was uninstalled.' }
    $safeName = $AppName -replace '[\\/:*?"<>|]', ''
    if ($safeName.Length -ge 3) {
        foreach ($b in @(@($env:LOCALAPPDATA, 'user data (local)'), @($env:APPDATA, 'user data (roaming)'), @((Join-Path $env:LOCALAPPDATA 'Programs'), 'per-user program folder'), @($env:ProgramData, 'shared data'))) {
            if ($b[0]) { & $add (Join-Path $b[0] $safeName) 'data-folder' "A folder named exactly '$safeName' in $($b[1])." }
        }
    }
    return @($out)
}
function Get-FolderSummary { param([string]$Path) $m = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum); [pscustomobject]@{ files = [int]$m[0].Count; sizeMB = [math]::Round(([double]$m[0].Sum) / 1MB, 1) } }
function Test-AppCleanupLeftovers {
    param([hashtable]$P)
    $name = [string]$P.appName
    if ($name -match $script:RemoveRefusePattern) { return New-RemResult -Ok $false -Errors @('Protected: Guardian does not look for leftovers of security software, drivers, firmware tools or Windows runtime components.') }
    if (@(Find-InstalledProgram -AppName $name).Count -gt 0) { return New-RemResult -Ok $false -Errors @("'$name' is still installed. Uninstall it first (Revo's own leftover scan runs as part of that).") }
    return New-RemResult -Ok $true -IdentityKey $name
}
function Invoke-AppCleanupLeftovers {
    param([hashtable]$P)
    $name = [string]$P.appName
    $cfg = Get-GuardianConfig
    $rec = Get-AppRemovalRecord -Name $name
    $items = New-Object System.Collections.ArrayList
    foreach ($c in @(Get-LeftoverCandidates -AppName $name -Record $rec)) {
        if (Test-ProtectedPath -Path $c.path -ExtraProtected @($cfg.storage.protectedDirs)) { continue }
        $s = Get-FolderSummary -Path $c.path
        [void]$items.Add([ordered]@{ path = $c.path; kind = $c.kind; evidence = $c.evidence; files = $s.files; sizeMB = $s.sizeMB })
    }
    $msg = if ($items.Count -eq 0) { "No leftover folder that can be tied to '$name' was found. Revo's own leftover scan can still look in the registry." } else { "$($items.Count) leftover location(s) can be tied to '$name'. Guardian only lists them: remove them with Revo's leftover scan (Advanced mode) or delete them yourself after checking. Guardian never deletes folders." }
    return New-RemResult -Ok $true -Verified $true -Message $msg -Details ([ordered]@{ app = $name; leftovers = @($items); recorded = [bool]$rec })
}
