#requires -Version 5.1
# Pipeline: shared orchestration of collectors into a Report. Every collector is isolated by Invoke-Safely so one failure never aborts a run.
Set-StrictMode -Version 2.0

function Get-HostInfo {
    $os = $null; try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } catch { }
    [pscustomobject]@{ name = $env:COMPUTERNAME; user = $env:USERNAME; os = $(if ($os) { $os.Caption } else { 'Windows' }); build = $(if ($os) { $os.BuildNumber } else { '' }) }
}

function New-CmdObject { param([string]$Command, [string]$Explains, [string]$Risk = 'MEDIUM', [bool]$Admin = $true, [bool]$Reversible = $false)
    [pscustomobject][ordered]@{ command = $Command; explains = $Explains; risk = $Risk; requiresAdmin = $Admin; reversible = $Reversible } }

function New-SystemRecommendations {
    param($Sections, $Config)
    $recs = New-Object System.Collections.ArrayList
    $s = $Sections
    foreach ($d in @($s.system.disks)) {
        if ($d.freePct -lt $Config.thresholds.diskFreeWarnPct) {
            $crit = $d.freePct -lt $Config.thresholds.diskFreeCritPct
            [void]$recs.Add((Add-RecommendationItem -Kind 'storage' -Key "disk-low-$($d.drive)" -Title "Disk $($d.drive) is low on space ($($d.freeGB) GB free, $($d.freePct)%)" -Risk $(if ($crit) { 'HIGH' } else { 'MEDIUM' }) -Severity $(if ($crit) { 'high' } else { 'medium' }) -Confidence 0.95 `
                        -WhatIsIt 'The drive is filling up. Windows needs free space for updates, paging and temporary files.' -Why @("Only $($d.freePct)% free (warn below $($Config.thresholds.diskFreeWarnPct)%).") -Action 'Review' -Consequences 'Review the Files & Storage page for large or duplicate files. Nothing is deleted automatically.'))
        }
        if ($d.health -and $d.health -ne 'Healthy') {
            [void]$recs.Add((Add-RecommendationItem -Kind 'system' -Key "disk-health-$($d.drive)" -Title "Disk $($d.drive) reports health: $($d.health)" -Risk 'HIGH' -Severity 'critical' -Confidence 0.8 -WhatIsIt 'The storage device reports a non-healthy status via Windows storage management.' -Why @("HealthStatus = $($d.health)") -Action 'Investigate further' -Consequences 'Back up important data now, then check the drive vendor diagnostic tool.'))
        }
    }
    $def = $s.defender
    if ($def) {
        if ($def.available -and $def.realTimeProtection -eq $false) { [void]$recs.Add((Add-RecommendationItem -Kind 'security' -Key 'defender-rtp-off' -Title 'Defender real-time protection is off' -Risk 'HIGH' -Severity 'high' -Confidence 0.9 -WhatIsIt 'Microsoft Defender is not actively scanning files as they are used.' -Why @('RealTimeProtectionEnabled = False') -Action 'Review' -Consequences 'Turn it on in Windows Security > Virus & threat protection. Guardian never changes this itself. (A third-party antivirus may legitimately replace Defender.)')) }
        if ($def.available -and $null -ne $def.sigAgeDays -and $def.sigAgeDays -gt 7) { [void]$recs.Add((Add-RecommendationItem -Kind 'security' -Key 'defender-sigs-old' -Title "Defender signatures are $([math]::Round($def.sigAgeDays)) days old" -Risk 'MEDIUM' -Severity 'medium' -Confidence 0.9 -WhatIsIt 'Antivirus definitions are out of date.' -Why @("Signature age $($def.sigAgeDays) days") -Action 'Review' -Consequences 'Run Windows Update or Windows Security > Check for updates.')) }
        if ($def.threats -gt 0) { [void]$recs.Add((Add-RecommendationItem -Kind 'security' -Key 'defender-threats' -Title "Defender reported $($def.threats) threat detection(s) in the last 30 days" -Risk 'HIGH' -Severity 'high' -Confidence 0.85 -WhatIsIt 'Defender logged detections. They may already be quarantined.' -Why @("$($def.threats) detection(s)") -Action 'Investigate further' -Consequences 'Open Windows Security > Protection history and review each item.')) }
    }
    foreach ($p in @($s.firewall.problems)) { if ($p -match 'disabled') { [void]$recs.Add((Add-RecommendationItem -Kind 'security' -Key "fw-$p" -Title $p -Risk 'HIGH' -Severity 'high' -Confidence 0.9 -WhatIsIt 'Windows Firewall profile is off.' -Why @($p) -Action 'Review' -Consequences 'Re-enable in Windows Security > Firewall. Guardian never changes firewall rules by itself.')) } }
    $wh = $s.windowsHealth
    if ($wh) {
        if ($wh.pendingReboot) { [void]$recs.Add((Add-RecommendationItem -Kind 'system' -Key 'pending-reboot' -Title 'A restart is pending' -Risk 'LOW' -Severity 'low' -Confidence 0.9 -WhatIsIt 'Windows has changes that only complete after a reboot.' -Why @('Pending-reboot registry marker present') -Action 'Review' -Consequences 'Restart when convenient.')) }
        if ($wh.sfc.result -eq 'violations-unrepaired') { [void]$recs.Add((Add-RecommendationItem -Kind 'system' -Key 'sfc-violations' -Title 'System File Checker found integrity violations' -Risk 'HIGH' -Severity 'high' -Confidence 0.85 -WhatIsIt 'Some protected Windows files differ from the trusted copy.' -Why @('sfc /verifyonly reported violations') -Action 'Investigate further' -Consequences 'Repair is available but changes system files; Guardian only shows the command.' -StopCommand (New-CmdObject 'sfc /scannow' 'Scans and repairs protected system files. Run from an elevated prompt; can take 10-30 minutes.' 'MEDIUM' $true $false))) }
        if ($wh.dism.result -in 'repairable') { [void]$recs.Add((Add-RecommendationItem -Kind 'system' -Key 'dism-repairable' -Title 'Windows component store is repairable' -Risk 'MEDIUM' -Severity 'medium' -Confidence 0.85 -WhatIsIt 'DISM found component-store corruption that can be repaired.' -Why @('DISM reported repairable corruption') -Action 'Investigate further' -Consequences 'Repair downloads files from Windows Update.' -StopCommand (New-CmdObject 'DISM /Online /Cleanup-Image /RestoreHealth' 'Repairs the component store using Windows Update. Run elevated; can take a long time.' 'MEDIUM' $true $false))) }
    }
    if ($s.startup.count -gt 15) { [void]$recs.Add((Add-RecommendationItem -Kind 'startup' -Key 'startup-many' -Title "$($s.startup.count) programs start with Windows" -Risk 'LOW' -Severity 'low' -Confidence 0.7 -WhatIsIt 'Many startup entries slow sign-in and consume memory.' -Why @("$($s.startup.count) startup entries (registry + startup folders)") -Action 'Review' -Consequences 'Disable the ones you do not need in Settings > Apps > Startup. Fully reversible.' -StopCommand (New-CmdObject 'Start-Process ms-settings:startupapps' 'Opens the Startup apps settings page.' 'LOW' $false $true))) }
    foreach ($f in @($s.services.failed | Select-Object -First 5)) { [void]$recs.Add((Add-RecommendationItem -Kind 'service' -Key "svc-failed-$f" -Title "Service '$f' reported a failure" -Risk 'MEDIUM' -Severity 'medium' -Confidence 0.7 -WhatIsIt 'The Service Control Manager logged a failure for this service.' -Why @('System event log: Service Control Manager failure event') -Action 'Investigate further' -Consequences 'Check Event Viewer > System for details.')) }
    if ($s.network -and $s.network.internet -eq $false) { [void]$recs.Add((Add-RecommendationItem -Kind 'system' -Key 'net-offline' -Title 'No internet connectivity detected' -Risk 'LOW' -Severity 'low' -Confidence 0.6 -WhatIsIt 'The connectivity probe failed. You may be offline, or ICMP may be blocked on this network.' -Why @("gateway ok: $($s.network.gatewayOk), DNS ok: $($s.network.dnsOk)") -Action 'Review')) }
    if (($s.storage.tempMB + $s.storage.crashDumpMB + $s.storage.cacheMB) -gt 1500) { [void]$recs.Add((Add-RecommendationItem -Kind 'storage' -Key 'cleanable-temp' -Title ("{0:N1} GB of temporary data can be cleaned" -f (($s.storage.tempMB + $s.storage.crashDumpMB + $s.storage.cacheMB) / 1024)) -Risk 'LOW' -Severity 'low' -Confidence 0.8 -WhatIsIt 'Temp files, crash dumps and regenerable caches in known safe locations.' -Why @("temp $($s.storage.tempMB) MB, crash dumps $($s.storage.crashDumpMB) MB, caches $($s.storage.cacheMB) MB") -Action 'Review' -Consequences 'Turn off Safe Mode in Settings to let Guardian clean these automatically (only files older than the configured age).')) }
    return @($recs)
}

function Invoke-Collection {
    <# Runs all collectors for a given run profile. Returns the context used to build the report. #>
    param($Config, [ValidateSet('daily', 'weekly')][string]$Type = 'daily', [switch]$SkipDefenderScan, [switch]$SkipNetwork, [switch]$NoAI, [switch]$Fast, [int]$DefenderTimeoutSec = 600)
    $incomplete = New-Object System.Collections.ArrayList
    $ctx = [ordered]@{ Type = $Type; Sections = $null; Processes = @(); Recs = @(); Incomplete = $incomplete; AiStat = $null }
    $days = if ($Type -eq 'weekly') { 7 } else { 1 }

    $persist = [pscustomobject]@{
        Services = @(Invoke-Safely 'services' { Get-ServiceEntries } @())
        Tasks = @(Invoke-Safely 'scheduled-tasks' { Get-ScheduledTaskEntries } @())
        Startup = @(Invoke-Safely 'startup' { Get-StartupEntries } @())
    }
    $sample = if ($Fast) { 500 } else { 1500 }
    $procs = @(Invoke-Safely 'processes' { Get-ProcessSnapshot -SampleMs $sample -Persistence $persist } @())
    $policy = Get-ProcessPolicy
    $procs = @(Add-ProcessFlags -Processes $procs -Config $Config -Policy $policy)
    [void](Write-GuardianEvent -Category process -Action 'process:snapshot' -Target "$($procs.Count) processes" -Result success)

    $enforce = @(Invoke-Safely 'blacklist' { Invoke-BlacklistEnforcement -Processes $procs -Config $Config } @())
    $fresh = New-Object System.Collections.ArrayList
    foreach ($r in @(Invoke-Safely 'process-recommendations' { New-ProcessRecommendations -Processes $procs -Config $Config } @())) {
        [void]$fresh.Add($r); [void](Write-GuardianEvent -Category process -Action 'process:recommended' -Target $r.target.name -Result success -Related $r.id -Reason ($r.whyFlagged -join ' | '))
    }

    $system = Invoke-Safely 'system' { Get-SystemHealth } $null
    if (-not $system) { $system = [pscustomobject]@{ os = 'unknown'; build = ''; uptimeHours = 0; bootTime = $null; cpu = [pscustomobject]@{ name = ''; cores = 0; logical = 0; usagePct = $null }; ram = [pscustomobject]@{ totalGB = 0; usedGB = 0; freeGB = 0; usedPct = 0 }; pagefile = $null; disks = @(); battery = $null; temperature = $null; load = $null } }
    $storage = Invoke-Safely 'storage' { Get-StorageSummary -Config $Config -LargeScanSec $(if ($Fast) { 5 } else { 45 }) } ([pscustomobject]@{ tempMB = 0; crashDumpMB = 0; cacheMB = 0; installersMB = 0; downloads = [pscustomobject]@{ count = 0; sizeGB = 0; oldCount = 0 }; largeFiles = @(); duplicateCandidates = 0 })
    $services = Invoke-Safely 'services-health' { Get-ServicesHealth -Services $persist.Services -Days $days } ([pscustomobject]@{ running = 0; stopped = 0; autoStartStopped = @(); failed = @(); thirdParty = @() })
    $startup = Invoke-Safely 'startup-health' { Get-StartupHealth -Startup $persist.Startup } ([pscustomobject]@{ count = 0; items = @() })

    $defender = Invoke-Safely 'defender' { Get-DefenderStatus } ([pscustomobject]@{ available = $false; enabled = $null; realTimeProtection = $null; sigVersion = $null; sigAgeDays = $null; lastQuickScan = $null; threats = 0; scan = [pscustomobject]@{ ran = $false; result = 'not-run'; durationSec = 0; threats = @() } })
    if (-not $SkipDefenderScan -and $defender.available -and -not $Config.safety.automationPaused) {
        [void](Invoke-Safely 'defender-update' { Update-DefenderSignatures } $null)
        $scan = Invoke-Safely 'defender-scan' { Invoke-DefenderScan -Type QuickScan -TimeoutSec $DefenderTimeoutSec } ([pscustomobject]@{ ran = $false; result = 'failed'; durationSec = 0 })
        $fresh2 = Invoke-Safely 'defender-status2' { Get-DefenderStatus } $null
        if ($fresh2) { $defender = $fresh2 }
        $defender.scan = [pscustomobject]@{ ran = [bool]$scan.ran; result = $scan.result; durationSec = $scan.durationSec; threats = @($defender.scan.threats) }
        if ($scan.result -in 'timeout', 'failed') { [void]$incomplete.Add("Defender quick scan: $($scan.result)") }
    }
    $firewall = Invoke-Safely 'firewall' { Get-FirewallStatus } ([pscustomobject]@{ profiles = @(); problems = @() })
    $winHealth = Invoke-Safely 'windows-health' { Get-WindowsHealth -IncludeDism:(-not $Fast -and $Type -eq 'daily') -DismMode CheckHealth -EventDays $days } ([pscustomobject]@{ pendingReboot = $false; windowsUpdate = [pscustomobject]@{ pendingCount = $null; lastInstalled = $null; status = 'unavailable' }; eventErrors = [pscustomobject]@{ system = 0; application = 0; top = @() }; sfc = [pscustomobject]@{ ran = $false; result = 'not-run' }; dism = [pscustomobject]@{ ran = $false; result = 'not-run'; detail = '' }; componentStore = [pscustomobject]@{ reclaimable = $null } })
    $network = if ($SkipNetwork) { [pscustomobject]@{ adapters = @(); gateway = $null; dnsServers = @(); internet = $true; dnsOk = $true; gatewayOk = $true; latencyMs = $null } } else { Invoke-Safely 'network' { Get-NetworkHealth } ([pscustomobject]@{ adapters = @(); gateway = $null; dnsServers = @(); internet = $false; dnsOk = $false; gatewayOk = $false; latencyMs = $null }) }
    $cleanup = Invoke-Safely 'cleanup' { Invoke-SafeCleanup -Config $Config } ([pscustomobject]@{ performed = $false; safeMode = [bool]$Config.safety.safeMode; items = @(); totalFreedMB = 0 })

    $top = { param($list, $key) @($list | Sort-Object $key -Descending | Select-Object -First 15) }
    $flagged = @($procs | Where-Object { $_.recommendationId })
    $procSection = [pscustomobject][ordered]@{
        total = $procs.Count; flagged = $flagged.Count; persistent = @($procs | Where-Object { $_.persistent }).Count
        highResource = @($procs | Where-Object { $_.flags -contains 'high-cpu' -or $_.flags -contains 'high-memory' }).Count
        topCpu = (& $top $procs 'cpuPct'); topMemory = (& $top $procs 'memoryMB')
    }
    $files = [pscustomobject]@{ candidateCount = 0; reclaimableGB = 0 }
    $sections = [pscustomobject][ordered]@{ system = $system; storage = $storage; processes = $procSection; services = $services; startup = $startup; defender = $defender; firewall = $firewall; windowsHealth = $winHealth; network = $network; cleanup = $cleanup; files = $files }
    $ctx.Sections = $sections; $ctx.Processes = $procs

    foreach ($r in @(Invoke-Safely 'system-recommendations' { New-SystemRecommendations -Sections $sections -Config $Config } @())) { [void]$fresh.Add($r) }
    $ctx.Recs = @(Invoke-Safely 'recommendation-store' { Update-RecommendationStore -Fresh @($fresh) -SweepKinds @('process', 'storage', 'security', 'system', 'startup', 'service') } @($fresh))

    if (-not $NoAI) {
        $ctx.AiStat = Invoke-Safely 'ai-enrichment' { Invoke-AiRecommendationEnrichment -Recommendations $ctx.Recs -Processes $procs -Config $Config } $null
        if ($ctx.AiStat -and $ctx.AiStat.used) { Save-RecommendationStore $ctx.Recs }
    }
    Write-JsonFile -Path (Get-GuardianPath 'LatestProcesses') -Object ([ordered]@{ generatedAt = Get-IsoNow; processes = $procs }) -Depth 8
    return [pscustomobject]$ctx
}

function New-RunReport {
    param($Config, $Ctx, [string]$Type, [string]$Id, [datetime]$Started, $Events, $Errors, [string]$Status = 'complete')
    $openRecs = @($Ctx.Recs | Where-Object { $_.status -eq 'open' })
    $score = Get-HealthScore -Sections $Ctx.Sections -Config $Config
    $ai = if ($Ctx.AiStat) { [pscustomobject]@{ enabled = [bool]$Ctx.AiStat.enabled; used = [bool]$Ctx.AiStat.used; requests = $Ctx.AiStat.requests; failures = $Ctx.AiStat.failures; briefing = $null; patterns = @(); skipped = $Ctx.AiStat.skipped } }
    else { [pscustomobject]@{ enabled = [bool]$Config.ai.enabled; used = $false; requests = 0; failures = 0; briefing = $null; patterns = @() } }
    $report = [ordered]@{
        schema = 'guardian.report/1'; type = $Type; id = $Id; generatedAt = Get-IsoNow; durationSec = [int]((Get-Date) - $Started).TotalSeconds
        status = $Status; incomplete = @($Ctx.Incomplete); healthScore = $score.score; healthReasons = @($score.reasons); host = (Get-HostInfo)
        summary = [pscustomobject]@{ headline = ''; bullets = @() }; sections = $Ctx.Sections
        recommendations = @($openRecs | ForEach-Object { $_.id }); actions = @($Events); errors = @($Errors); ai = $ai; timings = (Get-RunTimings)
    }
    $rp = [pscustomobject]$report
    $rp.summary = [pscustomobject]@{ headline = (Get-Headline $rp); bullets = @(Get-RunSummary $rp) }
    return $rp
}

function Write-RunMetric {
    param($Report, $Ctx, $Events, $Errors)
    $m = New-MetricFromReport -Report $Report -Processes $Ctx.Processes -Recommendations $Ctx.Recs -Events $Events -Errors $Errors
    Add-JsonLine -Path (Get-GuardianPath 'Metrics') -Object $m
}

function Invoke-Retention {
    param($Config)
    $days = [int]$Config.retention.reportsDays
    if ($days -le 0) { return }   # 0 = keep forever (explicit policy required to delete anything)
    $cut = (Get-Date).AddDays(-$days)
    foreach ($t in 'daily', 'weekly') {
        $root = Join-Path (Get-GuardianPath 'Reports') $t
        foreach ($d in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
            if ($d.LastWriteTime -lt $cut) {
                Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
                [void](Write-GuardianEvent -Category system -Action 'retention:report-deleted' -Target "$t/$($d.Name)" -Reason "Older than retention policy ($days days)")
            }
        }
    }
}

Export-ModuleMember -Function *
