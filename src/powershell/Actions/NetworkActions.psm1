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

# ---------- Guardian-owned rule registry (metadata only; the system is the source of truth) ----------
function Read-RuleRegistry { $p = Get-RulesRegistryPath; $r = Read-JsonFile -Path $p -Default $null; if ($r -and (Get-OptProp $r 'rules')) { return @($r.rules) } else { return @() } }
function Save-RuleRegistry { param($Rules) $p = Get-RulesRegistryPath; $dir = Split-Path $p; if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }; Write-JsonFile -Path $p -Object @{ updatedAt = (Get-IsoNow); rules = @($Rules) } }
function New-RuleName { '{0}{1}-{2}' -f $script:RulePrefix, [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(), ([guid]::NewGuid().ToString('N').Substring(0, 6)) }
function Test-GuardianOwned {
    param($Rule)
    return ($null -ne $Rule -and [string]$Rule.DisplayGroup -eq $script:RuleGroup -and ([string]$Rule.Name).StartsWith($script:RulePrefix, [StringComparison]::Ordinal))
}
function Get-ExpiryIso { param([string]$Duration) if ($script:DurationHours.ContainsKey($Duration)) { return (Get-Date).AddHours($script:DurationHours[$Duration]).ToString('yyyy-MM-ddTHH:mm:sszzz') } else { return $null } }

# ---------- firewall: create ----------
function Get-RuleSpecKey { param($Dir, $Act, $Prog, $Proto, $Port, $Remote) return (@($Dir, $Act, $Prog, $Proto, $Port, $Remote) | ForEach-Object { ([string]$_).ToLowerInvariant() }) -join '|' }
function Test-FirewallCreate {
    param([hashtable]$P, [string]$Kind)
    switch ($Kind) {
        'block-program' { $err = Test-ProgramTarget ([string]$P.path); $key = Get-RuleSpecKey $P.direction 'Block' $P.path '' '' '' }
        'allow-program' { $err = Test-ProgramTarget ([string]$P.path); $key = Get-RuleSpecKey $P.direction 'Allow' $P.path '' '' '' }
        'block-port' { $err = Test-PortTarget ([int]$P.port); $key = Get-RuleSpecKey 'Inbound' 'Block' '' $P.protocol $P.port '' }
        'block-remote' { $err = Test-RemoteTarget ([string]$P.remote); $key = Get-RuleSpecKey 'Outbound' 'Block' '' 'Any' '' $P.remote }
    }
    if ($err) { return New-RemResult -Ok $false -Errors @($err) }
    $existing = @(Get-GuardianFwRules)
    if ($existing.Count -ge $script:MaxGuardianRules) { return New-RemResult -Ok $false -Errors @("Guardian already manages $($existing.Count) firewall rules (the limit is $($script:MaxGuardianRules)). Remove some first.") }
    foreach ($r in $existing) {
        $d = Get-FwRuleDetail $r
        if ((Get-RuleSpecKey ([string]$r.Direction) ([string]$r.Action) $d.program $(if ($d.protocol -in 'Any', '') { '' } else { $d.protocol }) $(if ($d.localPort -in 'Any', '') { '' } else { $d.localPort }) $(if ($d.remoteAddress -in 'Any', '') { '' } else { $d.remoteAddress })) -eq $key) { return New-RemResult -Ok $false -Errors @("An identical Guardian rule already exists ($($r.Name)).") }
    }
    $warn = @()
    if ($Kind -eq 'allow-program') {
        $pp = [string]$P.path
        $tmp = @($env:TEMP, (Join-Path $env:USERPROFILE 'Downloads')) | Where-Object { $_ }
        foreach ($t in $tmp) { if ($pp.StartsWith($t.TrimEnd([char]92) + [char]92, [StringComparison]::OrdinalIgnoreCase)) { return New-RemResult -Ok $false -Errors @('Guardian will not allow a program that lives in a temporary or Downloads folder through the firewall.') } }
        if ($env:USERPROFILE -and $pp.StartsWith($env:USERPROFILE.TrimEnd([char]92) + [char]92, [StringComparison]::OrdinalIgnoreCase)) { $warn += 'This program is in a folder your account can change, so other software running as you could replace it. Allow it only if you trust it.' }
    }
    if (-not (Test-AdminNet)) { return New-RemResult -Ok $false -NeedsAdmin $true -NeedsElevation $true -Warnings $warn -Errors @('Creating a firewall rule needs administrator permission.') }
    return New-RemResult -Ok $true -NeedsAdmin $true -Warnings $warn -IdentityKey (Get-StringKey @('fwc', $Kind, $key)) -Details ([ordered]@{ key = $key; guardianRules = $existing.Count })
}
function Invoke-FirewallCreate {
    param([hashtable]$P, [string]$Kind)
    $name = New-RuleName
    $dur = if ($P.ContainsKey('duration') -and $P.duration) { [string]$P.duration } else { 'permanent' }
    $expires = Get-ExpiryIso $dur
    $note = "Created by Laptop Guardian $(Get-IsoNow). $(if ($expires) { "Review or remove after $expires." } else { 'No expiry.' })"
    # Block rules protect every network. An allow rule opens a door, so it never applies on public networks.
    $spec = @{ Name = $name; Group = $script:RuleGroup; Profile = $(if ($Kind -like 'allow*') { @('Private', 'Domain') } else { 'Any' }); Enabled = 'True'; Description = $note }
    switch ($Kind) {
        'block-program' { $spec += @{ DisplayName = "Laptop Guardian: block $([IO.Path]::GetFileName([string]$P.path)) ($($P.direction))"; Direction = [string]$P.direction; Action = 'Block'; Program = [string]$P.path } }
        'allow-program' { $spec += @{ DisplayName = "Laptop Guardian: allow $([IO.Path]::GetFileName([string]$P.path)) ($($P.direction))"; Direction = [string]$P.direction; Action = 'Allow'; Program = [string]$P.path } }
        'block-port' { $spec += @{ DisplayName = "Laptop Guardian: block inbound $($P.protocol) port $($P.port)"; Direction = 'Inbound'; Action = 'Block'; Protocol = [string]$P.protocol; LocalPort = [string]$P.port } }
        'block-remote' { $spec += @{ DisplayName = "Laptop Guardian: block outbound to $($P.remote)"; Direction = 'Outbound'; Action = 'Block'; RemoteAddress = [string]$P.remote } }
    }
    try { New-FwRule -Spec $spec } catch { return New-RemResult -Ok $false -Errors @("Windows rejected the rule: $($_.Exception.Message)") }
    $r = Get-FwRuleByName -Name $name
    $okAction = if ($Kind -like 'allow*') { 'Allow' } else { 'Block' }
    if (-not $r -or -not (Test-GuardianOwned $r) -or [string]$r.Enabled -ne 'True' -or [string]$r.Action -ne $okAction) { return New-RemResult -Ok $false -Errors @('The rule was not found in Windows Firewall after creation, or it has the wrong settings.') }
    $reg = @(Read-RuleRegistry) + @([ordered]@{ name = $name; kind = $Kind; params = $P; createdAt = (Get-IsoNow); expiresAt = $expires; duration = $dur })
    $regWarn = @(); try { Save-RuleRegistry -Rules $reg } catch { $regWarn = @("The rule was created, but Guardian could not record its review reminder: $($_.Exception.Message)") }
    return New-RemResult -Ok $true -Verified $true -Message "Firewall rule $name created and verified in the Laptop Guardian group ($(if ($expires) { "review after $expires" } else { 'no expiry' }))." -Warnings $regWarn -Details ([ordered]@{ ruleName = $name; expiresAt = $expires }) -Undo ([ordered]@{ action = 'firewall.remove-rule'; params = [ordered]@{ name = $name } })
}

# ---------- firewall: manage existing Guardian rules ----------
function Test-FirewallManage {
    param([hashtable]$P, [string]$Op)
    $name = [string]$P.name
    $r = Get-FwRuleByName -Name $name
    if (-not $r) { return New-RemResult -Ok $false -Errors @("There is no firewall rule named $name.") }
    if (-not (Test-GuardianOwned $r)) { return New-RemResult -Ok $false -Errors @('Refused: that rule was not created by Laptop Guardian. Guardian never changes Windows, enterprise, third-party or your own rules.') }
    $enabled = ([string]$r.Enabled -eq 'True')
    if ($Op -eq 'enable' -and $enabled) { return New-RemResult -Ok $false -Errors @('This rule is already enabled.') }
    if ($Op -eq 'disable' -and -not $enabled) { return New-RemResult -Ok $false -Errors @('This rule is already disabled.') }
    if (-not (Test-AdminNet)) { return New-RemResult -Ok $false -NeedsAdmin $true -NeedsElevation $true -Errors @('Changing a firewall rule needs administrator permission.') }
    return New-RemResult -Ok $true -NeedsAdmin $true -IdentityKey (Get-StringKey @('fwm', $name, [string]$r.Enabled)) -Details ([ordered]@{ displayName = [string]$r.DisplayName; enabled = $enabled })
}
function Invoke-FirewallManage {
    param([hashtable]$P, [string]$Op)
    $name = [string]$P.name
    try {
        switch ($Op) { 'remove' { Remove-FwRule -Name $name } 'enable' { Set-FwRuleEnabled -Name $name -Enabled $true } 'disable' { Set-FwRuleEnabled -Name $name -Enabled $false } }
    } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    $r = Get-FwRuleByName -Name $name
    $ok = switch ($Op) { 'remove' { -not $r } 'enable' { $r -and [string]$r.Enabled -eq 'True' } 'disable' { $r -and [string]$r.Enabled -ne 'True' } }
    if (-not $ok) { return New-RemResult -Ok $false -Errors @('Windows Firewall did not report the new state.') }
    $remWarn = @(); if ($Op -eq 'remove') { try { Save-RuleRegistry -Rules @(Read-RuleRegistry | Where-Object { $_.name -ne $name }) } catch { $remWarn = @("The rule was removed, but Guardian could not update its own list: $($_.Exception.Message)") } }
    $undo = switch ($Op) { 'enable' { [ordered]@{ action = 'firewall.disable-rule'; params = [ordered]@{ name = $name } } } 'disable' { [ordered]@{ action = 'firewall.enable-rule'; params = [ordered]@{ name = $name } } } default { $null } }
    return New-RemResult -Ok $true -Verified $true -Message "Rule $name $(switch ($Op) { 'remove' { 'removed' } 'enable' { 'enabled' } 'disable' { 'disabled' } })." -Warnings $remWarn -Undo $undo
}

# ---------- DNS: hosts-file block ----------
function Get-HostsParts {
    <# Splits hosts text into before / managed-domains / after. Everything outside the markers is returned untouched. #>
    param([string]$Text)
    $eol = if ($Text -match "`r`n") { "`r`n" } else { "`n" }
    $b = $Text.IndexOf($script:HostsBegin, [StringComparison]::Ordinal)
    if ($b -lt 0) { return [pscustomobject]@{ Before = $Text; Domains = @(); After = ''; HasBlock = $false; Eol = $eol } }
    $e = $Text.IndexOf($script:HostsEnd, $b, [StringComparison]::Ordinal)
    if ($e -lt 0) { throw 'The hosts file has a Laptop Guardian start marker without an end marker; refusing to edit it.' }
    $blockEnd = $e + $script:HostsEnd.Length
    if ($Text.Length -ge $blockEnd + 2 -and $Text.Substring($blockEnd, 2) -eq "`r`n") { $blockEnd += 2 } elseif ($Text.Length -ge $blockEnd + 1 -and $Text[$blockEnd] -eq "`n") { $blockEnd += 1 }
    $inner = $Text.Substring($b + $script:HostsBegin.Length, $e - $b - $script:HostsBegin.Length)
    $domains = @([regex]::Matches($inner, '(?m)^0\.0\.0\.0\s+(\S+)\s*$') | ForEach-Object { $_.Groups[1].Value })
    [pscustomobject]@{ Before = $Text.Substring(0, $b); Domains = $domains; After = $Text.Substring($blockEnd); HasBlock = $true; Eol = $eol }
}
function Format-HostsText {
    param($Parts, [string[]]$Domains)
    $before = $Parts.Before; $after = $Parts.After; $eol = $Parts.Eol
    if (-not $Domains.Count) { return $before + $after }
    if ($before.Length -gt 0 -and -not $before.EndsWith("`n")) { $before += $eol }
    $lines = @($script:HostsBegin) + @($Domains | Sort-Object | ForEach-Object { "0.0.0.0 $_" }) + @($script:HostsEnd)
    return $before + ($lines -join $eol) + $eol + $after
}
function Update-GuardianHostsBlockFile {
    <# Adds or removes domains inside the managed block of ONE hosts file; backs it up first. Returns the resulting domain list. #>
    param([Parameter(Mandatory)][string]$Path, [string[]]$Add = @(), [string[]]$Remove = @(), [switch]$RemoveAll, [string]$BackupDir)
    $enc = New-Object Text.UTF8Encoding($false); $text = ''
    if (Test-Path -LiteralPath $Path) {
        # Keep the file's own encoding (a BOM, or UTF-16, is preserved rather than silently rewritten as UTF-8).
        $sr = New-Object IO.StreamReader($Path, $enc, $true)
        try { $text = $sr.ReadToEnd(); $enc = $sr.CurrentEncoding } finally { $sr.Dispose() }
    }
    $parts = Get-HostsParts -Text $text
    $set = New-Object System.Collections.Generic.List[string]
    foreach ($d in $parts.Domains) { if (-not $set.Contains($d)) { $set.Add($d) } }
    if ($RemoveAll) { $set.Clear() }
    foreach ($d in $Remove) { [void]$set.Remove($d.ToLowerInvariant()) }
    foreach ($d in $Add) { $l = $d.ToLowerInvariant(); if (-not $set.Contains($l)) { $set.Add($l) } }
    $new = Format-HostsText -Parts $parts -Domains @($set)
    if ($new -ceq $text) { return @($set) }
    if ($BackupDir -and (Test-Path -LiteralPath $Path)) {
        if (-not (Test-Path -LiteralPath $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }
        $orig = Join-Path $BackupDir 'hosts.original'
        if (-not (Test-Path -LiteralPath $orig)) { [IO.File]::WriteAllText($orig, $text) }
        [IO.File]::WriteAllText((Join-Path $BackupDir ('hosts.before-{0:yyyyMMdd-HHmmss}' -f (Get-Date))), $text)
    }
    # Write a temporary file next to it and swap it in, so a crash can never leave a half-written hosts file.
    $tmp = "$Path.lg-new"
    try {
        [IO.File]::WriteAllText($tmp, $new, $enc)
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [IO.File]::Move($tmp, $Path) }
    } finally { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } }
    # Programs may hold old answers: flush the resolver cache, but only when the REAL hosts file was edited.
    if ($Path -ieq (Get-HostsFilePath)) { try { Clear-DnsClientCache -ErrorAction Stop } catch { } }
    return @($set)
}
function Get-HostsDomains { param([string]$Path) $t = if (Test-Path -LiteralPath $Path) { [IO.File]::ReadAllText($Path) } else { '' }; return @((Get-HostsParts -Text $t).Domains) }
function Test-DnsFilteringEnabled {
    # The raw config file is read on purpose: Get-GuardianConfig only keeps keys it has defaults for.
    try { $c = Read-JsonFile -Path (Get-GuardianPath 'Config') -Default $null; return ($c -and (Get-OptProp $c 'network') -and (Get-OptProp $c.network 'dnsFiltering') -and $c.network.dnsFiltering.enabled -eq $true) } catch { return $false }
}

function Test-DnsBlock {
    param([hashtable]$P, [string]$Op)
    $dom = ([string]$P.domain).Trim().ToLowerInvariant().TrimEnd('.')
    if ($Op -eq 'block') {
        if (-not (Test-DnsFilteringEnabled)) { return New-RemResult -Ok $false -Errors @('DNS filtering is off. Turn it on (opt-in) in Network Guard first.') }
        $err = Test-DomainTarget $dom; if ($err) { return New-RemResult -Ok $false -Errors @($err) }
    }
    $hosts = Get-HostsFilePath
    try { $cur = @(Get-HostsDomains -Path $hosts) } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    if ($Op -eq 'block' -and ($cur -contains $dom)) { return New-RemResult -Ok $false -Errors @("$dom is already blocked.") }
    if ($Op -eq 'unblock' -and -not ($cur -contains $dom)) { return New-RemResult -Ok $false -Errors @("$dom is not blocked by Guardian.") }
    if (-not (Test-AdminNet)) { return New-RemResult -Ok $false -NeedsAdmin $true -NeedsElevation $true -Errors @('Editing the hosts file needs administrator permission.') }
    return New-RemResult -Ok $true -NeedsAdmin $true -IdentityKey (Get-StringKey @('dns', $Op, $dom, $cur.Count)) -Details ([ordered]@{ domain = $dom; blockedNow = $cur.Count })
}
function Invoke-DnsBlock {
    param([hashtable]$P, [string]$Op)
    $dom = ([string]$P.domain).Trim().ToLowerInvariant().TrimEnd('.')
    $hosts = Get-HostsFilePath
    try { if ($Op -eq 'block') { [void](Update-GuardianHostsBlockFile -Path $hosts -Add @($dom) -BackupDir (Get-HostsBackupDir)) } else { [void](Update-GuardianHostsBlockFile -Path $hosts -Remove @($dom) -BackupDir (Get-HostsBackupDir)) } }
    catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    $now = @(Get-HostsDomains -Path $hosts)
    $ok = if ($Op -eq 'block') { $now -contains $dom } else { -not ($now -contains $dom) }
    if (-not $ok) { return New-RemResult -Ok $false -Errors @('The hosts file does not show the change after writing.') }
    $undo = [ordered]@{ action = $(if ($Op -eq 'block') { 'dns.unblock-domain' } else { 'dns.block-domain' }); params = [ordered]@{ domain = $dom } }
    return New-RemResult -Ok $true -Verified $true -Message "$dom is now $(if ($Op -eq 'block') { 'blocked' } else { 'unblocked' }) in the Laptop Guardian section of the hosts file. Programs that use their own encrypted DNS (DoH) can bypass this." -Undo $undo
}
function Test-DnsRollback {
    $hosts = Get-HostsFilePath
    try { $cur = @(Get-HostsDomains -Path $hosts) } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    if (-not $cur.Count) { return New-RemResult -Ok $false -Errors @('Guardian has no DNS blocks to roll back.') }
    if (-not (Test-AdminNet)) { return New-RemResult -Ok $false -NeedsAdmin $true -NeedsElevation $true -Errors @('Editing the hosts file needs administrator permission.') }
    return New-RemResult -Ok $true -NeedsAdmin $true -IdentityKey (Get-StringKey @('dnsrb', $cur.Count)) -Details ([ordered]@{ blocked = @($cur) })
}
function Invoke-DnsRollback {
    $hosts = Get-HostsFilePath
    try { [void](Update-GuardianHostsBlockFile -Path $hosts -RemoveAll -BackupDir (Get-HostsBackupDir)) } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    if (@(Get-HostsDomains -Path $hosts).Count) { return New-RemResult -Ok $false -Errors @('Some Guardian blocks are still in the hosts file.') }
    return New-RemResult -Ok $true -Verified $true -Message 'Every Laptop Guardian DNS block was removed from the hosts file. Nothing else in the file was changed.'
}

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

Export-ModuleMember -Function Test-FirewallCreate, Invoke-FirewallCreate, Test-FirewallManage, Invoke-FirewallManage, Test-DnsBlock, Invoke-DnsBlock, Test-DnsRollback, Invoke-DnsRollback, Test-DnsLogChange, Invoke-DnsLogChange, Update-GuardianHostsBlockFile, Get-HostsParts, Get-HostsDomains, Test-DomainTarget, Test-RemoteTarget, Test-PortTarget, Test-ProgramTarget, Test-GuardianOwned, ConvertTo-IpInfo
