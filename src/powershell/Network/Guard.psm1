#requires -Version 5.1
# Network Guard collector: a read-only snapshot of TCP/UDP endpoints, listeners, owning processes, DNS cache and firewall state.
# Standard visibility only: it reads the Windows connection tables. It never captures packets, never changes a setting, and
# never contacts the internet. Deep sampling is a separate, opt-in feature handled by the bridge.
Set-StrictMode -Version 2.0

$script:MaxProcessDetails = 80
$script:MaxDns = 500
$script:RuleGroup = 'Laptop Guardian'

# thin wrappers (mocked in tests)
function Get-TcpTable { @(Get-NetTCPConnection -ErrorAction SilentlyContinue) }
function Get-UdpTable { @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue) }
function Get-ProcessTable { @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, Name, ExecutablePath, CreationDate) }
function Get-ProcessOwnerName {
    param([int]$ProcessId)
    try { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop; $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop; if ($o.User) { return "$($o.Domain)\$($o.User)" } } catch { }
    return $null
}
function Get-FileSignatureInfo {
    param([string]$Path)
    try { $s = Get-AuthenticodeSignature -FilePath $Path -ErrorAction Stop; [pscustomobject]@{ status = [string]$s.Status; publisher = $(if ($s.SignerCertificate) { ($s.SignerCertificate.Subject -replace '^.*CN=([^,]+).*$', '$1') } else { $null }) } } catch { [pscustomobject]@{ status = 'Unknown'; publisher = $null } }
}
function Get-DnsCacheTable { @(Get-DnsClientCache -ErrorAction SilentlyContinue) }
function Get-FirewallProfileTable { @(Get-NetFirewallProfile -ErrorAction SilentlyContinue) }
function Get-GuardianRuleTable { @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayGroup -eq $script:RuleGroup }) }
function Get-RuleFilters {
    param($Rule)
    $app = Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $Rule -ErrorAction SilentlyContinue
    $port = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $Rule -ErrorAction SilentlyContinue
    $addr = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $Rule -ErrorAction SilentlyContinue
    [pscustomobject]@{ program = $(if ($app) { [string]$app.Program } else { '' }); protocol = $(if ($port) { [string]$port.Protocol } else { '' }); localPort = $(if ($port) { [string]$port.LocalPort } else { '' }); remoteAddress = $(if ($addr) { (@($addr.RemoteAddress) -join ',') } else { '' }) }
}
function Get-FirewallPostureTable {
    <# Enabled INBOUND ALLOW rules (anyone's, not only Guardian's), compact, for the posture audit. Read-only. #>
    $rules = @(Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction SilentlyContinue | Select-Object -First 600)
    if (-not $rules.Count) { return @() }
    $app = @{}; $port = @{}; $addr = @{}
    foreach ($f in @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue)) { $app[[string]$f.InstanceID] = $f }
    foreach ($f in @(Get-NetFirewallPortFilter -ErrorAction SilentlyContinue)) { $port[[string]$f.InstanceID] = $f }
    foreach ($f in @(Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue)) { $addr[[string]$f.InstanceID] = $f }
    $userProfile = [Environment]::GetEnvironmentVariable('USERPROFILE')
    foreach ($r in $rules) {
        $id = [string]$r.InstanceID
        $prog = if ($app.ContainsKey($id)) { [string]$app[$id].Program } else { '' }
        $exp = if ($prog) { [Environment]::ExpandEnvironmentVariables($prog) } else { '' }
        $isPath = $exp -match '^[A-Za-z]:[\\/]'
        [ordered]@{
            name = [string]$r.Name; displayName = [string]$r.DisplayName; enabled = $true; direction = 'Inbound'; action = 'Allow'; program = $prog
            protocol = $(if ($port.ContainsKey($id)) { [string]$port[$id].Protocol } else { '' }); localPort = $(if ($port.ContainsKey($id)) { [string]$port[$id].LocalPort } else { '' })
            remoteAddress = $(if ($addr.ContainsKey($id)) { (@($addr[$id].RemoteAddress) -join ',') } else { 'Any' })
            programMissing = [bool]($isPath -and -not (Test-Path -LiteralPath $exp))
            programUserWritable = [bool]($isPath -and $userProfile -and $exp.StartsWith($userProfile + '\', [StringComparison]::OrdinalIgnoreCase))
        }
    }
}
function Get-NetworkIdentityTable {
    $gw = @(); $dns = @(); $dhcp = @()
    try { foreach ($c in @(Get-NetIPConfiguration -ErrorAction SilentlyContinue)) { if ($c.IPv4DefaultGateway) { $gw += [string]$c.IPv4DefaultGateway.NextHop }; $dns += @($c.DNSServer.ServerAddresses) } } catch { }
    try { foreach ($a in @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' -ErrorAction SilentlyContinue)) { if ($a.DHCPServer) { $dhcp += [string]$a.DHCPServer } } } catch { }
    [pscustomobject]@{ gateway = @($gw | Select-Object -Unique); dns = @($dns | Where-Object { $_ } | Select-Object -Unique); dhcp = @($dhcp | Select-Object -Unique) }
}

function Get-NetworkSnapshot {
    $sw = [Diagnostics.Stopwatch]::StartNew(); $errors = New-Object System.Collections.ArrayList
    $tcp = @(); $udp = @(); $procMap = @{}
    try { $tcp = @(Get-TcpTable) } catch { [void]$errors.Add("tcp: $($_.Exception.Message)") }
    try { $udp = @(Get-UdpTable) } catch { [void]$errors.Add("udp: $($_.Exception.Message)") }
    try { foreach ($p in @(Get-ProcessTable)) { $procMap[[int]$p.ProcessId] = $p } } catch { [void]$errors.Add("processes: $($_.Exception.Message)") }

    $pids = @(@($tcp | ForEach-Object { [int]$_.OwningProcess }) + @($udp | ForEach-Object { [int]$_.OwningProcess }) | Select-Object -Unique)
    $procs = [ordered]@{}; $sigCache = @{}; $detailed = 0
    foreach ($id in $pids) {
        $p = if ($procMap.ContainsKey($id)) { $procMap[$id] } else { $null }
        $path = if ($p) { [string]$p.ExecutablePath } else { '' }
        $entry = [ordered]@{ name = $(if ($p) { ([string]$p.Name -replace '\.exe$', '') } elseif ($id -eq 0) { 'System Idle' } elseif ($id -eq 4) { 'System' } else { "pid $id" }); path = $(if ($path) { $path } else { $null }); signed = $null; signature = $null; publisher = $null; owner = $null; startTime = $null }
        # UTC to the second: the same form the stop-process action compares against, so a reused PID is detected.
        try { if ($p -and $p.CreationDate) { $entry.startTime = ([datetime]$p.CreationDate).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss') } } catch { }
        if ($path -and $detailed -lt $script:MaxProcessDetails) {
            if (-not $sigCache.ContainsKey($path)) { $sigCache[$path] = Get-FileSignatureInfo -Path $path; $detailed++ }
            $s = $sigCache[$path]; $entry.signature = $s.status; $entry.signed = ($s.status -eq 'Valid'); $entry.publisher = $s.publisher
        }
        $entry.owner = $(if ($detailed -le $script:MaxProcessDetails -and $p) { Get-ProcessOwnerName -ProcessId $id } else { $null })
        $procs[[string]$id] = $entry
    }

    $conns = New-Object System.Collections.ArrayList
    foreach ($c in $tcp) {
        [void]$conns.Add([ordered]@{ proto = 'TCP'; state = [string]$c.State; localAddress = [string]$c.LocalAddress; localPort = [int]$c.LocalPort; remoteAddress = $(if ($c.RemoteAddress -and [string]$c.RemoteAddress -notin '0.0.0.0', '::') { [string]$c.RemoteAddress } else { '' }); remotePort = [int]$c.RemotePort; pid = [int]$c.OwningProcess; created = $(if ($c.CreationTime -and $c.CreationTime.Year -gt 2000) { $c.CreationTime.ToString('o') } else { $null }) })
    }
    $udpRows = @($udp | ForEach-Object { [ordered]@{ proto = 'UDP'; localAddress = [string]$_.LocalAddress; localPort = [int]$_.LocalPort; pid = [int]$_.OwningProcess } })

    $dns = @(); try { $dns = @(Get-DnsCacheTable | Select-Object -First $script:MaxDns | ForEach-Object { [ordered]@{ name = [string]$_.Entry; type = [string]$_.Type; data = [string]$_.Data; ttl = [int]$_.TimeToLive } }) } catch { [void]$errors.Add("dns: $($_.Exception.Message)") }
    $profiles = @(); try { $profiles = @(Get-FirewallProfileTable | ForEach-Object { [ordered]@{ name = [string]$_.Name; enabled = ([string]$_.Enabled -eq 'True'); defaultInboundAction = [string]$_.DefaultInboundAction; defaultOutboundAction = [string]$_.DefaultOutboundAction } }) } catch { [void]$errors.Add("firewall: $($_.Exception.Message)") }
    $rules = @(); try { $rules = @(Get-GuardianRuleTable | ForEach-Object { $f = Get-RuleFilters $_; [ordered]@{ name = [string]$_.Name; displayName = [string]$_.DisplayName; enabled = ([string]$_.Enabled -eq 'True'); direction = [string]$_.Direction; action = [string]$_.Action; program = $f.program; protocol = $f.protocol; localPort = $f.localPort; remoteAddress = $f.remoteAddress; description = [string]$_.Description } }) } catch { [void]$errors.Add("rules: $($_.Exception.Message)") }
    $posture = @(); try { $posture = @(Get-FirewallPostureTable) } catch { [void]$errors.Add("firewall posture: $($_.Exception.Message)") }
    $ident = $null; try { $ident = Get-NetworkIdentityTable } catch { }

    return [ordered]@{
        generatedAt = (Get-IsoNow); durationMs = [int]$sw.ElapsedMilliseconds; elevated = [bool](Test-IsAdmin); mode = 'standard'
        connections = @($conns); udp = $udpRows; processes = $procs; dns = $dns
        firewall = [ordered]@{ profiles = $profiles; rules = $rules; posture = $posture }
        identity = $(if ($ident) { [ordered]@{ gateway = @($ident.gateway); dns = @($ident.dns); dhcp = @($ident.dhcp) } } else { [ordered]@{ gateway = @(); dns = @(); dhcp = @() } })
        errors = @($errors)
    }
}

Export-ModuleMember -Function Get-NetworkSnapshot
