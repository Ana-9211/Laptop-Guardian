# Defender update and scan, system integrity check (administrator maintenance actions).
# Dot-sourced by Actions\Remediation.psm1 (same module scope, so Pester mocks and exports are unchanged).
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
