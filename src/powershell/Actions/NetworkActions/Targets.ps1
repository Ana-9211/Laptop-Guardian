# Validation of programs, addresses, ports and domains.
# Dot-sourced by Actions\NetworkActions.psm1 (same module scope, so Pester mocks and exports are unchanged).
# ---------- target validation ----------
function Test-ProgramTarget {
    param([string]$Path)
    if ($Path -notmatch '(?i)\.exe$') { return 'Only .exe programs can be targeted.' }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'That program does not exist on this laptop.' }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return 'Links are not accepted; give the real program path.' }
    $full = [IO.Path]::GetFullPath($Path)
    $name = ([IO.Path]::GetFileNameWithoutExtension($full)).ToLowerInvariant()
    if ((Get-ProtectedProcessNames) -contains $name) { return "Protected: '$name' is a Windows, security or Guardian program and is never blocked." }
    if ($env:SystemRoot -and $full.StartsWith($env:SystemRoot, [StringComparison]::OrdinalIgnoreCase)) { return 'Protected: programs in the Windows directory are never blocked.' }
    foreach ($d in @("$env:ProgramData\Microsoft\Windows Defender", "$env:ProgramFiles\Windows Defender", "$env:ProgramFiles\Windows Defender Advanced Threat Protection", "${env:ProgramFiles(x86)}\Windows Defender")) { if ($d -and $full.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) { return 'Protected: Microsoft Defender components are never blocked.' } }
    foreach ($root in @(Get-GuardianRoots)) { if ($root -and $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { return 'Protected: Laptop Guardian''s own programs are never blocked.' } }
    return $null
}
function ConvertTo-IpInfo {
    <# Parses an IPv4/IPv6 address or CIDR. Returns @{ Ip; Prefix; Bytes; Family } or $null. #>
    param([string]$Text)
    $addr = $Text; $prefix = $null
    if ($Text -match '^(.+)/(\d{1,3})$') { $addr = $Matches[1]; $prefix = [int]$Matches[2] }
    $ip = $null
    if (-not [Net.IPAddress]::TryParse($addr, [ref]$ip)) { return $null }
    $bits = if ($ip.AddressFamily -eq 'InterNetwork') { 32 } else { 128 }
    if ($null -eq $prefix) { $prefix = $bits }
    if ($prefix -lt 0 -or $prefix -gt $bits) { return $null }
    [pscustomobject]@{ Ip = $ip; Prefix = $prefix; Bytes = $ip.GetAddressBytes(); Family = [string]$ip.AddressFamily; Bits = $bits }
}
function Test-IpInCidr {
    param($Info, [string]$Other)
    $o = ConvertTo-IpInfo $Other
    if (-not $o -or $o.Family -ne $Info.Family) { return $false }
    $full = [math]::Floor($Info.Prefix / 8); $rem = $Info.Prefix % 8
    for ($i = 0; $i -lt $full; $i++) { if ($Info.Bytes[$i] -ne $o.Bytes[$i]) { return $false } }
    if ($rem -gt 0) { $mask = (0xFF -shl (8 - $rem)) -band 0xFF; if (($Info.Bytes[$full] -band $mask) -ne ($o.Bytes[$full] -band $mask)) { return $false } }
    return $true
}
function Test-RemoteTarget {
    param([string]$Remote)
    $i = ConvertTo-IpInfo $Remote
    if (-not $i) { return 'That is not a valid IP address or CIDR range.' }
    $minPrefix = if ($i.Family -eq 'InterNetwork') { 8 } else { 16 }
    if ($i.Prefix -lt $minPrefix) { return "That range is too broad (a /$($i.Prefix) would cover a huge part of the internet). Use /$minPrefix or narrower." }
    $b = $i.Bytes
    if ($i.Family -eq 'InterNetwork') {
        if ($b[0] -eq 127) { return 'Loopback addresses are never blocked.' }
        if ($b[0] -eq 0) { return 'The unspecified address cannot be blocked.' }
        if ($b[0] -ge 224) { return 'Multicast and reserved ranges are never blocked.' }
        if ($b[0] -eq 169 -and $b[1] -eq 254) { return 'Link-local addresses (automatic networking) are never blocked.' }
    } else {
        if ($i.Ip.IsIPv6LinkLocal -or $i.Ip.IsIPv6Multicast -or [Net.IPAddress]::IsLoopback($i.Ip) -or $i.Ip.Equals([Net.IPAddress]::IPv6Any)) { return 'Loopback, link-local, multicast and unspecified IPv6 addresses are never blocked.' }
    }
    foreach ($keep in @(Get-NetworkIdentity)) { if (Test-IpInCidr $i $keep) { return "Refused: this would block your gateway, DNS or DHCP server ($keep), which would cut the laptop off the network." } }
    return $null
}
function Test-PortTarget {
    param([int]$Port)
    if ($Port -lt 1 -or $Port -gt 65535) { return 'Ports run from 1 to 65535.' }
    if ($script:ProtectedPorts -contains $Port) { return "Port $Port is needed for DNS or DHCP and is never blocked." }
    $cfgPort = 0; try { $cfgPort = [int](Get-GuardianConfig).bridge.port } catch { }
    if ($cfgPort -and $Port -eq $cfgPort) { return 'That is Laptop Guardian''s own dashboard port.' }
    return $null
}
function Test-DomainTarget {
    param([string]$Domain)
    $d = $Domain.Trim().ToLowerInvariant().TrimEnd('.')
    if ($d -match '^\d{1,3}(\.\d{1,3}){3}$' -or $d -match ':') { return 'Give a host name, not an IP address (use a firewall rule for addresses).' }
    if ($d -match '[*?/\\ ]') { return 'Wildcards and paths are not supported: the hosts file can only block exact host names.' }
    if ($d -notmatch '^(?=.{4,253}$)([a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$') { return 'That is not a valid host name.' }
    foreach ($s in $script:ProtectedDnsSuffixes) { if ($d -eq $s -or $d.EndsWith(".$s")) { return "Protected: '$s' sites are needed by Windows, updates or security and are never blocked." } }
    return $null
}
