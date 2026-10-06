# Laptop Guardian data contract

Root = the data folder (`%LOCALAPPDATA%\LaptopGuardian` for an installed copy, the checkout itself for a development copy; `install.json` beside the program files names it). Administrator results and audit lines of an installed copy live in `%ProgramData%\LaptopGuardian` (see `docs/ARCHITECTURE.md`). All JSON UTF-8 (no BOM), camelCase keys, timestamps ISO-8601 local with offset. Writers: PowerShell agents + bridge. Readers: bridge -> dashboard. Dashboard must be defensive: any field may be missing/null.

## Files

| Path | Format | Writer |
|---|---|---|
| `config/config.json` | object | installer, bridge (PUT /api/config) |
| `config/process-policy.json` | `{blacklist:[PolicyEntry], whitelist:[PolicyEntry], ignored:[PolicyEntry]}` | bridge, agents (counters) |
| `data/secrets/gemini.dpapi` | DPAPI blob (CurrentUser) | bridge via Set-GeminiKey.ps1 |
| `data/state/bridge.json` | `{app, pid, port, startedAt, version, token}` (restricted to the current user; `token` is the per-start session token) | bridge |
| `data/state/ignored-files.json` | plain array of ignored file candidate ids | bridge (read by the weekly agent) |
| `data/state/action-results/<ticket>.json` (+ `<ticket>.running.json`) | the result of one elevated Action Center run | elevated action script |
| `data/latest/network.json` | the latest Network Guard snapshot | bridge (Network/Get-NetworkSnapshot.ps1) |
| `data/network/history.jsonl`, `dns-history.jsonl`, `rules.json`, `dns-log-previous.json` | snapshot summaries, DNS names seen, Guardian-created firewall rules (metadata), DNS Client log size to restore | bridge + action scripts |
| `data/network/deep/events-YYYY-MM-DD.jsonl` | Deep Network Guard connection events (opt-in, connection metadata only) | bridge |
| `data/latest/daily.json`, `data/latest/weekly.json` | Report | agents |
| `data/latest/processes.json` | `{generatedAt, processes:[Process]}` | agents |
| `data/latest/files.json` | `{generatedAt, drives:[...], candidates:[FileCandidate], largest:[...], duplicates:[DupGroup], downloads:{...}}` | agents |
| `data/metrics/metrics.jsonl` | one `Metric` per line: the last 180 days only | agents (append, under `<file>.lock`) |
| `data/metrics/metrics-daily.jsonl` | one summary `Metric` per day older than 180 days (`runType:"summary"`, `summaryOf` = rows rolled up, means of the numeric fields, maxima for the problem counters) | bridge maintenance |
| `data/actions/actions.jsonl` | one `ActionEvent` per line: the last 90 days only | agents + bridge (append, under `<file>.lock`) |
| `data/actions/archive/actions-YYYY-MM.jsonl` | the original audit rows older than 90 days, by month. Nothing is deleted. The dashboard reads the live file only | bridge maintenance |
| `data/actions/actions-daily.jsonl` | `{day,total,byCategory,bySeverity,errors}` per archived day | bridge maintenance |
| `data/network/deep-daily.jsonl` | `{day,opens,closes,topProcesses:[{name,n}],topRemotes:[{name,n}]}` for each expired Deep Network Guard day file | bridge |
| `data/state/queued-run.json` | `{kind:"daily"|"weekly",full:true,queuedAt}`: make the next scheduled run of that kind a full one; removed by the run that uses it | bridge (scan.queue-next-run), agents |
| `data/state/app-removals.json` | install folder and publisher recorded before a Revo uninstall, used only to report leftovers | agents |
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
 "safety":{"safeMode":true,"autoKillBlacklisted":true,"automationPaused":false,"weeklyShutdown":true},
 "ai":{"enabled":false,"model":"gemini-2.5-flash","maxRequestsPerRun":15,"maxProcessesPerRun":10,"dailyTokenBudget":200000},
 "cleanup":{"tempFiles":true,"crashDumps":true,"caches":true,"recycleBin":"never","tempMinAgeDays":2},
 "storage":{"drives":["C:"],"excludedDirs":[],"protectedDirs":[],"minLargeFileMB":500,"oldFileDays":365,"duplicateScan":true,"duplicateMinMB":50},
 "thresholds":{"cpuPct":50,"memoryMB":1500,"diskFreeWarnPct":15,"diskFreeCritPct":8},
 "retention":{"reportsDays":0},
 "network":{"snapshot":{"auto":true,"everyMinutes":60,"retentionDays":30,"maxMB":20},"deep":{"enabled":false,"retentionDays":7,"maxMB":100,"sampleSec":5},"dnsFiltering":{"enabled":false},"thresholds":{"burstConnections":100,"burstDestinations":40,"unknownDestinations":8,"persistentDestinations":5,"newConnectionsPerMinute":50}}
}
```
`retention.reportsDays = 0` means keep reports forever; metrics and the audit log are never deleted automatically. `network.deep.enabled` and `network.dnsFiltering.enabled` can only be changed through their own confirmed endpoints (a settings save that changes them is refused). Settings that lower a safety margin (`safeMode` off, `autoKillBlacklisted` on, fewer `protectedDirs`, `recycleBin:"always"`) are refused with HTTP 409 and `{needsConfirmation:[...]}` until the request is repeated with `_confirmRisky:true`. `safety.safeMode=true` => agents perform NO kill/cleanup/delete; observe+recommend only.

## PolicyEntry
`{id, name, path|null, reason, addedAt, addedBy:"user", enabled:true, action:"terminate"|"none", terminatedCount:0, lastTerminatedAt:null, disabledUntil:null}`
Match key = lower-case process name (without .exe) AND, if `path` set, case-insensitive path equality.

## Metric (one per line)
`{ts, runType:"daily"|"weekly"|"summary", cpuPct, ramPct, ramUsedGB, ramTotalGB, diskUsedPct, diskFreeGB, diskTotalGB, diskFreePct, processCount, flaggedCount, recommendationCount, actionCount, errorCount, startupCount, serviceFailures, batteryPct|null, downloadsGB, defenderSigAgeDays|null, defenderThreats, healthScore(0-100)}`

## ActionEvent
`{id, ts, category:"scan|process|ai|file|cleanup|defender|windows|policy|shutdown|config|system|remediation|network", severity:"info|warning|error", action, target|null, result:"success|failure|skipped|timeout|started", actor:"agent|user|policy|ai-validator", reason|null, relatedRecommendation|null, error|null, runType|null, data?}`
`data` is optional structured detail written by Action Center runs: `{subject, verified, needsElevation, details, undo:{action,params}|null, elevated, ticket}`. `subject` is a canonical key for what was changed (for example `service:Fax`, `fw:LG-...`) so an undo can be matched to its original. Never secrets.

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
All JSON unless noted. Every `/api/*` request except `GET /api/ping` must send `Authorization: Bearer <session token>` (the token is created per bridge start, written to `data/state/bridge.json`, and handed to the dashboard window in the URL fragment by the launcher). Cross-site requests (`Sec-Fetch-Site` other than same-origin/none) are refused. Mutating requests (POST/PUT/PATCH/DELETE) must also send header `X-Guardian: 1` and a same-origin Origin/Host; no CORS headers are emitted. Errors: `{error:string, errors?:[string], needsConfirmation?:[string]}` with 4xx/5xx; 401 means a missing or wrong token.

**Status and overview**
- `GET /api/ping` (no token) -> `{app, version, pid, startedAt, codeMtime, restartNeeded, port, root, distBuilt}`
- `GET /api/status[?fresh=1]` -> run state, last reports, snapshots, scheduled-task assessment (with repair info), attention items, shutdown info, `bridge:{...,restartNeeded}`, `network:{deepActive,deepSince,lastSnapshotAt,dnsFiltering}`
- `GET /api/overview` -> `{daily:Report|null, weekly:Report|null, metrics:Metric[] (last 90 days), next:{daily,weekly,shutdown}, safety, ai:{enabled,keyConfigured,model}, run:run-state, openRecommendations:int}`
- `GET /api/metrics?range=7|30|90|all` -> `Metric[]`

**Data**
- `GET /api/processes` -> processes.json; `GET /api/processes/history?name=x` -> `{name, appearances:[{ts,cpuPct,memoryMB,flags}], actions:[ActionEvent]}`
- `GET /api/recommendations?status=&kind=` -> `{updatedAt, items:[Recommendation]}`; `POST /api/recommendations/:id/status {status}`
- `GET /api/actions?limit=200&category=&severity=&q=&before=` -> `ActionEvent[]` newest first
- `GET /api/reports?type=daily|weekly`; `GET /api/reports/:type/:id`; `GET /api/reports/:type/:id/html` (text/html); `DELETE /api/reports/:type/:id`; `GET /api/reports/export?type&id&format=json|csv`
- `GET /api/files` -> files.json; `POST /api/files/ignore {id, ignored?}`. Files are recycled only through `/api/remediation/*` (`file.recycle`).
- `GET /api/policy`; `POST /api/policy {list:"blacklist|whitelist|ignored", name, path?, reason}`; `PATCH /api/policy/:list/:id {enabled?, disabledUntil?}`; `DELETE /api/policy/:list/:id`

**Settings and schedule**
- `GET|PUT /api/config` (never returns secrets; see the notes under config.json)
- `PUT /api/schedule` -> saves the schedule and re-registers tasks only when it changed; `POST /api/schedule/apply {elevate}` -> applies Settings to Task Scheduler (elevated when needed)
- `POST /api/scan/daily`, `POST /api/scan/weekly` -> start an agent detached. A dashboard-started weekly run always passes `-NoShutdown`, whatever the body says; only the scheduled task can start a shutdown.
- `POST /api/shutdown/cancel` -> cancels a pending Windows shutdown (fixed command, no inputs)

**AI**
- `POST /api/ai/key {key}`; `DELETE /api/ai/key`; `POST /api/ai/test` (returns `models`, the live list for this key); `POST /api/ai/analyze {recommendationId}`; `GET /api/ai/usage`

**Action Center** (every executable change is one of the allowlisted actions in `src/shared/action-catalog.json`; nothing accepts a command)
- `GET /api/remediation/findings` -> `{generatedAt, revo, findings:[Finding]}`; `GET /api/remediation/history?limit=` -> `{items:[HistoryItem]}`
- `POST /api/remediation/plan {actionId, params}` -> the exact plan (summary, consequences, undo, `requiredAcks`, `warnings`, `admin`, one-time `token`, 10 minute expiry)
- `POST /api/remediation/execute {token, confirm:true, acknowledged:[...], typed?}` (`typed` must equal the plan's `typedConfirmation`, the file name, for `file.delete-permanent`); `POST /api/remediation/cancel {token}`; `GET /api/remediation/result/:ticket` (polls an elevated run); `POST /api/remediation/undo {eventId}` -> a new plan

**Guidance** (read-only)
- `GET /api/setup` -> the first-run checklist `{items:[{id,title,detail,done,optional,unknown?,action:{actionId,label,params}|null,link|null}],complete,remaining}`. Nothing runs by itself; every action goes through plan, confirm, execute.
- `GET /api/changes` -> the newest daily report compared with the one before: `{available, reason?, from, to, items:[{label,from,to,delta,tone}]}`
- `GET /api/safemode/preview` -> what the agents would do with Safe Mode off, from the latest scan: `{safeMode, wouldDo:[{kind,label,detail}], wouldNotDo:[...], notes, basedOn}`. Runs nothing.

**Network Guard**
- `GET /api/network/current` (read-only; reads nothing from Windows; includes `findings`, a `posture` score with every deduction, and `snapshot.dnsConfig` with each interface's DNS servers and the registered DoH servers); `GET /api/network/fw-events?hours=` -> Windows Filtering Platform events 5156/5157/5152/5158 as `{available, reason, items:[{ts,eventId,result,direction,protocol,pid,application,localAddress,localPort,remoteAddress,remotePort}]}` (needs administrator rights to read the Security log and the audit policy turned on)
- `POST /api/network/snapshot` (takes one read-only snapshot); `GET /api/network/history?range=`; `GET /api/network/dns-log`
- `GET /api/network/deep`; `POST /api/network/deep/start {confirm:true, acknowledged:true}`; `POST /api/network/deep/stop`; `GET /api/network/deep/events`; `POST /api/network/deep/export {format:"jsonl"|"csv"}` (streamed download); `POST /api/network/deep/delete {confirm:true}`
- `POST /api/network/dns-filtering {confirm, enabled, acknowledged}`

## Action catalog (`src/shared/action-catalog.json`)
Every action has `id, category, label, risk (LOW|MEDIUM|HIGH), admin (true|false|"dynamic"), reversible, params (each an enum or a named pattern), summary ({param} placeholders), consequences, undo, verify`, and optionally `handler:"bridge"`, `undoId`, `long`, `typedConfirm`. A test checks all of this and that every action has a handler.
Added since the first release: `scan.run-now`, `scan.queue-next-run`, `scan.schedule-once`, `scan.cancel-once`, `setup.register-tasks`, `setup.enable-safe-defaults`, `setup.enable-dns-log`, `setup.enable-firewall-audit`, `setup.disable-firewall-audit`, `defender.enable-realtime`, `system.run-windows-update-scan`, `system.open-settings` (fixed table of Windows pages), `service.stop`, `service.start`, `storage.clean-temp`, `cleanup.empty-recycle-bin`, `file.delete-permanent` (only Recycle Bin or cleanup locations, typed file name), `app.uninstall` (guided Revo launch), `app.cleanup-leftovers` (read-only report), `dns.doh-enable`, `dns.doh-restore`.

## Retention
Raw metrics are kept for 180 days and raw audit rows for 90 days (constants in `src/bridge/lib/constants.js`; not settings). The bridge compacts them shortly after it starts and then daily, never while a scan runs, holding the same `<file>.lock` the agents hold when they append, writing through a temp file and renaming it over the original. Rows that cannot be parsed are kept. `/api/metrics` and `/api/overview` read a byte-capped tail of the live file plus the daily summaries, never the whole file. Deep Network Guard keeps its configured retention and size cap, summarising each day before it is removed.
