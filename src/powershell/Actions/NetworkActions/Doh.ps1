# DNS over HTTPS for one network interface (typed actions dns.doh-enable / dns.doh-restore).
# Dot-sourced by Actions\NetworkActions.psm1 (same module scope, so Pester mocks and exports are unchanged).
# The provider is chosen from a FIXED table (no address or URL is ever taken from input). Windows only upgrades a DNS server to DoH when the server
# is registered with a DoH template, so enabling = register the provider's addresses + point this interface at them. The interface's previous
# DNS servers are saved first, and restoring puts exactly those back (or "automatic" when it had none).
$script:DohProviders = [ordered]@{
    cloudflare = @{ servers = @('1.1.1.1', '1.0.0.1'); template = 'https://cloudflare-dns.com/dns-query'; label = 'Cloudflare' }
    google     = @{ servers = @('8.8.8.8', '8.8.4.4'); template = 'https://dns.google/dns-query'; label = 'Google Public DNS' }
    quad9      = @{ servers = @('9.9.9.9', '149.112.112.112'); template = 'https://dns.quad9.net/dns-query'; label = 'Quad9' }
}

# ---------- thin wrappers over Windows (mocked in tests) ----------
function Get-DohInterface { param([int]$Index) Get-NetIPInterface -InterfaceIndex $Index -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1 }
function Get-InterfaceDnsServers { param([int]$Index) @((Get-DnsClientServerAddress -InterfaceIndex $Index -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses) }
function Set-InterfaceDnsServers { param([int]$Index, [string[]]$Servers) Set-DnsClientServerAddress -InterfaceIndex $Index -ServerAddresses $Servers -ErrorAction Stop }
function Reset-InterfaceDnsServers { param([int]$Index) Set-DnsClientServerAddress -InterfaceIndex $Index -ResetServerAddresses -ErrorAction Stop }
function Get-DohEntries { @(Get-DnsClientDohServerAddress -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ server = [string]$_.ServerAddress; template = [string]$_.DohTemplate } }) }
function Add-DohEntry { param([string]$Server, [string]$Template) Add-DnsClientDohServerAddress -ServerAddress $Server -DohTemplate $Template -AllowFallbackToUdp $false -AutoUpgrade $true -ErrorAction Stop | Out-Null }
function Remove-DohEntry { param([string]$Server) Remove-DnsClientDohServerAddress -ServerAddress $Server -ErrorAction Stop }
function Get-DohBackupPath { param([int]$Index) Join-Path (Get-GuardianPath 'ElevatedBackups') "doh-previous-$Index.json" }

function Test-DohInterface {
    param([hashtable]$P)
    $idx = [int]$P.interfaceIndex
    $if = Get-DohInterface -Index $idx
    if (-not $if) { return New-RemResult -Ok $false -Errors @("Network interface $idx was not found.") }
    if ([string]$if.ConnectionState -ne 'Connected') { return New-RemResult -Ok $false -Errors @("Network interface $idx is not connected.") }
    if (-not (Test-AdminNet)) { return New-RemResult -Ok $false -NeedsAdmin $true -NeedsElevation $true -Errors @('Changing DNS settings needs administrator permission.') }
    return $null
}
function Test-DohEnable {
    param([hashtable]$P)
    if (-not $script:DohProviders.Contains([string]$P.provider)) { return New-RemResult -Ok $false -Errors @("'$($P.provider)' is not a DNS provider Guardian offers.") }
    $bad = Test-DohInterface -P $P; if ($bad) { return $bad }
    $prov = $script:DohProviders[[string]$P.provider]
    $now = @(Get-InterfaceDnsServers -Index ([int]$P.interfaceIndex))
    if ($now.Count -gt 0 -and -not (Compare-Object $now $prov.servers)) { return New-RemResult -Ok $false -Errors @("This interface already uses $($prov.label).") }
    return New-RemResult -Ok $true -NeedsAdmin $true -IdentityKey (Get-StringKey @('doh', [string]$P.interfaceIndex, [string]$P.provider, ($now -join ','))) -Details ([ordered]@{ provider = $prov.label; servers = $prov.servers; template = $prov.template; previous = $now })
}
function Invoke-DohEnable {
    param([hashtable]$P, $Validated)
    $idx = [int]$P.interfaceIndex; $prov = $script:DohProviders[[string]$P.provider]
    $before = @(Get-InterfaceDnsServers -Index $idx)
    $existing = @(Get-DohEntries | ForEach-Object { $_.server })
    $added = @()
    try {
        foreach ($s in $prov.servers) { if ($existing -notcontains $s) { Add-DohEntry -Server $s -Template $prov.template; $added += $s } }
        $backup = Get-DohBackupPath -Index $idx
        New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
        if (-not (Test-Path -LiteralPath $backup)) { Write-JsonFile -Path $backup -Object ([ordered]@{ interfaceIndex = $idx; servers = @($before); addedDohServers = @($added); savedAt = (Get-IsoNow) }) }
        Set-InterfaceDnsServers -Index $idx -Servers $prov.servers
    } catch { foreach ($s in $added) { try { Remove-DohEntry -Server $s } catch { } }; return New-RemResult -Ok $false -Errors @("Windows refused the DNS change: $($_.Exception.Message)") }
    $now = @(Get-InterfaceDnsServers -Index $idx); $reg = @(Get-DohEntries | ForEach-Object { $_.server })
    $ok = (-not (Compare-Object $now $prov.servers)) -and (@($prov.servers | Where-Object { $reg -notcontains $_ }).Count -eq 0)
    if (-not $ok) { return New-RemResult -Ok $false -Errors @('Windows did not report the new DNS servers and their DoH registration.') }
    return New-RemResult -Ok $true -Verified $true -Message "Interface $idx now uses $($prov.label) with encrypted DNS (DoH). Names are looked up over HTTPS, so your network cannot read them. Hosts-file blocks still apply to Windows lookups, but a program that uses its own DoH bypasses them." -Undo ([ordered]@{ action = 'dns.doh-restore'; params = [ordered]@{ interfaceIndex = [string]$idx } })
}
function Test-DohRestore {
    param([hashtable]$P)
    $bad = Test-DohInterface -P $P; if ($bad) { return $bad }
    $idx = [int]$P.interfaceIndex
    $have = Test-Path -LiteralPath (Get-DohBackupPath -Index $idx)
    return New-RemResult -Ok $true -NeedsAdmin $true -IdentityKey (Get-StringKey @('doh-restore', [string]$idx, $have)) -Details ([ordered]@{ hasSavedState = $have; current = @(Get-InterfaceDnsServers -Index $idx) })
}
function Invoke-DohRestore {
    param([hashtable]$P, $Validated)
    $idx = [int]$P.interfaceIndex; $backup = Get-DohBackupPath -Index $idx
    $prev = if (Test-Path -LiteralPath $backup) { Read-JsonFile -Path $backup -Default $null } else { $null }
    try {
        if ($prev -and @($prev.servers).Count -gt 0) { Set-InterfaceDnsServers -Index $idx -Servers @($prev.servers) } else { Reset-InterfaceDnsServers -Index $idx }
        if ($prev) { foreach ($s in @($prev.addedDohServers)) { try { Remove-DohEntry -Server ([string]$s) } catch { } }; Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
    } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    $now = @(Get-InterfaceDnsServers -Index $idx)
    if ($prev -and @($prev.servers).Count -gt 0 -and (Compare-Object $now @($prev.servers))) { return New-RemResult -Ok $false -Errors @('Windows did not report the saved DNS servers afterwards.') }
    $what = if ($prev -and @($prev.servers).Count -gt 0) { "the DNS servers it had before ($(@($prev.servers) -join ', '))" } else { 'automatic DNS (from your router or network)' }
    return New-RemResult -Ok $true -Verified $true -Message "Interface $idx is back on $what." -Details ([ordered]@{ restored = $true; hadSavedState = [bool]$prev })
}
