# firewall.enable
# Dot-sourced by Actions\Remediation.psm1 (same module scope, so Pester mocks and exports are unchanged).
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
