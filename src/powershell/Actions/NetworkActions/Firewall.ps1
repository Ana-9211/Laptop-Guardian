# firewall.create and firewall.manage.
# Dot-sourced by Actions\NetworkActions.psm1 (same module scope, so Pester mocks and exports are unchanged).
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
