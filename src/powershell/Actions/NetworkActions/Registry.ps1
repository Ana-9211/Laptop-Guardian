# Guardian-owned firewall rule registry (metadata only).
# Dot-sourced by Actions\NetworkActions.psm1 (same module scope, so Pester mocks and exports are unchanged).
# ---------- Guardian-owned rule registry (metadata only; the system is the source of truth) ----------
function Read-RuleRegistry { $p = Get-RulesRegistryPath; $r = Read-JsonFile -Path $p -Default $null; if ($r -and (Get-OptProp $r 'rules')) { return @($r.rules) } else { return @() } }
function Save-RuleRegistry { param($Rules) $p = Get-RulesRegistryPath; $dir = Split-Path $p; if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }; Write-JsonFile -Path $p -Object @{ updatedAt = (Get-IsoNow); rules = @($Rules) } }
function New-RuleName { '{0}{1}-{2}' -f $script:RulePrefix, [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(), ([guid]::NewGuid().ToString('N').Substring(0, 6)) }
function Test-GuardianOwned {
    param($Rule)
    return ($null -ne $Rule -and [string]$Rule.DisplayGroup -eq $script:RuleGroup -and ([string]$Rule.Name).StartsWith($script:RulePrefix, [StringComparison]::Ordinal))
}
function Get-ExpiryIso { param([string]$Duration) if ($script:DurationHours.ContainsKey($Duration)) { return (Get-Date).AddHours($script:DurationHours[$Duration]).ToString('yyyy-MM-ddTHH:mm:sszzz') } else { return $null } }
