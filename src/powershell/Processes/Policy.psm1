#requires -Version 5.1
# Policy: user-controlled blacklist / whitelist / ignored processes, and blacklist enforcement.
Set-StrictMode -Version 2.0

function ConvertTo-ProcKey { param([string]$Name) if (-not $Name) { return '' }; return ($Name.Trim().ToLowerInvariant() -replace '\.exe$', '') }

function Get-ProcessPolicy {
    $raw = Read-JsonFile -Path (Get-GuardianPath 'ProcessPolicy') -Default $null
    $h = [ordered]@{ blacklist = @(); whitelist = @(); ignored = @() }
    if ($raw) { foreach ($k in 'blacklist', 'whitelist', 'ignored') { if ((Get-PropNames $raw) -contains $k -and $null -ne $raw.$k) { $h[$k] = @($raw.$k) } } }
    return [pscustomobject]$h
}

function Save-ProcessPolicy {
    param($Policy)
    Write-JsonFile -Path (Get-GuardianPath 'ProcessPolicy') -Object ([ordered]@{ blacklist = @($Policy.blacklist); whitelist = @($Policy.whitelist); ignored = @($Policy.ignored) })
}

function Test-PolicyEntryActive {
    param($Entry)
    if ((Get-PropNames $Entry) -contains 'enabled' -and $Entry.enabled -eq $false) { return $false }
    if ((Get-PropNames $Entry) -contains 'disabledUntil' -and $Entry.disabledUntil) {
        try { if ([datetime]$Entry.disabledUntil -gt (Get-Date)) { return $false } } catch { }
    }
    return $true
}

function Find-PolicyMatch {
    <# Precedence: whitelist > blacklist > ignored. Returns @{list;entry}. #>
    param($Policy, [string]$Name, [string]$Path)
    $k = ConvertTo-ProcKey $Name
    foreach ($list in 'whitelist', 'blacklist', 'ignored') {
        foreach ($e in @($Policy.$list)) {
            if ((ConvertTo-ProcKey $e.name) -ne $k) { continue }
            $ep = if ((Get-PropNames $e) -contains 'path') { $e.path } else { $null }
            if ($ep -and (-not $Path -or ($ep -ine $Path))) { continue }   # path-scoped entry: must match exactly
            if (-not (Test-PolicyEntryActive $e) -and $list -eq 'blacklist') { continue }
            return [pscustomobject]@{ list = $list; entry = $e }
        }
    }
    return [pscustomobject]@{ list = 'none'; entry = $null }
}

function Add-PolicyEntry {
    param([ValidateSet('blacklist', 'whitelist', 'ignored')][string]$List, [Parameter(Mandatory)][string]$Name, [string]$Path, [string]$Reason = 'Added by user')
    if ($Name -notmatch '^[A-Za-z0-9 _.\-\(\)]{1,100}$') { throw "Invalid process name '$Name'" }
    $pol = Get-ProcessPolicy
    $key = ConvertTo-ProcKey $Name
    $existing = @($pol.$List | Where-Object { (ConvertTo-ProcKey $_.name) -eq $key -and ([string]$_.path) -ieq ([string]$Path) })
    if ($existing.Count -gt 0) { return $existing[0] }
    $entry = [pscustomobject][ordered]@{
        id = New-ShortId; name = $key; path = $(if ($Path) { $Path } else { $null }); reason = $Reason; addedAt = Get-IsoNow; addedBy = 'user'
        enabled = $true; action = $(if ($List -eq 'blacklist') { 'terminate' } else { 'none' }); terminatedCount = 0; lastTerminatedAt = $null; disabledUntil = $null
    }
    $pol.$List = @($pol.$List) + $entry
    Save-ProcessPolicy $pol
    [void](Write-GuardianEvent -Category policy -Action "policy:add-$List" -Target $key -Actor user -Reason $Reason)
    return $entry
}

function Remove-PolicyEntry {
    param([ValidateSet('blacklist', 'whitelist', 'ignored')][string]$List, [Parameter(Mandatory)][string]$Id)
    $pol = Get-ProcessPolicy
    $pol.$List = @($pol.$List | Where-Object { $_.id -ne $Id })
    Save-ProcessPolicy $pol
    [void](Write-GuardianEvent -Category policy -Action "policy:remove-$List" -Target $Id -Actor user)
}

function Invoke-BlacklistEnforcement {
    <# Terminates running processes that match an ENABLED, user-created blacklist entry. Never touches unknown or protected processes. #>
    param($Processes, $Config)
    $results = New-Object System.Collections.ArrayList
    if ($Config.safety.safeMode -or $Config.safety.automationPaused -or -not $Config.safety.autoKillBlacklisted) {
        $why = if ($Config.safety.safeMode) { 'safe mode' } elseif ($Config.safety.automationPaused) { 'automation paused' } else { 'auto-kill disabled' }
        $hits = @($Processes | Where-Object { $_.policy -eq 'blacklist' })
        if ($hits.Count -gt 0) { [void](Write-GuardianEvent -Category policy -Action 'blacklist:enforcement-skipped' -Result skipped -Actor policy -Reason "$($hits.Count) blacklisted process(es) running; $why") }
        return @($results)
    }
    $pol = Get-ProcessPolicy
    $changed = $false
    foreach ($p in @($Processes | Where-Object { $_.policy -eq 'blacklist' })) {
        $m = Find-PolicyMatch -Policy $pol -Name $p.name -Path $p.path
        if ($m.list -ne 'blacklist' -or $m.entry.action -ne 'terminate') { continue }
        $chk = Test-ProcessKillAllowed -Name $p.name -Path $p.path -ProcessId $p.pid
        if (-not $chk.Allowed) {
            [void](Write-GuardianEvent -Category process -Action 'process:terminate-blocked' -Target "$($p.name)#$($p.pid)" -Result skipped -Actor policy -Reason $chk.Reason)
            continue
        }
        try {
            # Re-verify the PID still refers to the same executable (PID reuse protection)
            $live = Get-Process -Id $p.pid -ErrorAction Stop
            $livePath = $null; try { $livePath = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.pid)" -ErrorAction Stop).ExecutablePath } catch { }
            if (-not $livePath) { try { $livePath = $live.Path } catch { } }
            if (-not $livePath) { throw 'executable path unreadable; refusing to terminate' }
            if (-not (Test-ProcessKillAllowed -Name $p.name -Path $livePath -ProcessId $p.pid).Allowed) { throw 'live executable is protected' }
            if ($p.path -and ($livePath -ine $p.path)) { throw 'PID now belongs to a different executable' }
            Stop-Process -Id $p.pid -ErrorAction Stop
            [void](Write-GuardianEvent -Category process -Action 'process:terminated' -Target "$($p.name)#$($p.pid)" -Actor policy -Reason "User blacklist entry $($m.entry.id)")
            $m.entry.terminatedCount = [int]$m.entry.terminatedCount + 1
            $m.entry.lastTerminatedAt = Get-IsoNow
            $changed = $true
            [void]$results.Add([pscustomobject]@{ name = $p.name; pid = $p.pid; result = 'terminated' })
        } catch {
            [void](Write-GuardianEvent -Category process -Action 'process:terminate' -Target "$($p.name)#$($p.pid)" -Result failure -Severity warning -Actor policy -ErrorDetails $_.Exception.Message)
            [void]$results.Add([pscustomobject]@{ name = $p.name; pid = $p.pid; result = 'failed' })
        }
    }
    if ($changed) { Save-ProcessPolicy $pol }
    return @($results)
}

Export-ModuleMember -Function *
