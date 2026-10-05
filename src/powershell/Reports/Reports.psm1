#requires -Version 5.1
# Reports: JSON + self-contained HTML, metrics history, deterministic trend/recurrence analysis.
Set-StrictMode -Version 2.0

function ConvertTo-Html2 { param($Text) if ($null -eq $Text) { return '' }; return [System.Net.WebUtility]::HtmlEncode([string]$Text) }

function New-MetricFromReport {
    param($Report, $Processes, $Recommendations, $Events, $Errors)
    $s = $Report.sections
    $sysDisk = @($s.system.disks | Where-Object { $_.drive -ieq $env:SystemDrive } | Select-Object -First 1)
    if ($sysDisk.Count -eq 0) { $sysDisk = @($s.system.disks | Select-Object -First 1) }
    $d = if ($sysDisk.Count) { $sysDisk[0] } else { $null }
    [ordered]@{
        ts = $Report.generatedAt; runType = $Report.type
        cpuPct = $s.system.cpu.usagePct; ramPct = $s.system.ram.usedPct; ramUsedGB = $s.system.ram.usedGB; ramTotalGB = $s.system.ram.totalGB
        diskUsedPct = $(if ($d) { $d.usedPct } else { $null }); diskFreeGB = $(if ($d) { $d.freeGB } else { $null }); diskTotalGB = $(if ($d) { $d.totalGB } else { $null }); diskFreePct = $(if ($d) { $d.freePct } else { $null })
        processCount = @($Processes).Count; flaggedCount = @($Processes | Where-Object { @($_.flags).Count -gt 0 -and $_.policy -ne 'whitelist' -and $_.recommendationId }).Count
        recommendationCount = @($Recommendations | Where-Object { $_.status -eq 'open' }).Count; actionCount = @($Events).Count; errorCount = @($Errors).Count
        startupCount = $s.startup.count; serviceFailures = @($s.services.failed).Count; batteryPct = $(if ($s.system.battery) { $s.system.battery.pct } else { $null })
        downloadsGB = $s.storage.downloads.sizeGB; defenderSigAgeDays = $s.defender.sigAgeDays; defenderThreats = $s.defender.threats; healthScore = $Report.healthScore
    }
}

function Get-Metrics { param([int]$Last = 0) Read-JsonLines -Path (Get-GuardianPath 'Metrics') -Last $Last }

function Get-LinearSlopePerDay {
    # slope of y over time (units per day), least squares; $Points = @{t=[datetime];v=[double]}
    param($Points)
    $pts = @($Points)
    if ($pts.Count -lt 3) { return $null }
    $t0 = $pts[0].t
    $xs = $pts | ForEach-Object { ($_.t - $t0).TotalDays }; $ys = $pts | ForEach-Object { $_.v }
    $n = $pts.Count; $sx = ($xs | Measure-Object -Sum).Sum; $sy = ($ys | Measure-Object -Sum).Sum
    $sxy = 0.0; $sxx = 0.0; for ($i = 0; $i -lt $n; $i++) { $sxy += $xs[$i] * $ys[$i]; $sxx += $xs[$i] * $xs[$i] }
    $den = ($n * $sxx - $sx * $sx); if ([math]::Abs($den) -lt 1e-9) { return $null }
    return ($n * $sxy - $sx * $sy) / $den
}

function Get-RecurringPatterns {
    <# Deterministic pattern detection from stored history. Everything reported here is computed, never inferred by AI. #>
    param([int]$Days = 7, $Recommendations)
    $patterns = New-Object System.Collections.ArrayList
    $since = (Get-Date).AddDays(-$Days)
    $m = @(Get-Metrics -Last 400 | Where-Object { $_.runType -eq 'daily' -and ([datetime]$_.ts) -gt $since })
    if ($m.Count -ge 3) {
        $pts = @($m | Where-Object { $null -ne $_.diskFreeGB } | ForEach-Object { @{ t = [datetime]$_.ts; v = [double]$_.diskFreeGB } })
        $slope = Get-LinearSlopePerDay $pts
        if ($null -ne $slope -and $slope -lt -0.5) {
            [void]$patterns.Add([pscustomobject]@{ title = 'Free disk space is shrinking'; detail = ("Free space on the system drive fell by about {0:N1} GB/day over {1} samples (from {2} GB to {3} GB)." -f [math]::Abs($slope), $pts.Count, $pts[0].v, $pts[-1].v); evidence = @("diskFreeGB first=$($pts[0].v) last=$($pts[-1].v)"); source = 'deterministic' })
        }
        $ramHigh = @($m | Where-Object { $_.ramPct -gt 85 }).Count
        if ($ramHigh -ge 3) { [void]$patterns.Add([pscustomobject]@{ title = 'RAM was consistently high'; detail = "RAM usage exceeded 85% on $ramHigh of $($m.Count) daily scans."; evidence = @("$ramHigh/$($m.Count) scans above 85%"); source = 'deterministic' }) }
        $svc = @($m | Where-Object { $_.serviceFailures -gt 0 }).Count
        if ($svc -ge 2) { [void]$patterns.Add([pscustomobject]@{ title = 'Windows service failures recur'; detail = "Service failures were recorded on $svc of $($m.Count) days."; evidence = @("$svc days with serviceFailures>0"); source = 'deterministic' }) }
        $err = @($m | Where-Object { $_.errorCount -gt 0 }).Count
        if ($err -ge 3) { [void]$patterns.Add([pscustomobject]@{ title = 'Guardian itself hit errors repeatedly'; detail = "Collector errors on $err of $($m.Count) daily scans; check the Logs page."; evidence = @("$err days"); source = 'deterministic' }) }
        $thr = @($m | Where-Object { $_.defenderThreats -gt 0 }).Count
        if ($thr -ge 2) { [void]$patterns.Add([pscustomobject]@{ title = 'Defender repeatedly reported threats'; detail = "Threat detections present on $thr of $($m.Count) scans."; evidence = @("$thr days"); source = 'deterministic' }) }
    }
    foreach ($r in @($Recommendations | Where-Object { $_.status -eq 'open' -and [int]$_.consecutiveDays -ge 3 } | Sort-Object { [int]$_.consecutiveDays } -Descending | Select-Object -First 8)) {
        [void]$patterns.Add([pscustomobject]@{ title = "Recurring recommendation: $($r.title -replace ' - .*$','')"; detail = "This has appeared in your recommendations for $($r.consecutiveDays) consecutive days ($($r.occurrences) times in total) and is still open."; evidence = @("recommendation $($r.id): consecutiveDays=$($r.consecutiveDays)"); source = 'deterministic' })
    }
    foreach ($r in @($Recommendations | Where-Object { $_.status -in @('dismissed', 'ignored') -and [int]$_.occurrences -ge 5 } | Select-Object -First 5)) {
        [void]$patterns.Add([pscustomobject]@{ title = "Repeatedly dismissed: $($r.title -replace ' - .*$','')"; detail = "You dismissed this, yet it was detected $($r.occurrences) times. Consider whitelisting it if you are happy with it."; evidence = @("recommendation $($r.id): occurrences=$($r.occurrences)"); source = 'deterministic' })
    }
    return @($patterns)
}

function Get-RunSummary {
    param($Report)
    $s = $Report.sections; $b = New-Object System.Collections.ArrayList
    [void]$b.Add(("Health score {0}/100." -f $Report.healthScore))
    $d = @($s.system.disks)[0]
    if ($d) { [void]$b.Add(("{0} has {1} GB free ({2}% free)." -f $d.drive, $d.freeGB, $d.freePct)) }
    [void]$b.Add(("RAM {0}% used, CPU {1}%." -f $s.system.ram.usedPct, $(if ($null -ne $s.system.cpu.usagePct) { $s.system.cpu.usagePct } else { 'n/a' })))
    if ($s.defender) {
        if ($s.defender.available -eq $false) { [void]$b.Add('Defender status unavailable.') }
        elseif ($s.defender.realTimeProtection) { [void]$b.Add(("Defender real-time protection ON; signatures {0} day(s) old; {1} recent threat(s)." -f $s.defender.sigAgeDays, $s.defender.threats)) }
        else { [void]$b.Add('Defender real-time protection is OFF.') }
    }
    [void]$b.Add(("{0} processes, {1} flagged; {2} open recommendation(s)." -f $s.processes.total, $s.processes.flagged, @($Report.recommendations).Count))
    if (@($Report.incomplete).Count) { [void]$b.Add("Incomplete: $(@($Report.incomplete) -join '; ')") }
    return @($b)
}

function Get-Headline {
    param($Report)
    $sc = [int]$Report.healthScore
    if ($Report.status -eq 'failed') { return 'Scan failed - see errors.' }
    if ($sc -ge 90) { return 'System healthy.' }
    if ($sc -ge 75) { return 'System mostly healthy; a few items to review.' }
    if ($sc -ge 55) { return 'Several issues need attention.' }
    return 'Significant problems detected.'
}

# ---------- HTML ----------
function New-HtmlTable {
    param($Rows, [string[]]$Columns, [string[]]$Headers = $null)
    $rows = @($Rows)
    if ($rows.Count -eq 0) { return '<p class="muted">None.</p>' }
    if (-not $Headers) { $Headers = $Columns }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('<table><thead><tr>')
    foreach ($h in $Headers) { [void]$sb.Append("<th>$(ConvertTo-Html2 $h)</th>") }
    [void]$sb.Append('</tr></thead><tbody>')
    foreach ($r in $rows) {
        [void]$sb.Append('<tr>')
        foreach ($c in $Columns) { $v = $null; if ((Get-PropNames $r) -contains $c) { $v = $r.$c }; if ($v -is [array]) { $v = $v -join ', ' }; [void]$sb.Append("<td>$(ConvertTo-Html2 $v)</td>") }
        [void]$sb.Append('</tr>')
    }
    [void]$sb.Append('</tbody></table>')
    return $sb.ToString()
}

function ConvertTo-ReportHtml {
    param($Report, $Recommendations = @(), $FileCandidates = @())
    $s = $Report.sections
    $title = "Laptop Guardian - $($Report.type) report $($Report.id)"
    $score = [int]$Report.healthScore
    $scoreClass = if ($score -ge 85) { 'ok' } elseif ($score -ge 60) { 'warn' } else { 'bad' }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append(@"
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>$(ConvertTo-Html2 $title)</title>
<style>
:root{--bg:#fff;--fg:#1b1f24;--muted:#656d76;--line:#d8dee4;--card:#f6f8fa;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;--accent:#0969da}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--card:#161b22;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,Segoe UI,sans-serif}main{max-width:1000px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:28px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.muted{color:var(--muted)}.score{font:700 34px ui-monospace,Consolas,monospace}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
table{border-collapse:collapse;width:100%;font-size:13px;margin:6px 0}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top;word-break:break-word}th{color:var(--muted);font-weight:600}
td{font-family:ui-monospace,Consolas,monospace;font-size:12px}.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px 14px;margin:8px 0}
.badge{display:inline-block;padding:0 6px;border:1px solid var(--line);border-radius:4px;font-size:11px;font-family:ui-monospace,Consolas,monospace}
code{background:var(--card);padding:1px 5px;border-radius:4px;font-family:ui-monospace,Consolas,monospace;font-size:12px}
</style></head><body><main>
<div class="head"><div><h1>$(ConvertTo-Html2 $title)</h1><div class="muted">Generated $(ConvertTo-Html2 $Report.generatedAt) &middot; host $(ConvertTo-Html2 $Report.host.name) &middot; status $(ConvertTo-Html2 $Report.status) &middot; $(ConvertTo-Html2 $Report.durationSec)s</div></div>
<div class="score $scoreClass">$score<span class="muted" style="font-size:14px">/100</span></div></div>
<h2>Executive summary</h2><p><strong>$(ConvertTo-Html2 $Report.summary.headline)</strong></p><ul>
"@)
    foreach ($b in @($Report.summary.bullets)) { [void]$sb.Append("<li>$(ConvertTo-Html2 $b)</li>") }
    [void]$sb.Append('</ul>')
    if ($Report.ai -and $Report.ai.briefing) { [void]$sb.Append("<h2>AI briefing</h2><div class='card'>$(ConvertTo-Html2 $Report.ai.briefing)<div class='muted' style='margin-top:6px'>AI-generated from locally computed facts; informational only.</div></div>") }
    if (@($Report.incomplete).Count) { [void]$sb.Append("<div class='card warn'><strong>Incomplete operations:</strong> $(ConvertTo-Html2 (@($Report.incomplete) -join '; '))</div>") }

    $sys = $s.system
    [void]$sb.Append("<h2>System health</h2><table><tbody>")
    [void]$sb.Append("<tr><th>OS</th><td>$(ConvertTo-Html2 $sys.os) (build $(ConvertTo-Html2 $sys.build))</td></tr><tr><th>Uptime</th><td>$(ConvertTo-Html2 $sys.uptimeHours) h</td></tr>")
    [void]$sb.Append("<tr><th>CPU</th><td>$(ConvertTo-Html2 $sys.cpu.name) &middot; $(ConvertTo-Html2 $sys.cpu.usagePct)%</td></tr><tr><th>RAM</th><td>$(ConvertTo-Html2 $sys.ram.usedGB) / $(ConvertTo-Html2 $sys.ram.totalGB) GB ($(ConvertTo-Html2 $sys.ram.usedPct)%)</td></tr></tbody></table>")
    [void]$sb.Append((New-HtmlTable $sys.disks @('drive', 'fs', 'type', 'totalGB', 'freeGB', 'freePct', 'health')))

    if ($s.defender) { [void]$sb.Append("<h2>Security</h2><table><tbody><tr><th>Defender enabled</th><td>$(ConvertTo-Html2 $s.defender.enabled)</td></tr><tr><th>Real-time protection</th><td>$(ConvertTo-Html2 $s.defender.realTimeProtection)</td></tr><tr><th>Signature age (days)</th><td>$(ConvertTo-Html2 $s.defender.sigAgeDays)</td></tr><tr><th>Scan</th><td>$(ConvertTo-Html2 $s.defender.scan.result)</td></tr><tr><th>Threats (30d)</th><td>$(ConvertTo-Html2 $s.defender.threats)</td></tr></tbody></table>") }
    if ($s.firewall) { [void]$sb.Append((New-HtmlTable $s.firewall.profiles @('name', 'enabled', 'defaultInbound', 'defaultOutbound'))); foreach ($p in @($s.firewall.problems)) { [void]$sb.Append("<p class='warn'>$(ConvertTo-Html2 $p)</p>") } }

    [void]$sb.Append("<h2>Storage</h2><table><tbody><tr><th>Temp</th><td>$(ConvertTo-Html2 $s.storage.tempMB) MB</td></tr><tr><th>Crash dumps</th><td>$(ConvertTo-Html2 $s.storage.crashDumpMB) MB</td></tr><tr><th>Caches</th><td>$(ConvertTo-Html2 $s.storage.cacheMB) MB</td></tr><tr><th>Downloads</th><td>$(ConvertTo-Html2 $s.storage.downloads.count) files, $(ConvertTo-Html2 $s.storage.downloads.sizeGB) GB</td></tr></tbody></table>")
    [void]$sb.Append((New-HtmlTable @($s.storage.largeFiles | Select-Object -First 15) @('path', 'sizeMB')))
    if ($s.cleanup) { [void]$sb.Append("<h2>Cleanup</h2><p class='muted'>Safe mode: $(ConvertTo-Html2 $s.cleanup.safeMode) &middot; performed: $(ConvertTo-Html2 $s.cleanup.performed) &middot; $(ConvertTo-Html2 $s.cleanup.totalFreedMB) MB.</p>"); [void]$sb.Append((New-HtmlTable $s.cleanup.items @('kind', 'path', 'files', 'freedMB', 'result'))) }

    [void]$sb.Append("<h2>Processes</h2><p>$(ConvertTo-Html2 $s.processes.total) running, $(ConvertTo-Html2 $s.processes.flagged) flagged, $(ConvertTo-Html2 $s.processes.persistent) persistent.</p>")
    $cols = @('name', 'pid', 'cpuPct', 'memoryMB', 'publisher', 'signature', 'flags')
    [void]$sb.Append('<h3>Top by memory</h3>'); [void]$sb.Append((New-HtmlTable @($s.processes.topMemory | Select-Object -First 10) $cols))
    [void]$sb.Append('<h3>Top by CPU</h3>'); [void]$sb.Append((New-HtmlTable @($s.processes.topCpu | Select-Object -First 10) $cols))

    [void]$sb.Append('<h2>Recommendations</h2>')
    if (@($Recommendations).Count -eq 0) { [void]$sb.Append('<p class="muted">No open recommendations.</p>') }
    foreach ($r in @($Recommendations | Select-Object -First 40)) {
        [void]$sb.Append("<div class='card'><strong>$(ConvertTo-Html2 $r.title)</strong> <span class='badge'>risk $(ConvertTo-Html2 $r.risk)</span> <span class='badge'>confidence $(ConvertTo-Html2 $r.confidence)</span> <span class='badge'>$(ConvertTo-Html2 $r.suggestedAction)</span><p>$(ConvertTo-Html2 $r.whatIsIt)</p><ul>")
        foreach ($w in @($r.whyFlagged)) { [void]$sb.Append("<li>$(ConvertTo-Html2 $w)</li>") }
        [void]$sb.Append('</ul>')
        if ($r.stopCommand) { [void]$sb.Append("<div><span class='muted'>Stop:</span> <code>$(ConvertTo-Html2 $r.stopCommand.command)</code></div>") }
        if ($r.preventRestart) { [void]$sb.Append("<div><span class='muted'>Prevent restart:</span> <code>$(ConvertTo-Html2 $r.preventRestart.command)</code> <span class='muted'>$(ConvertTo-Html2 $r.preventRestart.explains)</span></div>") }
        [void]$sb.Append("<div class='muted'>Consequences: $(ConvertTo-Html2 $r.consequences)</div></div>")
    }
    [void]$sb.Append("<h2>Startup</h2>"); [void]$sb.Append((New-HtmlTable $s.startup.items @('kind', 'name', 'publisher', 'command')))
    [void]$sb.Append("<h2>Services</h2><p>$(ConvertTo-Html2 $s.services.running) running, $(ConvertTo-Html2 $s.services.stopped) stopped. Failed (recent): $(ConvertTo-Html2 (@($s.services.failed) -join ', '))</p>")
    $wh = $s.windowsHealth
    [void]$sb.Append("<h2>Windows health</h2><table><tbody><tr><th>Pending reboot</th><td>$(ConvertTo-Html2 $wh.pendingReboot)</td></tr><tr><th>Windows Update</th><td>$(ConvertTo-Html2 $wh.windowsUpdate.status) (pending: $(ConvertTo-Html2 $wh.windowsUpdate.pendingCount))</td></tr><tr><th>Event errors</th><td>System $(ConvertTo-Html2 $wh.eventErrors.system), Application $(ConvertTo-Html2 $wh.eventErrors.application)</td></tr><tr><th>SFC</th><td>$(ConvertTo-Html2 $wh.sfc.result)</td></tr><tr><th>DISM</th><td>$(ConvertTo-Html2 $wh.dism.result)</td></tr></tbody></table>")
    [void]$sb.Append((New-HtmlTable $wh.eventErrors.top @('source', 'id', 'count', 'message')))
    $n = $s.network
    [void]$sb.Append("<h2>Network</h2><p>Internet: $(ConvertTo-Html2 $n.internet) &middot; DNS: $(ConvertTo-Html2 $n.dnsOk) &middot; gateway $(ConvertTo-Html2 $n.gateway) ok: $(ConvertTo-Html2 $n.gatewayOk) &middot; latency $(ConvertTo-Html2 $n.latencyMs) ms</p>")
    [void]$sb.Append((New-HtmlTable $n.adapters @('name', 'status', 'speed', 'type')))

    if ($Report.type -eq 'weekly' -and (Get-PropNames $Report) -contains 'weekly' -and $Report.weekly) {
        [void]$sb.Append('<h2>Weekly phases</h2>'); [void]$sb.Append((New-HtmlTable $Report.weekly.phases @('name', 'status', 'startedAt', 'finishedAt', 'detail')))
        if (@($Report.weekly.recurring).Count) { [void]$sb.Append('<h2>Recurring problems</h2>'); [void]$sb.Append((New-HtmlTable $Report.weekly.recurring @('title', 'days', 'detail'))) }
        [void]$sb.Append("<h2>Shutdown</h2><p>Planned: $(ConvertTo-Html2 $Report.weekly.shutdown.planned) &middot; initiated: $(ConvertTo-Html2 $Report.weekly.shutdown.initiated) &middot; $(ConvertTo-Html2 $Report.weekly.shutdown.reason)</p>")
    }
    if (@($FileCandidates).Count) { [void]$sb.Append('<h2>Files to review</h2>'); [void]$sb.Append((New-HtmlTable @($FileCandidates | Select-Object -First 40) @('path', 'sizeMB', 'classification', 'category', 'recommendedAction'))) }
    if ($Report.ai -and @($Report.ai.patterns).Count) { [void]$sb.Append('<h2>Patterns</h2>'); foreach ($p in @($Report.ai.patterns)) { [void]$sb.Append("<div class='card'><strong>$(ConvertTo-Html2 $p.title)</strong><br>$(ConvertTo-Html2 $p.detail)<div class='muted'>$(ConvertTo-Html2 (@($p.evidence) -join '; '))</div></div>") } }
    [void]$sb.Append("<h2>Actions this run</h2>"); [void]$sb.Append((New-HtmlTable @($Report.actions | Select-Object -First 100) @('ts', 'category', 'action', 'target', 'result', 'actor')))
    if (@($Report.errors).Count) { [void]$sb.Append('<h2>Errors</h2>'); [void]$sb.Append((New-HtmlTable $Report.errors @('ts', 'source', 'message'))) }
    [void]$sb.Append('<p class="muted" style="margin-top:32px">Laptop Guardian. Observes aggressively, explains clearly, recommends intelligently, acts only with your authorisation.</p></main></body></html>')
    return $sb.ToString()
}

function Save-Report {
    param($Report, $Recommendations = @(), $FileCandidates = @())
    $dir = Join-Path (Get-GuardianPath 'Reports') (Join-Path $Report.type $Report.id)
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Write-JsonFile -Path (Join-Path $dir 'report.json') -Object $Report -Depth 16
    $html = ConvertTo-ReportHtml -Report $Report -Recommendations $Recommendations -FileCandidates $FileCandidates
    [System.IO.File]::WriteAllText((Join-Path $dir 'report.html'), $html, (New-Object System.Text.UTF8Encoding($false)))
    $latest = if ($Report.type -eq 'weekly') { Get-GuardianPath 'LatestWeekly' } else { Get-GuardianPath 'LatestDaily' }
    Write-JsonFile -Path $latest -Object $Report -Depth 16
    # verify
    foreach ($f in 'report.json', 'report.html') { if (-not (Test-Path -LiteralPath (Join-Path $dir $f))) { throw "Report file missing after write: $f" } }
    return $dir
}

Export-ModuleMember -Function *
