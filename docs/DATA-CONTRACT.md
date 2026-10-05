# Laptop Guardian data contract

Root = install dir (e.g. `C:\Users\You\LaptopGuardian`). All JSON UTF-8 (no BOM), camelCase keys, timestamps ISO-8601 local with offset. Writers: PowerShell agents + bridge. Readers: bridge -> dashboard. Dashboard must be defensive: any field may be missing/null.

## Files

| Path | Format | Writer |
|---|---|---|
| `config/config.json` | object | installer, bridge (PUT /api/config) |
| `config/process-policy.json` | `{blacklist:[PolicyEntry], whitelist:[PolicyEntry], ignored:[PolicyEntry]}` | bridge, agents (counters) |
| `config/cleanup-policy.json` | object | bridge |
| `data/secrets/gemini.dpapi` | DPAPI blob (CurrentUser) | bridge via Set-GeminiKey.ps1 |
| `data/latest/daily.json`, `data/latest/weekly.json` | Report | agents |
| `data/latest/processes.json` | `{generatedAt, processes:[Process]}` | agents |
| `data/latest/files.json` | `{generatedAt, drives:[...], candidates:[FileCandidate], largest:[...], duplicates:[DupGroup], downloads:{...}}` | agents |
| `data/metrics/metrics.jsonl` | one `Metric` per line | agents |
| `data/actions/actions.jsonl` | one `ActionEvent` per line | agents + bridge |
| `data/recommendations/recommendations.json` | `{updatedAt, items:[Recommendation]}` | agents + bridge (status) |
| `data/state/run-state.json` | `{lastDaily:{startedAt,finishedAt,status}, lastWeekly:{...}, running:null|{type,phase,startedAt}}` | agents |
| `data/state/ai-usage.jsonl` | `{ts,model,kind,ok,promptTokens,outputTokens,error}` | agents + bridge |
| `reports/daily/YYYY-MM-DD/report.json` + `report.html` | Report | agents |
| `reports/weekly/YYYY-Www/report.json` + `report.html` | Report | agents |

## config.json
```json
{
 "schemaVersion":1,
 "bridge":{"host":"127.0.0.1","port":7878},
 "schedule":{"daily":{"enabled":true,"time":"19:00"},"weekly":{"enabled":true,"day":"Saturday","time":"02:00","shutdownTime":"05:00","shutdownEnabled":true}},
 "safety":{"safeMode":true,"requireConfirmation":true,"autoKillBlacklisted":true,"automationPaused":false,"weeklyShutdown":true},
 "ai":{"enabled":false,"model":"gemini-2.5-flash","maxRequestsPerRun":15,"maxProcessesPerRun":10,"scope":"metadata","dailyTokenBudget":200000},
 "cleanup":{"tempFiles":true,"crashDumps":true,"caches":true,"recycleBin":"never","tempMinAgeDays":2},
 "storage":{"drives":["C:"],"excludedDirs":[],"protectedDirs":[],"minLargeFileMB":500,"oldFileDays":365,"duplicateScan":true,"duplicateMinMB":50},
 "thresholds":{"cpuPct":50,"memoryMB":1500,"diskFreeWarnPct":15,"diskFreeCritPct":8},
 "retention":{"reportsDays":0,"metricsDays":0,"actionsDays":0},
 "dashboard":{"theme":"system"}
}
```
`retention.*Days = 0` means keep forever. `safety.safeMode=true` => agents perform NO kill/cleanup/delete; observe+recommend only.

## PolicyEntry
`{id, name, path|null, reason, addedAt, addedBy:"user", enabled:true, action:"terminate"|"none", terminatedCount:0, lastTerminatedAt:null, disabledUntil:null}`
Match key = lower-case process name (without .exe) AND, if `path` set, case-insensitive path equality.

## Metric (one per line)
`{ts, runType:"daily"|"weekly", cpuPct, ramPct, ramUsedGB, ramTotalGB, diskUsedPct, diskFreeGB, diskTotalGB, diskFreePct, processCount, flaggedCount, recommendationCount, actionCount, errorCount, startupCount, serviceFailures, batteryPct|null, downloadsGB, defenderSigAgeDays|null, defenderThreats, healthScore(0-100)}`

## ActionEvent
`{id, ts, category:"scan|process|ai|file|cleanup|defender|windows|policy|shutdown|config|system", severity:"info|warning|error", action, target|null, result:"success|failure|skipped|timeout|started", actor:"agent|user|policy|ai-validator", reason|null, relatedRecommendation|null, error|null, runType|null}`

## Process
`{name, pid, path|null, commandLine|null, parentPid, parentName|null, cpuPct, cpuSeconds, memoryMB, startTime|null, publisher|null, signature:"Valid|NotSigned|Invalid|Unknown", signed:bool, services:[string], startupEntries:[{kind:"registry|folder|task|service",name,location,command}], scheduledTasks:[string], persistent:bool, user|null, pathClass:"system|program-files|user-appdata|temp|downloads|other|unknown", classification:"windows|known-app|third-party|unknown", instances:int, flags:[string], policy:"blacklist|whitelist|ignored|none", recommendationId|null}`
Flags: `high-cpu, high-memory, persistent, unusual-location, duplicate, no-publisher, unsigned, blacklisted, whitelisted`.

## Recommendation
```
{id (stable hash), kind:"process|file|system|storage|security|startup|service",
 title, status:"open|dismissed|ignored|resolved|actioned", risk:"LOW|MEDIUM|HIGH|UNKNOWN", severity:"info|low|medium|high|critical",
 confidence:0..1 (deterministic confidence), source:"deterministic|ai",
 firstSeen, lastSeen, occurrences:int, consecutiveDays:int,
 target:{name,pid,path}|null,
 identity:{name,pid,path,publisher,signature,parent,service}|null,
 whatIsIt, whyFlagged:[string], 
 persistence:{persistent:bool, mechanisms:[{kind,name,location}]},
 suggestedAction:"Leave running|Review|Stop temporarily|Disable startup|Disable scheduled task|Uninstall associated application|Investigate further",
 stopCommand:Cmd|null, preventRestart:Cmd|null, consequences,
 ai:AiAnalysis|null}
Cmd = {command, explains, risk:"LOW|MEDIUM|HIGH", requiresAdmin:bool, reversible:bool}
AiAnalysis = {classification, what_is_it, why_flagged, risk, persistence, suggested_action, temporary_stop_method, persistence_removal_method, consequences, confidence:0..1, evidence:[string], warnings:[string], analyzedAt, model, validated:true}
```
Commands are display-only text generated by local code (never AI-executed).

## FileCandidate
`{id, path, name, sizeMB, lastModified, lastAccessed|null, ageDays, extension, classification:"KEEP|REVIEW|LIKELY_UNNECESSARY|HIGH_RISK|UNKNOWN", category:"large|old|duplicate|installer|archive|crash-dump|temp|abandoned-download|other", whatIsIt, whyFlagged:[string], duplicateOf|null, referencedBySoftware:bool|null, ifDeleted, risk, recommendedAction, ignored:bool}`

## Report (daily and weekly)
```
{schema:"guardian.report/1", type, id, generatedAt, durationSec, status:"complete|partial|failed", incomplete:[string],
 healthScore, host:{name,user,os,build}, 
 summary:{headline, bullets:[string]},
 sections:{
  system:{os,build,uptimeHours,bootTime,cpu:{name,cores,logical,usagePct},ram:{totalGB,usedGB,freeGB,usedPct},pagefile:{sizeMB,usedMB},disks:[{drive,fs,type:"SSD|HDD|Unknown",totalGB,freeGB,usedPct,freePct,health|null}],battery:{present,pct,charging,onAC}|null,temperature:{available,celsius|null},load},
  storage:{tempMB,crashDumpMB,cacheMB,installersMB,downloads:{count,sizeGB,oldCount},largeFiles:[{path,sizeMB}],duplicateCandidates:int},
  processes:{total,flagged,persistent,highResource,topCpu:[Process],topMemory:[Process]},
  services:{running,stopped,autoStartStopped:[string],failed:[string],thirdParty:[{name,display,path}]},
  startup:{count,items:[{kind,name,location,command,publisher|null}]},
  defender:{enabled,realTimeProtection,sigVersion,sigAgeDays,lastQuickScan,scan:{ran,result,durationSec,threats:[{name,severity,status}]},threats:int},
  firewall:{profiles:[{name,enabled,defaultInbound,defaultOutbound}],problems:[string]},
  windowsHealth:{pendingReboot:bool,windowsUpdate:{pendingCount,lastInstalled|null,status},eventErrors:{system:int,application:int,top:[{source,id,count,message}]},sfc:{ran,result},dism:{ran,result,detail},componentStore:{reclaimable|null}},
  network:{adapters:[{name,status,speed,type}],gateway,dnsServers:[string],internet:bool,dnsOk:bool,gatewayOk:bool,latencyMs|null},
  cleanup:{performed:bool,safeMode:bool,items:[{kind,path,freedMB,result}],totalFreedMB},
  files:{candidateCount, reclaimableGB}
 },
 recommendations:[Recommendation ids], 
 actions:[ActionEvent] (this run), errors:[{ts,source,message}],
 ai:{enabled,used,requests,failures,briefing|null,patterns:[{title,detail,evidence:[string]}]},
 weekly:{phases:[{name,status:"complete|skipped|timeout|failed|incomplete",startedAt,finishedAt,detail}], trends:{...}, recurring:[{title,days,detail}], unresolved:[Recommendation ids], shutdown:{planned,initiated,reason}}  // weekly only
}
```
Weekly-only `sections` may add `diskHealth`, `fileSystem`, `scheduledTasks`.

## Bridge API (Node, 127.0.0.1 only)
All JSON. Mutating requests (POST/PUT/PATCH/DELETE) must send header `X-Guardian: 1` and same-origin Origin/Host; no CORS headers are emitted. Errors: `{error:string}` with 4xx/5xx.

- `GET /api/overview` -> `{daily:Report|null, weekly:Report|null, metrics:Metric[] (last 90), next:{daily,weekly,shutdown}, safety, ai:{enabled,keyConfigured,model}, run:run-state, openRecommendations:int}`
- `GET /api/metrics?range=7|30|90|all` -> `Metric[]`
- `GET /api/processes` -> processes.json; `GET /api/processes/history?name=x` -> `{name, appearances:[{ts,cpuPct,memoryMB,flags}], actions:[ActionEvent]}`
- `GET /api/recommendations?status=&kind=` -> items; `POST /api/recommendations/:id/status {status}`
- `GET /api/actions?limit=200&category=&severity=&q=&before=` -> `ActionEvent[]` newest first
- `GET /api/reports?type=daily|weekly` -> `[{type,id,generatedAt,status,healthScore,summary,sizeKB}]`; `GET /api/reports/:type/:id` -> Report; `GET /api/reports/:type/:id/html` -> text/html; `DELETE /api/reports/:type/:id`; `GET /api/reports/export?type&id&format=json|csv`
- `GET /api/files` -> files.json; `POST /api/files/ignore {id}`; `POST /api/files/recycle {path, confirm:true}` (Recycle Bin only)
- `GET|PUT /api/config` (never returns secrets); `GET|PUT /api/cleanup-policy`
- `GET /api/policy`; `POST /api/policy {list:"blacklist|whitelist|ignored", name, path?, reason}`; `PATCH /api/policy/:list/:id {enabled?, disabledUntil?}`; `DELETE /api/policy/:list/:id`
- `POST /api/process/kill {pid, name, path, confirm:true}` -> validated against live process (name+path match) and protected list; logs action
- `GET /api/commands/validate`? not exposed. 
- `POST /api/ai/key {key}`; `DELETE /api/ai/key`; `GET /api/ai/status`; `POST /api/ai/test`; `POST /api/ai/analyze {recommendationId}`; `GET /api/ai/usage`
- `POST /api/scan/daily`, `POST /api/scan/weekly {noShutdown:true}` -> starts agent detached; `GET /api/run`
- `GET /api/schedule` -> `{tasks:[{name,state,nextRun,lastRun,lastResult}]}`; `PUT /api/schedule` -> updates config + re-registers tasks via Scheduler.ps1
