#requires -Version 5.1
# Network: non-invasive checks only (adapter state, gateway ping, DNS resolve, one outbound reachability probe). No port scanning.
Set-StrictMode -Version 2.0

function Get-NetworkHealth {
    $r = [ordered]@{ adapters = @(); gateway = $null; dnsServers = @(); internet = $false; dnsOk = $false; gatewayOk = $false; latencyMs = $null }
    try {
        $r.adapters = @(Get-NetAdapter -ErrorAction Stop | Where-Object { $_.Status -ne 'Not Present' } | ForEach-Object {
                [pscustomobject]@{ name = $_.Name; status = [string]$_.Status; speed = $_.LinkSpeed; type = [string]$_.MediaType }
            })
    } catch { }
    try {
        $cfg = @(Get-NetIPConfiguration -ErrorAction Stop | Where-Object { $_.IPv4DefaultGateway })
        if ($cfg.Count -gt 0) {
            $r.gateway = [string]$cfg[0].IPv4DefaultGateway.NextHop
            $r.dnsServers = @($cfg | ForEach-Object { $_.DnsServer.ServerAddresses } | Where-Object { $_ } | Select-Object -Unique)
        }
    } catch { }
    if ($r.gateway) {
        try { $r.gatewayOk = [bool](Test-Connection -ComputerName $r.gateway -Count 1 -Quiet -ErrorAction Stop) } catch { }
    }
    try { $null = [System.Net.Dns]::GetHostAddresses('www.microsoft.com'); $r.dnsOk = $true } catch { }
    try {
        $pr = Test-Connection -ComputerName '1.1.1.1' -Count 2 -ErrorAction Stop
        $r.internet = $true
        $r.latencyMs = [math]::Round((($pr | Measure-Object ResponseTime -Average).Average), 0)
    } catch { }
    [pscustomobject]$r
}

Export-ModuleMember -Function *
