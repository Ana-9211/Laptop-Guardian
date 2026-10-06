# Windows DNS Client operational log switch (deep mode).
# Dot-sourced by Actions\NetworkActions.psm1 (same module scope, so Pester mocks and exports are unchanged).
# ---------- deep mode: Windows DNS Client operational log (history by process, no packet data) ----------
function Get-DnsLogState { try { $l = Get-WinEvent -ListLog 'Microsoft-Windows-DNS-Client/Operational' -ErrorAction Stop; return [bool]$l.IsEnabled } catch { return $null } }
function Set-DnsLogState {
    # Turning the log on also caps its size (so it cannot grow large), remembering the old size; turning it off restores that size.
    param([bool]$Enabled)
    $wev = Join-Path $env:SystemRoot 'System32\wevtutil.exe'; $log = 'Microsoft-Windows-DNS-Client/Operational'
    $prev = Join-Path (Get-GuardianRoot) 'data\network\dns-log-previous.json'
    if ($Enabled) {
        try {
            $l = Get-WinEvent -ListLog $log -ErrorAction Stop
            if ($l.MaximumSizeInBytes -gt 8MB) {
                Write-JsonFile -Path $prev -Object @{ maxSizeBytes = [int64]$l.MaximumSizeInBytes }
                & $wev sl $log '/ms:8388608' | Out-Null; if ($LASTEXITCODE -ne 0) { throw "wevtutil /ms exited with $LASTEXITCODE" }
            }
        } catch { throw "Could not cap the DNS Client log size: $($_.Exception.Message)" }
    }
    & $wev sl $log "/e:$(if ($Enabled) { 'true' } else { 'false' })" | Out-Null; if ($LASTEXITCODE -ne 0) { throw "wevtutil exited with $LASTEXITCODE" }
    if (-not $Enabled -and (Test-Path -LiteralPath $prev)) {
        try { $old = [int64](Read-JsonFile -Path $prev -Default $null).maxSizeBytes; if ($old -gt 0) { & $wev sl $log "/ms:$old" | Out-Null }; Remove-Item -LiteralPath $prev -Force -ErrorAction SilentlyContinue } catch { }
    }
}
function Test-DnsLogChange {
    param([bool]$Enable)
    $s = Get-DnsLogState
    if ($null -eq $s) { return New-RemResult -Ok $false -Errors @('Windows does not expose the DNS Client log on this laptop.') }
    if ($s -eq $Enable) { return New-RemResult -Ok $false -Errors @("The DNS Client log is already $(if ($Enable) { 'on' } else { 'off' }).") }
    if (-not (Test-AdminNet)) { return New-RemResult -Ok $false -NeedsAdmin $true -NeedsElevation $true -Errors @('Changing an event log needs administrator permission.') }
    return New-RemResult -Ok $true -NeedsAdmin $true -IdentityKey (Get-StringKey @('dnslog', $Enable, $s))
}
function Invoke-DnsLogChange {
    param([bool]$Enable)
    try { Set-DnsLogState -Enabled $Enable } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    if ((Get-DnsLogState) -ne $Enable) { return New-RemResult -Ok $false -Errors @('Windows did not report the new log state.') }
    return New-RemResult -Ok $true -Verified $true -Message "The Windows DNS Client log is now $(if ($Enable) { 'on: Deep Network Guard can show which program asked for which name' } else { 'off' })." -Undo ([ordered]@{ action = $(if ($Enable) { 'deep.dnslog-disable' } else { 'deep.dnslog-enable' }); params = [ordered]@{} })
}
