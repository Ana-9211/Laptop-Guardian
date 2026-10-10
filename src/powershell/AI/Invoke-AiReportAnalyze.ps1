#requires -Version 5.1
# On-demand AI analysis of the CURRENT (newest) daily or weekly report. The user asked for it; nothing is executed and nothing but a short numeric
# summary of the report leaves the machine (no file paths, no user name). The reply is validated like the weekly briefing and saved beside the report data.
param([ValidateSet('daily', 'weekly')][string]$Type = 'daily')
. "$PSScriptRoot\..\Common\Load.ps1"
Start-RunContext -RunType 'user'
function Out-Result($o) { $o.success = [bool]$o.ok; if (-not $o.ok) { $o.error = $o.message }; ($o | ConvertTo-Json -Compress -Depth 12); exit $(if ($o.ok) { 0 } else { 1 }) }

$cfg = Get-GuardianConfig
if (-not $cfg.ai.enabled) { Out-Result @{ ok = $false; message = 'AI is disabled in Settings' } }
if (-not (Test-GeminiKeyConfigured)) { Out-Result @{ ok = $false; message = 'No Gemini API key configured' } }
if ((Get-AiTokensToday) -ge [int]$cfg.ai.dailyTokenBudget) { Out-Result @{ ok = $false; message = 'The daily AI token budget is used up (Settings > AI)' } }

$latestPath = Get-GuardianPath $(if ($Type -eq 'weekly') { 'LatestWeekly' } else { 'LatestDaily' })
$rep = Read-JsonFile -Path $latestPath -Default $null
if (-not $rep) { Out-Result @{ ok = $false; message = "There is no $Type report yet. Run a scan first." } }

function Get-Safe { param($Obj, [string[]]$Path) $o = $Obj; foreach ($p in $Path) { if ($null -eq $o) { return $null }; if ($o.PSObject.Properties[$p]) { $o = $o.$p } else { return $null } }; $o }
$s = Get-Safe $rep @('sections')
$m = @(Get-Metrics -Last 60 | Where-Object { ([datetime]$_.ts) -gt (Get-Date).AddDays(-7) })
$facts = [ordered]@{
    window = "the current $Type report (generated $([string]$rep.generatedAt)), with the last 7 days of daily samples for context"
    report = [ordered]@{ type = $rep.type; status = $rep.status; healthScore = $rep.healthScore; incomplete = @($rep.incomplete); healthReasons = @($rep.healthReasons | Select-Object -First 10 | ForEach-Object { Protect-Text ([string]$_) }); headline = (Protect-Text ([string](Get-Safe $rep @('summary', 'headline')))); bullets = @((Get-Safe $rep @('summary', 'bullets')) | Select-Object -First 10 | ForEach-Object { Protect-Text ([string]$_) }) }
    metrics = @($m | ForEach-Object { [ordered]@{ date = ([string]$_.ts).Substring(0, 10); cpuPct = $_.cpuPct; ramPct = $_.ramPct; diskFreeGB = $_.diskFreeGB; flagged = $_.flaggedCount; errors = $_.errorCount; serviceFailures = $_.serviceFailures; defenderThreats = $_.defenderThreats; startupCount = $_.startupCount; healthScore = $_.healthScore } })
    security = [ordered]@{ defenderEnabled = (Get-Safe $s @('defender', 'enabled')); realTime = (Get-Safe $s @('defender', 'realTimeProtection')); sigAgeDays = (Get-Safe $s @('defender', 'sigAgeDays')); threats = (Get-Safe $s @('defender', 'threats')); firewallProblems = @((Get-Safe $s @('firewall', 'problems')) | Select-Object -First 5 | ForEach-Object { Protect-Text ([string]$_) }) }
    windows = [ordered]@{ pendingReboot = (Get-Safe $s @('windowsHealth', 'pendingReboot')); pendingUpdates = (Get-Safe $s @('windowsHealth', 'windowsUpdate', 'pendingCount')); eventErrorsSystem = (Get-Safe $s @('windowsHealth', 'eventErrors', 'system')); eventErrorsApplication = (Get-Safe $s @('windowsHealth', 'eventErrors', 'application')); sfc = (Get-Safe $s @('windowsHealth', 'sfc', 'result')); dism = (Get-Safe $s @('windowsHealth', 'dism', 'result')) }
    system = [ordered]@{ uptimeHours = (Get-Safe $s @('system', 'uptimeHours')); cpuPct = (Get-Safe $s @('system', 'cpu', 'usagePct')); ramPct = (Get-Safe $s @('system', 'ram', 'usagePct')) }
    storage = [ordered]@{ tempMB = (Get-Safe $s @('storage', 'tempMB')); crashDumpMB = (Get-Safe $s @('storage', 'crashDumpMB')); cacheMB = (Get-Safe $s @('storage', 'cacheMB')); installersMB = (Get-Safe $s @('storage', 'installersMB')) }
    processes = [ordered]@{ total = (Get-Safe $s @('processes', 'total')); flagged = (Get-Safe $s @('processes', 'flagged')); highResource = (Get-Safe $s @('processes', 'highResource')) }
    services = [ordered]@{ failedCount = @((Get-Safe $s @('services', 'failed'))).Count }
    startup = [ordered]@{ count = (Get-Safe $s @('startup', 'count')) }
    open_recommendations = @(Get-RecommendationStore | Where-Object { $_.status -eq 'open' } | Select-Object -First 15 | ForEach-Object { [ordered]@{ title = (Protect-Text ([string]$_.title)); risk = $_.risk; consecutiveDays = $_.consecutiveDays; occurrences = $_.occurrences } })
    errors = @($rep.errors | Select-Object -First 8 | ForEach-Object { [ordered]@{ source = $_.source; message = (Protect-Text ([string]$_.message)) } })
}

$b = Invoke-AiWeeklyBriefing -Facts $facts -Config $cfg
if (-not $b.used) { Out-Result @{ ok = $false; message = 'AI analysis unavailable or the response failed validation (see Logs)' } }

$ai = [ordered]@{ reportType = $Type; reportId = [string]$rep.id; reportGeneratedAt = [string]$rep.generatedAt; generatedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz'); model = [string]$cfg.ai.model; briefing = $b.briefing; patterns = @($b.patterns); recommendations = @($b.recommendations) }
$out = Join-Path (Split-Path -Parent $latestPath) "ai-report-$Type.json"
Write-JsonFile -Path $out -Object $ai
[void](Write-GuardianEvent -Category ai -Action 'ai:report-analysis-saved' -Target "$Type/$($rep.id)" -Result success -Reason 'User asked for AI analysis of the current report')
Out-Result @{ ok = $true; analysis = $ai }
