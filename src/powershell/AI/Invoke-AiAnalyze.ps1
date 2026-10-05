#requires -Version 5.1
# On-demand AI analysis of ONE recommendation (user clicked "Analyze with AI"). Output is validated; nothing is executed.
param([Parameter(Mandatory)][string]$RecommendationId)
. "$PSScriptRoot\..\Common\Load.ps1"
Start-RunContext -RunType 'user'
function Out-Result($o) { $o.success = [bool]$o.ok; if (-not $o.ok) { $o.error = $o.message }; ($o | ConvertTo-Json -Compress -Depth 12); exit $(if ($o.ok) { 0 } else { 1 }) }
if ($RecommendationId -notmatch '^[0-9a-f]{12}$') { Out-Result @{ ok = $false; message = 'Invalid recommendation id' } }
$cfg = Get-GuardianConfig
if (-not $cfg.ai.enabled) { Out-Result @{ ok = $false; message = 'AI is disabled in Settings' } }
if (-not (Test-GeminiKeyConfigured)) { Out-Result @{ ok = $false; message = 'No Gemini API key configured' } }
$items = @(Get-RecommendationStore)
$rec = $items | Where-Object { $_.id -eq $RecommendationId } | Select-Object -First 1
if (-not $rec -or $rec.kind -ne 'process') { Out-Result @{ ok = $false; message = 'Recommendation not found or not a process recommendation' } }
$procs = Read-JsonFile -Path (Get-GuardianPath 'LatestProcesses') -Default $null
$proc = $null
if ($procs) { $proc = @($procs.processes | Where-Object { $_.name -ieq $rec.target.name -and ([string]$_.path) -ieq ([string]$rec.target.path) } | Sort-Object memoryMB -Descending | Select-Object -First 1)[0] }
$a = Invoke-AiProcessAnalysis -Rec $rec -Proc $proc -Config $cfg
if (-not $a) { Out-Result @{ ok = $false; message = 'AI analysis unavailable or response failed validation (see Logs)' } }
$rec.ai = $a
Save-RecommendationStore $items
Out-Result @{ ok = $true; ai = $a }
