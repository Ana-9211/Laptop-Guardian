#requires -Version 5.1
# Network remediation: Windows Firewall rules and DNS blocks that Laptop Guardian itself owns, and nothing else.
#  * Firewall: every rule is created in the display group "Laptop Guardian" with a name starting "LG-". Only rules with BOTH
#    that group and that prefix are ever modified or deleted. Unrelated Windows, enterprise, third-party, Defender and
#    user-created rules are never touched. Guardian never turns the firewall off and never edits Defender.
#  * DNS: domain blocks live in ONE clearly marked block of the Windows hosts file. Everything outside the block is left
#    byte-for-byte as it was, a backup is kept, and one action removes the whole block (rollback).
# Every function here is reached only through the allowlisted catalog actions via Remediation.psm1.
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'RemHelpers.psm1') -Force -DisableNameChecking -Global

$script:RuleGroup = 'Laptop Guardian'
$script:RulePrefix = 'LG-'
$script:MaxGuardianRules = 200
$script:HostsBegin = '# BEGIN LAPTOP GUARDIAN DNS BLOCKS (managed by Laptop Guardian; remove them from the dashboard)'
$script:HostsEnd = '# END LAPTOP GUARDIAN DNS BLOCKS'
$script:ProtectedDnsSuffixes = @('microsoft.com', 'windowsupdate.com', 'windows.com', 'windows.net', 'live.com', 'office.com', 'office365.com', 'msftconnecttest.com', 'msftncsi.com', 'azure.com', 'azureedge.net', 'digicert.com', 'localhost', 'local', 'invalid', 'test', 'example')
$script:ProtectedPorts = @(53, 67, 68, 546, 547)
$script:DurationHours = @{ '1h' = 1; '24h' = 24; '7d' = 168 }

# The action families live in NetworkActions\*.ps1 and are dot-sourced here so they stay in this module's scope.
. (Join-Path $PSScriptRoot 'NetworkActions\Wrappers.ps1')
. (Join-Path $PSScriptRoot 'NetworkActions\Targets.ps1')
. (Join-Path $PSScriptRoot 'NetworkActions\Registry.ps1')
. (Join-Path $PSScriptRoot 'NetworkActions\Firewall.ps1')
. (Join-Path $PSScriptRoot 'NetworkActions\DnsBlock.ps1')
. (Join-Path $PSScriptRoot 'NetworkActions\DnsLog.ps1')

Export-ModuleMember -Function Test-FirewallCreate, Invoke-FirewallCreate, Test-FirewallManage, Invoke-FirewallManage, Test-DnsBlock, Invoke-DnsBlock, Test-DnsRollback, Invoke-DnsRollback, Test-DnsLogChange, Invoke-DnsLogChange, Update-GuardianHostsBlockFile, Get-HostsParts, Get-HostsDomains, Test-DomainTarget, Test-RemoteTarget, Test-PortTarget, Test-ProgramTarget, Test-GuardianOwned, ConvertTo-IpInfo
