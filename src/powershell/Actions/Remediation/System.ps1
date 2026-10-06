# Defender real-time protection, Windows Update scan, Windows settings pages, Windows Filtering Platform audit policy.
# Dot-sourced by Actions\Remediation.psm1 (same module scope, so Pester mocks and exports are unchanged).

# ---------- defender.enable-realtime ----------
function Set-DefenderRealtimeForAction { param([bool]$Enabled) Set-MpPreference -DisableRealtimeMonitoring (-not $Enabled) -ErrorAction Stop }
function Test-DefenderRealtime {
    $a = Test-AdminOnlyAction 'Turning on Defender real-time protection'
    if (-not $a.ok) { return $a }
    try { $s = Get-DefenderStatusForAction } catch { return New-RemResult -Ok $false -Errors @('Microsoft Defender is not available (another antivirus may be in charge), so there is nothing for Guardian to turn on.') }
    if ($s.PSObject.Properties.Name -contains 'AntivirusEnabled' -and -not $s.AntivirusEnabled) { return New-RemResult -Ok $false -Errors @('Microsoft Defender antivirus is switched off or replaced by another antivirus. Guardian will not change that.') }
    if ($s.RealTimeProtectionEnabled) { return New-RemResult -Ok $false -Errors @('Real-time protection is already on.') }
    return New-RemResult -Ok $true -NeedsAdmin $true -IdentityKey 'defender-realtime'
}
function Invoke-DefenderRealtime {
    try { Set-DefenderRealtimeForAction -Enabled $true } catch { return New-RemResult -Ok $false -Errors @("Windows refused to turn on real-time protection: $($_.Exception.Message) (Tamper Protection or a policy may control it; use Windows Security.)") }
    $s = $null; try { $s = Get-DefenderStatusForAction } catch { }
    if (-not $s -or -not $s.RealTimeProtectionEnabled) { return New-RemResult -Ok $false -Errors @('Windows did not report real-time protection as on afterwards.') }
    return New-RemResult -Ok $true -Verified $true -Message 'Defender real-time protection is on.'
}

# ---------- system.run-windows-update-scan (read only: it looks for updates and installs nothing) ----------
function Search-WindowsUpdatesForAction {
    $session = New-Object -ComObject Microsoft.Update.Session
    $result = $session.CreateUpdateSearcher().Search('IsInstalled=0 and IsHidden=0')
    return @($result.Updates | ForEach-Object { [pscustomobject]@{ title = [string]$_.Title; sizeMB = [math]::Round(([double]$_.MaxDownloadSize) / 1MB, 1); security = [bool](@($_.Categories | Where-Object { $_.Name -match 'Security' }).Count) } })
}
function Test-WindowsUpdateScan { return New-RemResult -Ok $true -IdentityKey 'windows-update-scan' }
function Invoke-WindowsUpdateScan {
    try { $u = @(Search-WindowsUpdatesForAction) } catch { return New-RemResult -Ok $false -Errors @("Windows Update could not be searched: $($_.Exception.Message)") }
    $top = @($u | Select-Object -First 8 | ForEach-Object { $_.title })
    $msg = if ($u.Count -eq 0) { 'Windows Update found nothing waiting. This laptop is up to date.' } else { "$($u.Count) update(s) are waiting, $(@($u | Where-Object { $_.security }).Count) of them security updates. Install them from Windows Update (the Open Windows Update button)." }
    return New-RemResult -Ok $true -Verified $true -Message $msg -Details ([ordered]@{ pending = $u.Count; security = @($u | Where-Object { $_.security }).Count; titles = $top })
}

# ---------- system.open-settings (a fixed table of Windows pages; the page name selects a row, nothing else is ever opened) ----------
$script:SettingsPages = [ordered]@{
    'windows-update' = 'ms-settings:windowsupdate'; 'startup-apps' = 'ms-settings:startupapps'; 'storage' = 'ms-settings:storagesense'; 'apps-features' = 'ms-settings:appsfeatures'
    'windows-security' = 'windowsdefender:'; 'protection-history' = 'windowsdefender://threat'; 'recovery' = 'ms-settings:recovery'; 'power' = 'ms-settings:powersleep'
}
function Start-SettingsPage { param([string]$Uri) Start-Process -FilePath $Uri }
function Get-SettingsPageNames { @($script:SettingsPages.Keys) }
function Test-OpenSettings {
    param([hashtable]$P)
    if (-not $script:SettingsPages.Contains([string]$P.page)) { return New-RemResult -Ok $false -Errors @("'$($P.page)' is not a page Guardian can open.") }
    return New-RemResult -Ok $true -IdentityKey ([string]$P.page) -Details ([ordered]@{ page = [string]$P.page })
}
function Invoke-OpenSettings {
    param([hashtable]$P)
    $uri = $script:SettingsPages[[string]$P.page]
    try { Start-SettingsPage -Uri $uri } catch { return New-RemResult -Ok $false -Errors @("Windows could not open the page: $($_.Exception.Message)") }
    return New-RemResult -Ok $true -Verified $false -Message "Opened the $($P.page) page in Windows. Guardian cannot see what you do there; refresh the dashboard afterwards."
}

# ---------- setup.enable-firewall-audit / setup.disable-firewall-audit (Windows Filtering Platform audit policy) ----------
# Locale independent: subcategories are addressed by GUID and read back from an auditpol backup file (numeric setting values).
$script:WfpSubcategories = [ordered]@{ 'connection' = '{0CCE9226-69AE-11D9-BED3-505054503030}'; 'packet-drop' = '{0CCE9225-69AE-11D9-BED3-505054503030}' }
function Invoke-AuditPol { param([string[]]$Arguments) $out = & (Join-Path $env:SystemRoot 'System32\auditpol.exe') @Arguments 2>&1 | Out-String; [pscustomobject]@{ exit = $LASTEXITCODE; text = $out } }
function Get-WfpAuditState {
    <# Returns @{ connection = 0..3; packet-drop = 0..3 } (0 none, 1 success, 2 failure, 3 both) or $null when it cannot be read. #>
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('lg-audit-' + [guid]::NewGuid().ToString('N') + '.csv')
    try {
        $r = Invoke-AuditPol -Arguments @('/backup', "/file:$tmp")
        if ($r.exit -ne 0 -or -not (Test-Path -LiteralPath $tmp)) { return $null }
        $rows = @(Import-Csv -LiteralPath $tmp)
        $state = [ordered]@{}
        foreach ($k in $script:WfpSubcategories.Keys) {
            $row = @($rows | Where-Object { $_.'Subcategory GUID' -eq $script:WfpSubcategories[$k] } | Select-Object -First 1)[0]
            $state[$k] = if ($row) { [int]$row.'Setting Value' } else { 0 }
        }
        return $state
    } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
function Set-WfpAuditState {
    param($State)
    foreach ($k in $script:WfpSubcategories.Keys) {
        $v = [int]$State[$k]
        $r = Invoke-AuditPol -Arguments @('/set', "/subcategory:$($script:WfpSubcategories[$k])", "/success:$(if ($v -band 1) { 'enable' } else { 'disable' })", "/failure:$(if ($v -band 2) { 'enable' } else { 'disable' })")
        if ($r.exit -ne 0) { throw "auditpol failed for $k (exit $($r.exit))" }
    }
}
function Get-WfpAuditBackupPath { Join-Path (Get-GuardianPath 'ElevatedBackups') 'wfp-audit-previous.json' }
function Test-FirewallAuditChange {
    param([bool]$Enable)
    $a = Test-AdminOnlyAction 'Changing the audit policy'
    if (-not $a.ok) { return $a }
    $s = Get-WfpAuditState
    if ($null -eq $s) { return New-RemResult -Ok $false -Errors @('Windows did not let Guardian read the audit policy.') }
    $on = ($s['connection'] -eq 3 -and $s['packet-drop'] -eq 3)
    if ($Enable -and $on) { return New-RemResult -Ok $false -Errors @('Firewall connection logging is already on.') }
    if (-not $Enable -and -not (Test-Path -LiteralPath (Get-WfpAuditBackupPath)) -and -not $on) { return New-RemResult -Ok $false -Errors @('Firewall connection logging is already off.') }
    return New-RemResult -Ok $true -NeedsAdmin $true -IdentityKey (Get-StringKey @('wfp-audit', $Enable, $s['connection'], $s['packet-drop'])) -Details ([ordered]@{ connection = $s['connection']; packetDrop = $s['packet-drop'] })
}
function Invoke-FirewallAuditChange {
    param([bool]$Enable)
    $before = Get-WfpAuditState
    $backup = Get-WfpAuditBackupPath
    try {
        if ($Enable) {
            if (-not (Test-Path -LiteralPath $backup)) { New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null; Write-JsonFile -Path $backup -Object ([ordered]@{ connection = $before['connection']; 'packet-drop' = $before['packet-drop']; savedAt = (Get-IsoNow) }) }
            Set-WfpAuditState -State ([ordered]@{ connection = 3; 'packet-drop' = 3 })
        } else {
            $prev = Read-JsonFile -Path $backup -Default $null
            $target = if ($prev) { [ordered]@{ connection = [int]$prev.connection; 'packet-drop' = [int]$prev.'packet-drop' } } else { [ordered]@{ connection = 0; 'packet-drop' = 0 } }
            Set-WfpAuditState -State $target
            if ($prev) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
        }
    } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    $after = Get-WfpAuditState
    $want = if ($Enable) { 3 } else { -1 }
    if ($Enable -and ($null -eq $after -or $after['connection'] -ne $want -or $after['packet-drop'] -ne $want)) { return New-RemResult -Ok $false -Errors @('Windows did not report the new audit policy.') }
    $undo = if ($Enable) { [ordered]@{ action = 'setup.disable-firewall-audit'; params = [ordered]@{} } } else { [ordered]@{ action = 'setup.enable-firewall-audit'; params = [ordered]@{} } }
    return New-RemResult -Ok $true -Verified $true -Message "Windows Filtering Platform logging is now $(if ($Enable) { 'on: the Security log records allowed and blocked connections (it can grow quickly; Guardian reads it, it never copies packet contents)' } else { 'back to what it was before' })." -Undo $undo
}
