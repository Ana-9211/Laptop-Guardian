#requires -Version 5.1
# Recommendation engine (deterministic) + persistent recommendation store with recurrence tracking.
Set-StrictMode -Version 2.0

function New-RecId {
    param([string]$Kind, [string]$Name, [string]$Path)
    $s = ("{0}|{1}|{2}" -f $Kind, $Name, $Path).ToLowerInvariant()
    $sha = [System.Security.Cryptography.SHA1]::Create()
    $h = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s))
    return (($h | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
}

function New-Cmd {
    param([string]$Command, [string]$Explains, [string]$Risk = 'LOW', [bool]$RequiresAdmin = $false, [bool]$Reversible = $true)
    if (-not (Test-CommandAllowed $Command)) { return $null }
    return [pscustomobject][ordered]@{ command = $Command; explains = $Explains; risk = $Risk; requiresAdmin = $RequiresAdmin; reversible = $Reversible }
}

function Get-StopCommand {
    param($Proc)
    $c = New-Cmd -Command "Stop-Process -Id $($Proc.pid)" -Explains 'Asks Windows to terminate this process instance. It may restart on its own if a service, scheduled task or startup entry relaunches it. Unsaved work in the app is lost.' -Risk 'MEDIUM' -Reversible $false
    return $c
}

function Get-PreventRestartCommand {
    <# Returns the verified procedure for the first persistence mechanism found. Display-only. #>
    param($Proc)
    if (-not $Proc.persistent) { return $null }
    if (@($Proc.services).Count -gt 0) {
        $svc = @($Proc.services)[0]
        $cmd = New-Cmd -Command "Set-Service -Name $svc -StartupType Disabled" -Explains "Prevents Windows service '$svc' from starting automatically. Run Stop-Service first to stop it now. Re-enable with -StartupType Automatic (or Manual)." -Risk 'MEDIUM' -RequiresAdmin $true -Reversible $true
        if ($cmd) { return $cmd }
    }
    if (@($Proc.scheduledTasks).Count -gt 0) {
        $t = @($Proc.scheduledTasks)[0]
        $idx = $t.LastIndexOf('\'); $tp = $t.Substring(0, $idx + 1); $tn = $t.Substring($idx + 1)
        $cmd = New-Cmd -Command "Disable-ScheduledTask -TaskName '$tn' -TaskPath '$tp'" -Explains "Disables scheduled task '$t' so it no longer relaunches this program. Re-enable with Enable-ScheduledTask." -Risk 'LOW' -RequiresAdmin ($tp -notlike '\Users*') -Reversible $true
        if ($cmd) { return $cmd }
    }
    if (@($Proc.startupEntries).Count -gt 0) {
        $cmd = New-Cmd -Command 'Start-Process ms-settings:startupapps' -Explains 'Opens Settings > Apps > Startup where you can switch this app off. Safest and fully reversible way to remove a Run-key or Startup-folder entry.' -Risk 'LOW' -Reversible $true
        if ($cmd) { return $cmd }
    }
    return [pscustomobject][ordered]@{ command = 'Start-Process appwiz.cpl'; explains = 'Opens Programs and Features to uninstall the associated application if you no longer need it.'; risk = 'MEDIUM'; requiresAdmin = $false; reversible = $false }
}

function Get-PersistenceMechanisms {
    param($Proc)
    $m = @()
    foreach ($s in @($Proc.services)) { $m += [pscustomobject]@{ kind = 'service'; name = $s; location = 'Windows Service Control Manager' } }
    foreach ($t in @($Proc.scheduledTasks)) { $m += [pscustomobject]@{ kind = 'task'; name = $t; location = 'Task Scheduler' } }
    foreach ($e in @($Proc.startupEntries)) { $m += [pscustomobject]@{ kind = $e.kind; name = $e.name; location = $e.location } }
    return $m
}

function New-ProcessRecommendations {
    <# One recommendation per process name+path (instances grouped). Whitelisted, Windows-classified and ignored processes are skipped. #>
    param($Processes, $Config)
    $recs = New-Object System.Collections.ArrayList
    $groups = $Processes | Group-Object { ($_.name + '|' + $_.path).ToLowerInvariant() }
    foreach ($g in $groups) {
        $items = @($g.Group)
        # representative: highest memory instance
        $p = $items | Sort-Object memoryMB -Descending | Select-Object -First 1
        if ($p.policy -in @('whitelist', 'ignored')) { continue }
        $n = $p.name.ToLowerInvariant()
        if ($p.classification -eq 'windows' -and $p.policy -ne 'blacklist') { continue }
        if ((Get-ProtectedProcessNames) -contains $n -and $p.policy -ne 'blacklist') { continue }
        $flags = @($items | ForEach-Object { $_.flags } | Select-Object -Unique)
        $totalMem = [math]::Round(($items | Measure-Object memoryMB -Sum).Sum, 0)
        $maxCpu = ($items | Measure-Object cpuPct -Maximum).Maximum
        $why = New-Object System.Collections.ArrayList
        $evidence = 0
        if ($flags -contains 'blacklisted') { [void]$why.Add('Matches your process blacklist.'); $evidence += 3 }
        if ($flags -contains 'high-cpu') { [void]$why.Add(("CPU {0}% during the sample window (threshold {1}%)." -f $maxCpu, $Config.thresholds.cpuPct)); $evidence++ }
        if ($flags -contains 'high-memory') { [void]$why.Add(("Using {0} MB across {1} instance(s) (threshold {2} MB per process)." -f $totalMem, $items.Count, $Config.thresholds.memoryMB)); $evidence++ }
        if ($flags -contains 'unusual-location') { [void]$why.Add("Runs from an unusual location ($($p.pathClass)): $($p.path)"); $evidence += 2 }
        if ($flags -contains 'unsigned' -and $flags -contains 'unusual-location') { [void]$why.Add('Executable has no valid digital signature.'); $evidence++ }
        if ($flags -contains 'duplicate') { [void]$why.Add("$($items.Count) instances of the same executable are running."); $evidence++ }
        if ($flags -contains 'persistent' -and ($flags -contains 'high-cpu' -or $flags -contains 'high-memory' -or $flags -contains 'unusual-location' -or $p.classification -eq 'unknown')) {
            [void]$why.Add('Persistent: it restarts automatically (service, task or startup entry).'); $evidence++
        }
        if ($why.Count -eq 0) { continue }
        if ($why.Count -eq 1 -and $flags -contains 'duplicate' -and $items.Count -lt 8) { continue }
        # Persistence alone (signed, known, quiet) is not worth an inbox item
        if ($why.Count -eq 1 -and $flags -contains 'persistent') { continue }
        # Signed known app with only a single mild resource flag -> skip noise unless blacklisted
        if ($p.policy -ne 'blacklist' -and $p.classification -eq 'known-app' -and $why.Count -eq 1 -and $flags -contains 'duplicate') { continue }

        $risk = 'LOW'
        if ($flags -contains 'unusual-location' -and -not $p.signed) { $risk = 'MEDIUM' }
        elseif ($p.classification -eq 'unknown' -and $evidence -ge 2) { $risk = 'UNKNOWN' }
        elseif ($flags -contains 'high-cpu' -and $p.classification -in @('third-party', 'unknown')) { $risk = 'MEDIUM' }
        if ($flags -contains 'blacklisted') { $risk = 'LOW' }

        $action = 'Review'
        if ($flags -contains 'blacklisted') { $action = 'Stop temporarily' }
        elseif ($risk -eq 'MEDIUM' -and $flags -contains 'unusual-location') { $action = 'Investigate further' }
        elseif ($flags -contains 'persistent' -and ($flags -contains 'high-memory' -or $flags -contains 'high-cpu')) { $action = if (@($p.services).Count) { 'Review' } elseif (@($p.scheduledTasks).Count) { 'Disable scheduled task' } else { 'Disable startup' } }
        elseif ($flags -contains 'high-memory' -or $flags -contains 'high-cpu') { $action = 'Stop temporarily' }
        if ($p.classification -eq 'known-app' -and $action -eq 'Stop temporarily' -and $flags -notcontains 'blacklisted') { $action = 'Review' }

        $conf = [math]::Min(0.9, 0.45 + 0.1 * $evidence)
        if (-not $p.path) { $conf = [math]::Max(0.3, $conf - 0.2) }
        $sev = switch ($risk) { 'MEDIUM' { 'medium' } 'UNKNOWN' { 'low' } default { 'low' } }
        if ($flags -contains 'unusual-location' -and -not $p.signed -and $flags -contains 'persistent') { $sev = 'high' }

        $mech = @(Get-PersistenceMechanisms $p)
        $consequence = switch ($action) {
            'Stop temporarily' { "The app closes until it is next launched. Unsaved work may be lost. $(if ($p.persistent) { 'It may relaunch automatically.' } else { 'It will not come back by itself.' })" }
            'Disable startup' { 'The app stops launching at sign-in. You can still start it manually. Fully reversible.' }
            'Disable scheduled task' { 'Whatever the task provided (updates, sync, helpers) will stop running on schedule. Re-enable at any time.' }
            'Investigate further' { 'Nothing changes until you decide. Check the file signature, VirusTotal-style reputation and where it came from before removing anything.' }
            default { 'No change is made. This is a prompt to look, not an instruction.' }
        }
        $rec = [pscustomobject][ordered]@{
            id = New-RecId 'process' $n $p.path; kind = 'process'
            title = "$($p.name) $(if ($items.Count -gt 1) { "($($items.Count) instances)" })".Trim() + ' - ' + ($why[0] -replace '\.$', '')
            status = 'open'; risk = $risk; severity = $sev; confidence = [math]::Round($conf, 2); source = 'deterministic'
            firstSeen = Get-IsoNow; lastSeen = Get-IsoNow; occurrences = 1; consecutiveDays = 1
            target = [pscustomobject]@{ name = $p.name; pid = $p.pid; path = $p.path }
            identity = [pscustomobject]@{ name = $p.name; pid = $p.pid; path = $p.path; publisher = $p.publisher; signature = $p.signature; parent = $p.parentName; service = $(if (@($p.services).Count) { (@($p.services) -join ', ') } else { $null }) }
            whatIsIt = (Get-ProcessDescription $p)
            whyFlagged = @($why)
            persistence = [pscustomobject]@{ persistent = [bool]$p.persistent; mechanisms = @($mech) }
            suggestedAction = $action
            stopCommand = (Get-StopCommand $p)
            preventRestart = (Get-PreventRestartCommand $p)
            consequences = $consequence
            ai = $null
        }
        $p.recommendationId = $rec.id
        foreach ($i in $items) { $i.recommendationId = $rec.id }
        [void]$recs.Add($rec)
    }
    return @($recs)
}

# ---------- Persistent store ----------
function Get-RecommendationStore {
    $raw = Read-JsonFile -Path (Get-GuardianPath 'Recommendations') -Default $null
    if ($raw -and (Get-PropNames $raw) -contains 'items') { return @($raw.items) }
    return @()
}

function Save-RecommendationStore {
    param($Items)
    Write-JsonFile -Path (Get-GuardianPath 'Recommendations') -Object ([ordered]@{ updatedAt = Get-IsoNow; items = @($Items) })
}

function Update-RecommendationStore {
    <# Merge fresh recs into the store. Preserves user status, tracks recurrence, auto-resolves recs not seen for >3 days. Returns merged current items. #>
    param($Fresh, [string[]]$SweepKinds = @('process'))
    $store = @(Get-RecommendationStore)
    $today = (Get-Date).Date
    $byId = @{}; foreach ($s in $store) { $byId[$s.id] = $s }
    $seen = @{}
    foreach ($f in $Fresh) {
        $seen[$f.id] = $true
        if ($byId.ContainsKey($f.id)) {
            $e = $byId[$f.id]
            $last = $null; try { $last = ([datetime]$e.lastSeen).Date } catch { }
            $occ = [int]$e.occurrences; $cd = [int]$e.consecutiveDays
            if ($last -and $last -lt $today) {
                $occ++
                if ($last -eq $today.AddDays(-1)) { $cd++ } else { $cd = 1 }
            }
            $keep = [ordered]@{}
            foreach ($pn in (Get-PropNames $f)) { $keep[$pn] = $f.$pn }
            $keep.firstSeen = $e.firstSeen; $keep.occurrences = $occ; $keep.consecutiveDays = $cd; $keep.lastSeen = Get-IsoNow
            # keep user decision unless it was auto-resolved
            $keep.status = if ($e.status -eq 'resolved') { 'open' } else { $e.status }
            # preserve earlier AI analysis unless fresh has one
            if ($null -eq $f.ai -and (Get-PropNames $e) -contains 'ai') { $keep.ai = $e.ai }
            $byId[$f.id] = [pscustomobject]$keep
        } else { $byId[$f.id] = $f }
    }
    foreach ($id in @($byId.Keys)) {
        $e = $byId[$id]
        if ($seen.ContainsKey($id)) { continue }
        if ($e.kind -notin $SweepKinds) { continue }
        $last = $null; try { $last = [datetime]$e.lastSeen } catch { }
        if ($e.status -eq 'open' -and $last -and (($today - $last.Date).TotalDays -gt 3)) { $e.status = 'resolved' }
    }
    $all = @($byId.Values | Sort-Object { $_.lastSeen } -Descending)
    Save-RecommendationStore $all
    return @($all)
}

function Add-RecommendationItem {
    # Helper for non-process recommendations (system/storage/security/startup/service)
    param([string]$Kind, [string]$Key, [string]$Title, [string]$Risk = 'LOW', [string]$Severity = 'low', [double]$Confidence = 0.7, [string]$WhatIsIt, [string[]]$Why, [string]$Action = 'Review', $Consequences = 'No change is made automatically.', $StopCommand = $null)
    return [pscustomobject][ordered]@{
        id = New-RecId $Kind $Key ''; kind = $Kind; title = $Title; status = 'open'; risk = $Risk; severity = $Severity; confidence = $Confidence; source = 'deterministic'
        firstSeen = Get-IsoNow; lastSeen = Get-IsoNow; occurrences = 1; consecutiveDays = 1
        target = $null; identity = $null; whatIsIt = $WhatIsIt; whyFlagged = @($Why)
        persistence = [pscustomobject]@{ persistent = $false; mechanisms = @() }
        suggestedAction = $Action; stopCommand = $StopCommand; preventRestart = $null; consequences = $Consequences; ai = $null
    }
}

Export-ModuleMember -Function *
