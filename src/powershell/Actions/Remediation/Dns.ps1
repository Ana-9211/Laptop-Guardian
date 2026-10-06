# dns.flush
# Dot-sourced by Actions\Remediation.psm1 (same module scope, so Pester mocks and exports are unchanged).
function Get-DnsCacheCount { @(Get-DnsClientCache -ErrorAction SilentlyContinue).Count }
function Test-DnsFlush { Test-AdminOnlyAction 'Flushing the DNS cache' }
function Invoke-DnsFlush {
    $before = Get-DnsCacheCount
    try { Clear-DnsClientCache -ErrorAction Stop } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    $after = Get-DnsCacheCount
    if ($after -gt $before) { return New-RemResult -Ok $false -Errors @('The DNS cache did not shrink after the flush.') }
    return New-RemResult -Ok $true -Verified $true -Message "DNS cache cleared ($before entries before, $after now)." -Details ([ordered]@{ before = $before; after = $after })
}
