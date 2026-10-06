# DNS blocks in the Laptop Guardian section of the hosts file.
# Dot-sourced by Actions\NetworkActions.psm1 (same module scope, so Pester mocks and exports are unchanged).
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
