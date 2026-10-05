#requires -Version 5.1
<#
.SYNOPSIS  Laptop Guardian daily audit. Observes, analyses, recommends; acts only within explicit user policy.
.PARAMETER Fast        Shorter sampling/timeouts (used by installer smoke test).
.PARAMETER NoAI        Skip Gemini even if enabled.
.PARAMETER SkipDefenderScan  Do not trigger a Defender update/quick scan.
#>
[CmdletBinding()]
param([switch]$Scheduled, [switch]$Fast, [switch]$NoAI, [switch]$SkipDefenderScan, [switch]$SkipNetwork)

. "$PSScriptRoot\Common\Load.ps1"
Initialize-GuardianDirectories
Start-RunContext -RunType 'daily'
$started = Get-Date
$runMode = if ($Scheduled) { 'scheduled' } else { 'manual' }
$config = Get-GuardianConfig
$exit = 0

if (-not (Enter-GuardianLock -Name 'daily')) { Write-Host 'Another daily run is active; exiting.'; exit 0 }
$prevRun = (Get-RunState).running
if ($prevRun -and $prevRun.type -eq 'daily') { [void](Write-GuardianEvent -Category scan -Action 'run:previous-interrupted' -Severity warning -Result failure -Reason "Previous $($prevRun.type) run (phase '$($prevRun.phase)', started $($prevRun.startedAt)) never finished: machine shutdown, crash or kill. Recovering.") }
try {
    Set-RunState -Key 'running' -Value ([pscustomobject]@{ type = 'daily'; mode = $runMode; pid = $PID; phase = 'collecting'; startedAt = (Get-IsoNow) })
    [void](Write-GuardianEvent -Category scan -Action 'daily:scan-started' -Result started -Reason "safeMode=$($config.safety.safeMode) admin=$(Test-IsAdmin)")
    if ($config.safety.automationPaused) { [void](Write-GuardianEvent -Category scan -Action 'automation:paused' -Result skipped -Reason 'Automation paused; observation only') }

    $ctx = Invoke-Collection -Config $config -Type daily -SkipDefenderScan:$SkipDefenderScan -SkipNetwork:$SkipNetwork -NoAI:$NoAI -Fast:$Fast -DefenderTimeoutSec $(if ($Fast) { 60 } else { 600 })
    $id = (Get-Date).ToString('yyyy-MM-dd')
    [void](Write-GuardianEvent -Category scan -Action 'daily:scan-completed' -Result success -Reason "$($ctx.Processes.Count) processes, $(@($ctx.Recs | Where-Object status -eq 'open').Count) open recommendations")

    $events = Get-RunEvents; $errors = Get-RunErrors
    $status = if (@($ctx.Incomplete).Count -or @($errors).Count -gt 5) { 'partial' } else { 'complete' }
    $report = New-RunReport -Config $config -Ctx $ctx -Type 'daily' -Id $id -Started $started -Events $events -Errors $errors -Status $status
    $open = @($ctx.Recs | Where-Object { $_.status -eq 'open' })
    $dir = Save-Report -Report $report -Recommendations $open
    Write-RunMetric -Report $report -Ctx $ctx -Events $events -Errors $errors
    Invoke-Retention -Config $config
    Set-RunState -Key 'lastDaily' -Value ([pscustomobject]@{ startedAt = $started.ToString('yyyy-MM-ddTHH:mm:sszzz'); finishedAt = (Get-IsoNow); status = $status; reportId = $id })
    Write-Host "Daily report written: $dir (health $($report.healthScore)/100, status $status)"
} catch {
    $exit = 1
    [void](Write-GuardianEvent -Category scan -Action 'daily:scan-failed' -Result failure -Severity error -ErrorDetails $_.Exception.Message)
    try { Set-RunState -Key 'lastDaily' -Value ([pscustomobject]@{ startedAt = $started.ToString('yyyy-MM-ddTHH:mm:sszzz'); finishedAt = (Get-IsoNow); status = 'failed'; error = $_.Exception.Message }) } catch { }
    Write-Error $_
} finally {
    try { $cur = (Get-RunState).running; if (-not $cur -or $cur.type -eq 'daily') { Set-RunState -Key 'running' -Value $null } } catch { }
    Exit-GuardianLock -Name 'daily'
}
exit $exit
