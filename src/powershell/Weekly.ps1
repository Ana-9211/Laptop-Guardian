#requires -Version 5.1
<#
.SYNOPSIS  Laptop Guardian weekly deep analysis (Saturday 02:00), ends with a controlled Windows shutdown.
.PARAMETER NoShutdown  Never initiate shutdown (also used by dashboard "run now").
.PARAMETER Scheduled   Passed only by the Task Scheduler action. Without it (manual / dashboard runs) shutdown is never initiated.
.PARAMETER Fast        Short timeouts; skips SFC/DISM/full Defender scan (tests / smoke runs).
.PARAMETER NoAI        Skip Gemini.
#>
[CmdletBinding()]
param([switch]$NoShutdown, [switch]$Scheduled, [switch]$Fast, [switch]$NoAI, [switch]$SkipDefenderScan)

. "$PSScriptRoot\Common\Load.ps1"
Initialize-GuardianDirectories
Start-RunContext -RunType 'weekly'
$started = Get-Date
$runMode = if ($Scheduled) { 'scheduled' } else { 'manual' }
$config = Get-GuardianConfig
$exit = 0
$phases = New-Object System.Collections.ArrayList

if (-not (Enter-GuardianLock -Name 'weekly')) { Write-Host 'Another weekly run is active; exiting.'; exit 0 }
$prevRun = (Get-RunState).running
if ($prevRun -and $prevRun.type -eq 'weekly') { [void](Write-GuardianEvent -Category scan -Action 'run:previous-interrupted' -Severity warning -Result failure -Reason "Previous $($prevRun.type) run (phase '$($prevRun.phase)', started $($prevRun.startedAt)) never finished: machine shutdown, crash or kill. Recovering.") }

# Time budget: everything must finish before shutdownTime minus a reserve for reporting.
$deadline = $started.AddHours(3)
try { $sd = Get-ShutdownDateTime -TimeOfDay $config.schedule.weekly.shutdownTime -StartTime $config.schedule.weekly.time; if ($sd -gt $started.AddMinutes(20)) { $deadline = $sd } } catch { }
$reportReserveMin = 12
function Get-RemainingSec { [int][math]::Max(0, ($deadline.AddMinutes(-$reportReserveMin) - (Get-Date)).TotalSeconds) }

function Invoke-Phase {
    param([string]$Name, [scriptblock]$Body)
    $p = [ordered]@{ name = $Name; status = 'complete'; startedAt = (Get-IsoNow); finishedAt = $null; detail = '' }
    [void](Write-GuardianEvent -Category scan -Action "weekly:phase-started:$Name" -Result started)
    try { $d = & $Body; if ($d -is [string]) { $p.detail = $d } ; if ($d -is [hashtable] -and $d.status) { $p.status = $d.status; $p.detail = [string]$d.detail } }
    catch { $p.status = 'failed'; $p.detail = $_.Exception.Message; [void](Write-GuardianEvent -Category scan -Action "weekly:phase-failed:$Name" -Result failure -Severity error -ErrorDetails $_.Exception.Message) }
    $p.finishedAt = Get-IsoNow
    [void]$phases.Add([pscustomobject]$p)
    [void](Write-GuardianEvent -Category scan -Action "weekly:phase-finished:$Name" -Result $(if ($p.status -eq 'complete') { 'success' } elseif ($p.status -eq 'timeout') { 'timeout' } elseif ($p.status -in 'skipped', 'incomplete') { 'skipped' } else { 'failure' }) -Severity $(if ($p.status -in 'incomplete', 'timeout') { 'warning' } else { 'info' }) -Reason $p.detail)
}

$ctx = $null; $fileData = $null; $onBattery = $false; $incomplete = New-Object System.Collections.ArrayList; $briefing = $null; $patterns = @()
try {
    Set-RunState -Key 'running' -Value ([pscustomobject]@{ type = 'weekly'; mode = $runMode; shutdownPossible = (-not $NoShutdown -and $Scheduled.IsPresent); pid = $PID; phase = 'preflight'; startedAt = (Get-IsoNow) })
    [void](Write-GuardianEvent -Category scan -Action 'weekly:started' -Result started -Reason "deadline=$($deadline.ToString('HH:mm')) safeMode=$($config.safety.safeMode) admin=$(Test-IsAdmin)")

    # ---------- Phase 1: preflight ----------
    Invoke-Phase 'preflight' {
        $notes = New-Object System.Collections.ArrayList
        $ac = Test-OnAcPower
        if (-not $ac) { $script:onBattery = $true; [void]$notes.Add('On battery: heavy scans (full Defender, SFC, DISM) will be skipped') }
        $free = (Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':')) -ErrorAction SilentlyContinue).Free
        if ($null -ne $free -and $free -lt 2GB) { $script:lowDisk = $true; [void]$notes.Add('Less than 2 GB free: duplicate hashing skipped') }
        $prev = (Get-RunState).lastWeekly
        if ($prev -and $prev.status -in 'failed', 'incomplete') { [void]$notes.Add("Previous weekly run ended '$($prev.status)'") }
        $probe = Join-Path (Get-GuardianPath 'Reports') '.write-test'
        [System.IO.File]::WriteAllText($probe, 'ok'); Remove-Item $probe -Force
        if ($config.ai.enabled -and -not (Test-GeminiKeyConfigured)) { [void]$notes.Add('AI enabled but no Gemini key configured: AI analysis will be skipped') }
        return ($notes -join '; ')
    }

    # ---------- Phase 2: deep analysis ----------
    Set-RunState -Key 'running' -Value ([pscustomobject]@{ type = 'weekly'; mode = $runMode; shutdownPossible = (-not $NoShutdown -and $Scheduled.IsPresent); pid = $PID; phase = 'analysis'; startedAt = $started.ToString('yyyy-MM-ddTHH:mm:sszzz') })
    $heavyOk = (-not $onBattery) -and (-not $Fast)
    Invoke-Phase 'system-collection' {
        $script:ctx = Invoke-Collection -Config $config -Type weekly -SkipDefenderScan -NoAI -Fast:$Fast -SkipNetwork:$false
        return "$($script:ctx.Processes.Count) processes analysed"
    }
    if (-not $ctx) { throw 'Core collection failed; cannot build report' }

    Invoke-Phase 'defender-deep-scan' {
        if ($SkipDefenderScan -or $Fast) { return @{ status = 'skipped'; detail = 'Skipped (fast/skip switch)' } }
        if (-not $heavyOk) { return @{ status = 'skipped'; detail = 'Skipped on battery' } }
        $rem = Get-RemainingSec
        if ($rem -lt 900) { return @{ status = 'skipped'; detail = 'Not enough time budget' } }
        [void](Invoke-Safely 'defender-update' { Update-DefenderSignatures } $null)
        $scan = Invoke-DefenderScan -Type FullScan -TimeoutSec ([math]::Min(5400, [int]($rem * 0.5)))
        $script:ctx.Sections.defender = (Get-DefenderStatus)
        $script:ctx.Sections.defender.scan = [pscustomobject]@{ ran = [bool]$scan.ran; result = $scan.result; durationSec = $scan.durationSec; threats = @($script:ctx.Sections.defender.scan.threats) }
        if ($scan.result -ne 'completed') { [void]$script:incomplete.Add("Defender full scan: $($scan.result)"); return @{ status = $(if ($scan.result -eq 'timeout') { 'timeout' } else { 'incomplete' }); detail = $scan.result } }
        return "Full scan completed in $($scan.durationSec)s"
    }

    Invoke-Phase 'windows-integrity' {
        if (-not $heavyOk) { return @{ status = 'skipped'; detail = 'Skipped (battery or fast mode)' } }
        if (-not (Test-IsAdmin)) { [void]$script:incomplete.Add('SFC/DISM need Administrator'); return @{ status = 'skipped'; detail = 'Requires Administrator; task must run with highest privileges' } }
        $wh = $script:ctx.Sections.windowsHealth
        $rem = Get-RemainingSec
        if ($rem -gt 600) { $wh.sfc = Invoke-Safely 'sfc' { Invoke-SfcVerify -TimeoutSec ([math]::Min(1800, [int]($rem * 0.4))) } $wh.sfc; if ($wh.sfc.result -eq 'timeout') { [void]$script:incomplete.Add('SFC timed out') } }
        $rem = Get-RemainingSec
        if ($rem -gt 600) { $wh.dism = Invoke-Safely 'dism' { Invoke-DismCheck -Mode ScanHealth -TimeoutSec ([math]::Min(1500, [int]($rem * 0.4))) } $wh.dism; if ($wh.dism.result -eq 'timeout') { [void]$script:incomplete.Add('DISM ScanHealth timed out') } }
        $rem = Get-RemainingSec
        if ($rem -gt 300) { $wh.componentStore = Invoke-Safely 'component-store' { Get-ComponentStoreInfo } $wh.componentStore }
        return "SFC=$($wh.sfc.result) DISM=$($wh.dism.result)"
    }

    Invoke-Phase 'disk-and-filesystem' {
        $diskHealth = @(); $fsHealth = @()
        try { foreach ($pd in Get-PhysicalDisk -ErrorAction Stop) { $rel = $null; try { $rel = $pd | Get-StorageReliabilityCounter -ErrorAction Stop } catch { }
                $diskHealth += [pscustomobject]@{ name = $pd.FriendlyName; media = [string]$pd.MediaType; bus = [string]$pd.BusType; health = [string]$pd.HealthStatus; operational = [string]$pd.OperationalStatus; sizeGB = [math]::Round($pd.Size / 1GB, 0); wearPct = $(if ($rel) { $rel.Wear } else { $null }); temperatureC = $(if ($rel) { $rel.Temperature } else { $null }); powerOnHours = $(if ($rel) { $rel.PowerOnHours } else { $null }) } } } catch { Add-RunError 'disk-health' $_.Exception.Message }
        if ((Test-IsAdmin) -and -not $Fast -and (Get-RemainingSec) -gt 900) {
            foreach ($v in @(Get-Volume -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Fixed' -and $_.FileSystem -eq 'NTFS' })) {
                try { $res = Repair-Volume -DriveLetter $v.DriveLetter -Scan -ErrorAction Stop; $fsHealth += [pscustomobject]@{ drive = "$($v.DriveLetter):"; result = [string]$res } }   # read-only online scan; never -OfflineScanAndFix
                catch { $fsHealth += [pscustomobject]@{ drive = "$($v.DriveLetter):"; result = "error: $($_.Exception.Message)" } }
            }
        } else { [void]$script:incomplete.Add('Filesystem scan (Repair-Volume -Scan) skipped: needs Administrator/time') }
        $script:ctx.Sections | Add-Member -NotePropertyName diskHealth -NotePropertyValue $diskHealth -Force
        $script:ctx.Sections | Add-Member -NotePropertyName fileSystem -NotePropertyValue $fsHealth -Force
        foreach ($d in $script:ctx.Sections.system.disks) { $m = $diskHealth | Where-Object { $_.media -in 'SSD', 'HDD' } | Select-Object -First 1 }
        return "$($diskHealth.Count) physical disk(s); types: $((@($script:ctx.Sections.system.disks | ForEach-Object { "$($_.drive)=$($_.type)" })) -join ', ')"
    }

    Invoke-Phase 'scheduled-tasks' {
        $tasks = @(Invoke-Safely 'tasks' { Get-ScheduledTaskEntries } @())
        $script:ctx.Sections | Add-Member -NotePropertyName scheduledTasks -NotePropertyValue @($tasks | Select-Object -First 100 | ForEach-Object { [pscustomobject]@{ name = $_.name; path = $_.path; state = $_.state; execute = $_.execute; triggers = $_.triggers; atLogonOrBoot = $_.atLogonOrBoot } }) -Force
        return "$($tasks.Count) non-Microsoft task actions"
    }

    Invoke-Phase 'storage-analysis' {
        if ((Get-RemainingSec) -lt 300) { return @{ status = 'skipped'; detail = 'Not enough time budget' } }
        $budget = if ($Fast) { 20 } else { [math]::Min(2400, [int]((Get-RemainingSec) * 0.5)) }
        if ($script:lowDisk) { $config.storage.duplicateScan = $false }
        $script:fileData = Invoke-FileAnalysis -Config $config -DeadlineSec $budget
        # Apply user-ignored files
        $ig = Read-JsonFile -Path (Join-Path (Get-GuardianPath 'Root') 'data\state\ignored-files.json') -Default $null
        $igIds = if ($ig -is [array]) { @($ig) } elseif ($ig -and $ig.PSObject.Properties['ids']) { @($ig.ids) } else { @() }
        if ($igIds.Count) { $set = @{}; foreach ($i in $igIds) { $set[[string]$i] = $true }; foreach ($c in $script:fileData.candidates) { if ($set.ContainsKey($c.id)) { $c.ignored = $true } } }
        Write-JsonFile -Path (Get-GuardianPath 'LatestFiles') -Object $script:fileData -Depth 8
        $script:ctx.Sections.files = [pscustomobject]@{ candidateCount = @($script:fileData.candidates).Count; reclaimableGB = $script:fileData.reclaimableGB }
        $script:ctx.Sections.storage.duplicateCandidates = @($script:fileData.duplicates).Count
        if ($script:fileData.truncated) { [void]$script:incomplete.Add('Storage scan truncated by time/entry limit'); return @{ status = 'incomplete'; detail = "$(@($script:fileData.candidates).Count) candidates (scan truncated)" } }
        return "$(@($script:fileData.candidates).Count) candidates, $($script:fileData.scannedFiles) files scanned"
    }

    # file-summary recommendation
    if ($fileData -and @($fileData.candidates | Where-Object { $_.classification -eq 'LIKELY_UNNECESSARY' -and -not $_.ignored }).Count -gt 0) {
        $n = @($fileData.candidates | Where-Object { $_.classification -eq 'LIKELY_UNNECESSARY' -and -not $_.ignored }).Count
        $rec = Add-RecommendationItem -Kind 'storage' -Key 'weekly-file-candidates' -Title "$n file(s) worth reviewing (about $($fileData.reclaimableGB) GB)" -Risk 'LOW' -Severity 'low' -Confidence 0.75 -WhatIsIt 'Installers, crash dumps, temporary data and duplicates found by the weekly storage scan.' -Why @("Weekly scan classified $n file(s) as LIKELY_UNNECESSARY") -Action 'Review' -Consequences 'Open Files & Storage. Files go to the Recycle Bin only when you choose; Guardian never deletes personal files automatically.'
        $ctx.Recs = @(Update-RecommendationStore -Fresh @($rec) -SweepKinds @())   # merge only, no sweep
    }

    # ---------- Phase 3: AI ----------
    Set-RunState -Key 'running' -Value ([pscustomobject]@{ type = 'weekly'; mode = $runMode; shutdownPossible = (-not $NoShutdown -and $Scheduled.IsPresent); pid = $PID; phase = 'ai'; startedAt = $started.ToString('yyyy-MM-ddTHH:mm:sszzz') })
    $recurring = @()
    Invoke-Phase 'ai-analysis' {
        $script:patterns = @(Get-RecurringPatterns -Days 7 -Recommendations $script:ctx.Recs)
        $script:recurring = @($script:patterns | ForEach-Object { [pscustomobject]@{ title = $_.title; days = 7; detail = $_.detail } })
        if ($NoAI -or -not $config.ai.enabled) { return @{ status = 'skipped'; detail = 'AI disabled; deterministic patterns only' } }
        if ((Get-RemainingSec) -lt 300) { return @{ status = 'skipped'; detail = 'Not enough time budget' } }
        $m = @(Get-Metrics -Last 60 | Where-Object { $_.runType -eq 'daily' -and ([datetime]$_.ts) -gt (Get-Date).AddDays(-7) })
        $facts = [ordered]@{
            window = 'last 7 days'; daily_samples = $m.Count
            metrics = @($m | ForEach-Object { [ordered]@{ date = $_.ts.Substring(0, 10); cpuPct = $_.cpuPct; ramPct = $_.ramPct; diskFreeGB = $_.diskFreeGB; flagged = $_.flaggedCount; errors = $_.errorCount; serviceFailures = $_.serviceFailures; defenderThreats = $_.defenderThreats; startupCount = $_.startupCount; healthScore = $_.healthScore } })
            local_patterns = @($script:patterns | ForEach-Object { [ordered]@{ title = $_.title; detail = $_.detail } })
            open_recommendations = @($script:ctx.Recs | Where-Object { $_.status -eq 'open' } | Select-Object -First 15 | ForEach-Object { [ordered]@{ title = ($_.title -replace [regex]::Escape($env:USERNAME), '<user>'); risk = $_.risk; consecutiveDays = $_.consecutiveDays; occurrences = $_.occurrences } })
            security = [ordered]@{ defenderEnabled = $script:ctx.Sections.defender.enabled; sigAgeDays = $script:ctx.Sections.defender.sigAgeDays; threats = $script:ctx.Sections.defender.threats }
            windows = [ordered]@{ eventErrorsSystem = $script:ctx.Sections.windowsHealth.eventErrors.system; eventErrorsApplication = $script:ctx.Sections.windowsHealth.eventErrors.application; sfc = $script:ctx.Sections.windowsHealth.sfc.result; dism = $script:ctx.Sections.windowsHealth.dism.result }
        }
        $script:aiBrief = Invoke-AiWeeklyBriefing -Facts $facts -Config $config
        # Per-process AI enrichment for this week's top process recommendations
        $script:ctx.AiStat = Invoke-Safely 'ai-enrichment' { Invoke-AiRecommendationEnrichment -Recommendations $script:ctx.Recs -Processes $script:ctx.Processes -Config $config } $null
        if ($script:ctx.AiStat -and $script:ctx.AiStat.used) { Save-RecommendationStore $script:ctx.Recs }
        if (-not $script:aiBrief.used) { return @{ status = 'incomplete'; detail = 'AI unavailable or response rejected; report generated without AI briefing' } }
        return "AI briefing generated ($($script:aiBrief.requests) request(s))"
    }

    # ---------- Phase 4: report ----------
    Set-RunState -Key 'running' -Value ([pscustomobject]@{ type = 'weekly'; mode = $runMode; shutdownPossible = (-not $NoShutdown -and $Scheduled.IsPresent); pid = $PID; phase = 'report'; startedAt = $started.ToString('yyyy-MM-ddTHH:mm:sszzz') })
    $id = Get-IsoWeekId
    $report = $null
    Invoke-Phase 'report' {
        $events = Get-RunEvents; $errors = Get-RunErrors
        $ctx.Incomplete = @($incomplete)
        $st = if (@($incomplete).Count -or @($phases | Where-Object { $_.status -in 'failed', 'timeout', 'incomplete' }).Count) { 'partial' } else { 'complete' }
        $rp = New-RunReport -Config $config -Ctx $ctx -Type 'weekly' -Id $id -Started $started -Events $events -Errors $errors -Status $st
        $m7 = @(Get-Metrics -Last 60 | Where-Object { ([datetime]$_.ts) -gt (Get-Date).AddDays(-7) })
        $aiObj = if ($aiBrief) { $aiBrief } else { $null }
        $allPatterns = @($patterns) + @($(if ($aiObj) { $aiObj.patterns | ForEach-Object { $_ | Add-Member -NotePropertyName source -NotePropertyValue 'ai' -PassThru -Force } }))
        $rp.ai = [pscustomobject]@{ enabled = [bool]$config.ai.enabled; used = $(if ($aiObj) { [bool]$aiObj.used } else { $false }); requests = $(if ($aiObj) { $aiObj.requests } else { 0 }); failures = $(if ($aiObj) { $aiObj.failures } else { 0 }); briefing = $(if ($aiObj) { $aiObj.briefing } else { $null }); patterns = $allPatterns; recommendations = $(if ($aiObj) { @($aiObj.recommendations) } else { @() }) }
        $unresolved = @($ctx.Recs | Where-Object { $_.status -eq 'open' -and [int]$_.consecutiveDays -ge 3 } | ForEach-Object { $_.id })
        $rp | Add-Member -NotePropertyName weekly -NotePropertyValue ([pscustomobject]@{ phases = @($phases); trends = [pscustomobject]@{ days = @($m7 | ForEach-Object { [pscustomobject]@{ ts = $_.ts; healthScore = $_.healthScore; cpuPct = $_.cpuPct; ramPct = $_.ramPct; diskFreeGB = $_.diskFreeGB; flagged = $_.flaggedCount } }) }; recurring = @($recurring); unresolved = $unresolved; shutdown = [pscustomobject]@{ planned = $null; initiated = $false; reason = 'pending' } }) -Force
        $script:report = $rp
        $open = @($ctx.Recs | Where-Object { $_.status -eq 'open' })
        $fc = if ($fileData) { @($fileData.candidates | Where-Object { -not $_.ignored }) } else { @() }
        [void](Save-Report -Report $rp -Recommendations $open -FileCandidates $fc)
        Write-RunMetric -Report $rp -Ctx $ctx -Events $events -Errors $errors
        return "Report $id written"
    }
    if (-not $report) { throw 'Report generation failed' }
}
catch {
    $exit = 1
    [void](Write-GuardianEvent -Category scan -Action 'weekly:failed' -Result failure -Severity error -ErrorDetails $_.Exception.Message)
    [void]$incomplete.Add("Run aborted: $($_.Exception.Message)")
}

# ---------- Phase 5: shutdown preparation ----------
$sdResult = [pscustomobject]@{ planned = $null; initiated = $false; reason = 'not evaluated'; delaySec = 0 }
try {
    Set-RunState -Key 'running' -Value ([pscustomobject]@{ type = 'weekly'; mode = $runMode; shutdownPossible = (-not $NoShutdown -and $Scheduled.IsPresent); pid = $PID; phase = 'shutdown-prep'; startedAt = $started.ToString('yyyy-MM-ddTHH:mm:sszzz') })
    $finalStatus = if ($exit -ne 0) { 'failed' } elseif (@($incomplete).Count -or @($phases | Where-Object { $_.status -in 'failed', 'timeout', 'incomplete' }).Count) { 'incomplete' } else { 'complete' }
    $id = Get-IsoWeekId
    [void](Write-GuardianEvent -Category scan -Action 'weekly:finished' -Result $(if ($exit -eq 0) { 'success' } else { 'failure' }) -Reason "status=$finalStatus; unfinished: $(@($incomplete) -join '; ')")
    # Verify reports on disk BEFORE shutting down
    $dir = Join-Path (Get-GuardianPath 'Reports') "weekly\$id"
    $verified = (Test-Path -LiteralPath (Join-Path $dir 'report.json')) -and (Test-Path -LiteralPath (Join-Path $dir 'report.html'))
    if ($verified) { try { $rj = Read-JsonFile -Path (Join-Path $dir 'report.json'); if (-not $rj -or ([datetime]$rj.generatedAt) -lt $started.AddSeconds(-5) -or $rj.status -eq 'failed') { $verified = $false } } catch { $verified = $false } }
    if (-not $verified) { [void](Write-GuardianEvent -Category shutdown -Action 'shutdown:verify-reports' -Result failure -Severity error -Reason 'Weekly report files missing; shutdown withheld') }
    Set-RunState -Key 'lastWeekly' -Value ([pscustomobject]@{ startedAt = $started.ToString('yyyy-MM-ddTHH:mm:sszzz'); finishedAt = (Get-IsoNow); status = $finalStatus; reportId = $id; unfinished = @($incomplete) })
    Set-RunState -Key 'running' -Value $null
    if ($verified) { $sdResult = Start-GuardianShutdown -Config $config -NoShutdown:($NoShutdown -or -not $Scheduled) } else { $sdResult.reason = 'Report verification failed' }
    # Record the shutdown decision in the already-written report
    if ($verified -and $report) {
        $report.weekly.shutdown = [pscustomobject]@{ planned = $sdResult.planned; initiated = [bool]$sdResult.initiated; reason = $sdResult.reason }
        $fc = if ($fileData) { @($fileData.candidates | Where-Object { -not $_.ignored }) } else { @() }
        [void](Save-Report -Report $report -Recommendations @($ctx.Recs | Where-Object { $_.status -eq 'open' }) -FileCandidates $fc)
    }
    Write-Host "Weekly run $finalStatus. Shutdown: $($sdResult.reason)"
} catch { [void](Write-GuardianEvent -Category shutdown -Action 'shutdown:prep-failed' -Result failure -Severity error -ErrorDetails $_.Exception.Message) }
finally { Exit-GuardianLock -Name 'weekly' }
exit $exit
