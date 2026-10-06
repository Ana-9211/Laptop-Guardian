# startup.disable / startup.enable
# Dot-sourced by Actions\Remediation.psm1 (same module scope, so Pester mocks and exports are unchanged).
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
