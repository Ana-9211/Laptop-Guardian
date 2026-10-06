# Thin wrappers over Windows (mocked in tests) and small shared helpers.
# Dot-sourced by Actions\NetworkActions.psm1 (same module scope, so Pester mocks and exports are unchanged).
function Get-OptProp { param($Obj, [string]$Name) if ($null -ne $Obj -and ($Obj.PSObject.Properties.Name -contains $Name)) { $Obj.$Name } else { $null } }
function Test-AdminNet { Test-IsAdmin }

# ---------- thin wrappers over Windows (mocked in tests; never called with user-controlled strings) ----------
function Get-GuardianFwRules { @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayGroup -eq $script:RuleGroup -and $_.Name -like "$($script:RulePrefix)*" }) }
function Get-FwRuleByName { param([string]$Name) Get-NetFirewallRule -Name $Name -ErrorAction SilentlyContinue }
function Get-FwRuleDetail {
    param($Rule)
    $app = Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $Rule -ErrorAction SilentlyContinue
    $port = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $Rule -ErrorAction SilentlyContinue
    $addr = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $Rule -ErrorAction SilentlyContinue
    [pscustomobject]@{ program = $(if ($app) { [string]$app.Program } else { '' }); protocol = $(if ($port) { [string]$port.Protocol } else { '' }); localPort = $(if ($port) { [string]$port.LocalPort } else { '' }); remoteAddress = $(if ($addr) { (@($addr.RemoteAddress) -join ',') } else { '' }) }
}
function New-FwRule { param([hashtable]$Spec) New-NetFirewallRule @Spec | Out-Null }
function Remove-FwRule { param([string]$Name) Remove-NetFirewallRule -Name $Name -ErrorAction Stop }
function Set-FwRuleEnabled { param([string]$Name, [bool]$Enabled) if ($Enabled) { Enable-NetFirewallRule -Name $Name -ErrorAction Stop } else { Disable-NetFirewallRule -Name $Name -ErrorAction Stop } }
function Get-NetworkIdentity {
    <# Gateway and DNS/DHCP servers currently in use: blocking them would cut the laptop off the network. #>
    $ips = New-Object System.Collections.ArrayList
    try { foreach ($c in @(Get-NetIPConfiguration -ErrorAction SilentlyContinue)) { if ($c.IPv4DefaultGateway) { [void]$ips.Add([string]$c.IPv4DefaultGateway.NextHop) }; foreach ($d in @($c.DNSServer.ServerAddresses)) { [void]$ips.Add([string]$d) } } } catch { }
    try { foreach ($a in @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' -ErrorAction SilentlyContinue)) { if ($a.DHCPServer) { [void]$ips.Add([string]$a.DHCPServer) } } } catch { }
    return @($ips | Where-Object { $_ } | Select-Object -Unique)
}
function Get-HostsFilePath { Join-Path $env:SystemRoot 'System32\drivers\etc\hosts' }
function Get-NetworkDataDir { Join-Path (Split-Path (Split-Path (Get-GuardianPath 'RunState'))) 'network' }
function Get-HostsBackupDir { Get-GuardianPath 'ElevatedBackups' }   # administrators-only in an installed copy
function Get-RulesRegistryPath { Join-Path (Get-NetworkDataDir) 'rules.json' }
