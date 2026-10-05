# Laptop Guardian

A local-first Windows auditing, monitoring, recommendation and reporting platform for a personal laptop.

> **Laptop Guardian observes aggressively, explains clearly, recommends intelligently, and only performs destructive actions that you have explicitly authorised.**

* **Daily agent** (Task Scheduler, 19:00): fast health audit, process analysis, Defender update + quick scan, safe cleanup, report.
* **Weekly agent** (Task Scheduler, Saturday 02:00): deep analysis (full Defender scan, SFC, DISM, disk/filesystem health, storage + duplicate analysis, recurring-problem detection, optional Gemini briefing), report, then a controlled Windows shutdown (target 05:00).
* **Dashboard**: a local React app served by a small Node bridge on `127.0.0.1` only. Overview, processes, files & storage, health, reports, logs, recommendations, blacklist/whitelist, settings.
* **Everything is persisted** as plain JSON/JSONL + rendered HTML under this folder, so reports and graphs survive reboots and can be read without the dashboard.

---

## Contents
1. [Quick start](#quick-start) · 2. [Prerequisites](#prerequisites) · 3. [Architecture](#architecture) · 4. [How Laptop Guardian decides](#how-laptop-guardian-decides) · 5. [What is automatic vs. what needs approval](#what-is-automatic-vs-what-needs-approval) · 6. [Scheduling](#scheduling) · 7. [Dashboard](#dashboard) · 8. [Configuration](#configuration) · 9. [Gemini setup](#gemini-setup) · 10. [Process blacklist / whitelist](#process-blacklist--whitelist) · 11. [Reports & data](#reports--data) · 12. [Security model](#security-model) · 13. [Testing](#testing) · 14. [Troubleshooting](#troubleshooting) · 15. [Uninstall](#uninstall) · 16. [Known limitations](#known-limitations)

---

## Quick start

```powershell
cd C:\Users\You\Documents\LaptopGuardian
# Recommended: elevated so the scheduled tasks can run SFC / DISM / filesystem scans
.\Install-LaptopGuardian.ps1 -Elevate          # UAC prompt, then installs
# or, without elevation (tasks run with limited rights; heavy Windows integrity checks are skipped)
.\Install-LaptopGuardian.ps1

# open the dashboard
.\src\powershell\Start-Dashboard.ps1           # also available from the Start Menu: "Laptop Guardian"
```

Dashboard: **http://127.0.0.1:7878/**

### One-click launch

The installer creates and verifies two shortcuts named **Laptop Guardian**: one in the Start Menu and one on the Desktop (`-NoDesktopShortcut` skips the Desktop one; `-SkipShortcuts` skips both). Either one, or `Open-LaptopGuardian.cmd` in the project folder, or `.\src\powershell\Start-Dashboard.ps1`, does the same thing:

1. Checks whether a Laptop Guardian bridge already answers on `127.0.0.1:7878` (`/api/ping` identifies it, so another program on the port is never mistaken for it).
2. If not, starts the bridge hidden and waits up to 20 s until it responds. A leftover `data\state\bridge.json` from a crash is cleared; an unresponsive or **outdated** bridge of this install (its code is newer than the running process) is replaced. Only `node.exe` processes running this install's `src\bridge\server.js` are ever stopped.
3. Opens the dashboard in a clean **app window** (Microsoft Edge, else Google Chrome, `--app` mode with its own profile in `data\state\app-profile`, so it has no tabs or address bar and keeps its own theme setting). If an app window is already open it is brought to the front instead of opening a second one. If neither browser is found it falls back to your default browser.
4. A launch never creates a second bridge or a second window, even if you double-click twice; launches are serialised with a named mutex.

When something is missing you get a message box (from the shortcuts) or a red console line (from the terminal) that says what to do: Node.js missing or older than 18, dashboard not built (`Install-LaptopGuardian.ps1`, or `cd src\dashboard; npm ci; npm run build`), port held by another program, or the bridge failing to start (with the last line of `logs\bridge-err.log`). Everything is also written to `logs\launcher.log`. Diagnose without starting anything: `.\src\powershell\Start-Dashboard.ps1 -Check`.

### Refresh status and live status

The header has a **Refresh status** button (keyboard: **R**, never while typing in a field or with a dialog open; **Ctrl+R** stays the browser's own reload). It re-reads Task Scheduler, the current run state, report availability, the action log summary, the process/file snapshots and AI status, and reloads every data panel that is on screen **in place**: your page, filters, sort order, search text, drawers and dialogs are kept. Only one refresh runs at a time (extra clicks are ignored), the button shows a spinner, the header shows when data was last refreshed, and a toast reports success or the exact failure.

Without clicking anything the dashboard polls the cheap `/api/status` endpoint every 10 s (every 4 s while a scan runs, every 10 s while the bridge is offline, paused while the window is hidden). When a scan starts you see a banner with its phase, elapsed time and the latest logged action; when it ends the banner turns into "scan finished" with links to the report and log, and polling slows down again.

The status rail under the header (it wraps on wide screens and folds into an expandable one-line summary on narrow ones) always shows: bridge connected/offline, Safe Mode, scan running or idle, Task Scheduler health, next daily and weekly run, and the weekly shutdown time (or a **pending shutdown** with the `shutdown /a` cancel command). The Overview page adds **What needs attention** (prioritised: security, then storage, then high-risk recommendations, then scheduled-maintenance problems, then housekeeping) and **Background maintenance**, which explains each task in plain language:

| Task Scheduler result | Meaning in the dashboard |
|---|---|
| `0x41303` "has not yet run" | **Normal** for a newly registered task: "Waiting for first run" (info, not a problem) |
| `0x0` | Last run succeeded |
| `0x41301` | Running now |
| `0x41306` | Stopped before it finished (warning) |
| anything else | Failed, with the code and a readable cause where known (critical) |
| task not registered / disabled | Warning, unless you switched that schedule off in Settings |
| trigger time or weekday differs from Settings, weekly task registered without `-Scheduled`, or running without administrator rights | Listed as an issue under the task |

**Manual vs scheduled weekly runs.** A weekly audit started from the dashboard or by hand is labelled *Manual run · no shutdown* and can never shut the laptop down. Only the task registered by the installer (`Weekly.ps1 -Scheduled`) may schedule the 05:00 shutdown, and the banner says so while it runs.

The installer: validates prerequisites, creates `data/ reports/ logs/ config/`, writes default config (existing config is never overwritten), builds the dashboard, registers the scheduled tasks (`\LaptopGuardian\Daily Audit`, `Weekly Deep Analysis`, `Dashboard Bridge`), verifies registration, runs a safe observe-only test scan, creates a Start Menu shortcut and prints the dashboard URL. Flags: `-SkipTasks -SkipBuild -SkipSmokeTest -RunTests -Elevate`.

**First-install steps (verified on Windows 11, PowerShell 5.1, Node 24):**

1. Run the installer (above). With `-Elevate`, accept the UAC prompt; the Daily/Weekly tasks get *Highest* run level, the dashboard bridge stays *Limited*.
2. The installer restores dashboard dependencies with `npm ci` (from `package-lock.json`) and rebuilds `dist/` whenever it is missing or older than the sources. Failures print the npm/tsc output and what to do.
3. Verify: `Get-ScheduledTask -TaskPath '\LaptopGuardian\'` should list three tasks in state *Ready*.
4. Open the dashboard, review *Settings → Safety* (Safe Mode stays on until you turn it off).
5. Optional: add a Gemini key in *Settings → Gemini*.

**To cancel a pending weekly shutdown:** `shutdown /a` (works any time during the countdown). To prevent shutdowns entirely: *Settings → Safety → Disable weekly shutdown*.

**Safe Mode is ON after install.** In Safe Mode Guardian only observes and recommends: no automatic process termination, no automatic cleanup deletions. Turn it off in *Settings → Safety* when you are ready for automation.

## Prerequisites
* Windows 10/11, Windows PowerShell 5.1 (ships with Windows). PowerShell 7 is not required.
* Node.js 18+ (the dashboard bridge). npm is needed once to build the dashboard.
* Microsoft Defender cmdlets for the Defender checks (if a third-party antivirus replaced Defender, those checks report "unavailable").
* Administrator rights are only needed for SFC, DISM, `Repair-Volume -Scan`, `C:\Windows\Temp` cleanup and `C:\Windows\Minidump`. Everything else runs as your normal user.
* Optional: a Gemini API key for AI analysis.

## Architecture

```
LaptopGuardian/
├── Install-LaptopGuardian.ps1 / Uninstall-LaptopGuardian.ps1
├── src/
│   ├── powershell/
│   │   ├── Daily.ps1  Weekly.ps1  Scheduler.ps1  Start-Dashboard.ps1
│   │   ├── Common/      Core.psm1 (paths, config, JSON IO, event log, safe command exec, locks)
│   │   │                Security.psm1 (protected processes/paths, command allowlist, Recycle Bin, AI validation)
│   │   ├── Processes/   Processes (snapshot, signatures, flags) · Persistence (services/tasks/startup)
│   │   │                Policy (blacklist/whitelist/ignored + enforcement) · Recommendations (engine + store)
│   │   ├── Health/ Defender/ Network/ Windows/ Services/   collectors
│   │   ├── Storage/     Storage.psm1 + FsWalker.cs (fast, junction-safe, deadline-aware walker) + allowlisted cleanup
│   │   ├── Files/       candidate detection, conservative classification, duplicate hashing (cached)
│   │   ├── AI/          Gemini client, privacy scrubbing, enrichment, weekly briefing
│   │   ├── Reports/     JSON + HTML reports, metrics history, trend/recurrence analysis
│   │   ├── Pipeline/    shared orchestration (every collector isolated by Invoke-Safely)
│   │   ├── Shutdown/    controlled shutdown
│   │   └── Actions/     small, fixed scripts the bridge calls after user confirmation
│   ├── bridge/          Node server (127.0.0.1 only): REST API + static dashboard
│   ├── dashboard/       React + Vite + TypeScript, hand-written CSS, hand-written SVG charts
│   └── shared/schemas/  JSON schemas (report, metric, recommendation, action event, AI analysis, policy)
├── config/              config.json · process-policy.json · cleanup-policy.json   (git-ignored)
├── data/                latest/ metrics/ actions/ recommendations/ state/ secrets/    (git-ignored)
├── reports/daily/YYYY-MM-DD/  reports/weekly/YYYY-Www/   (report.json + report.html)
├── logs/                human-readable text log per day
├── tests/               Pester (PowerShell) + node:test (bridge); see Testing
└── docs/DATA-CONTRACT.md   file formats and the REST API
```

Data flow: **PowerShell agents write JSON → bridge reads it and serves it → dashboard renders it.** User actions travel the other way: dashboard → bridge (validated) → a fixed PowerShell script → logged as an action event.

## How Laptop Guardian decides

Every finding passes through five distinct stages. Only the last two can change anything on your machine.

1. **Observation.** Read-only collection: processes (path, signature, parent, CPU/RAM, services, tasks, startup entries), disks, Defender, firewall, event logs, network, storage. No judgement yet.
2. **Deterministic analysis.** Local rules turn observations into *flags* (`high-cpu`, `high-memory`, `persistent`, `unusual-location`, `unsigned`, `duplicate`, `blacklisted`…). Rules are explicit and testable. "Unfamiliar" is never treated as "malicious": an unknown process with one weak signal is `UNKNOWN`/`LOW`, never `HIGH`.
3. **AI analysis (optional).** Only the highest-value process recommendations (limited per run) are sent to Gemini as *structured metadata* (no file contents, command-line arguments, user name, or secrets). The reply must be JSON that passes a strict schema; enums are checked, text is sanitised, and any shell text it proposes must match a hard allowlist or it is dropped. AI output is stored next to — never instead of — the deterministic result. **Risk** (what could go wrong) and **confidence** (how sure the identification is) are stored separately. Weekly, Gemini also receives locally-computed numbers and writes a short briefing; patterns without cited evidence are discarded.
4. **Recommendation.** A recommendation explains: what it is, why it was flagged (specific evidence), whether it persists and via what mechanism, the suggested action, how to stop it, how to prevent a restart, consequences, risk and confidence. Commands are **displayed only** (syntax-highlighted, with *Copy*, admin/reversible/risk badges). Guardian never executes a displayed command.
5. **User action / automatic policy.** You choose *Kill once / Blacklist / Whitelist / Ignore*, or move a file to the Recycle Bin, each with a confirmation dialog. Only entries **you** put on the blacklist are ever terminated automatically, and only when Safe Mode is off.

Process risk levels are `LOW / MEDIUM / HIGH / UNKNOWN`. File classes are `KEEP / REVIEW / LIKELY_UNNECESSARY / HIGH_RISK / UNKNOWN` and default to `REVIEW` when uncertain.

## What is automatic vs. what needs approval

| Action | Automatic? | Condition |
|---|---|---|
| Collect metrics, build reports, write logs | Yes | always |
| Defender signature update + quick scan (daily), full scan (weekly) | Yes | Defender present, not paused; full scan skipped on battery |
| SFC `/verifyonly`, DISM `/CheckHealth` (daily) / `/ScanHealth` (weekly), `Repair-Volume -Scan` | Yes | requires elevation; read-only variants only |
| Delete old files in allowlisted temp/crash/cache folders | **Only when Safe Mode is off** | files only, older than *tempMinAgeDays*, never personal folders |
| Terminate a **blacklisted** process | **Only when Safe Mode is off**, auto-kill on, entry enabled | never protected/system processes |
| Empty Recycle Bin | Only if you set a policy ≠ `never` and Safe Mode is off | permanent for items already in the bin |
| Weekly shutdown | Yes, only if **all** gates pass | run started by the Task Scheduler action (`Weekly.ps1 -Scheduled`; manual and dashboard runs never shut down), *Safety → weekly shutdown* and *Schedule → shutdown* both on, automation not paused, report files written and verified, and the 05:00 target still lies ahead (within 6 h). Minimum 5 min warning. Cancel any time with `shutdown /a` |
| Kill an unknown process | **Never automatic** | you click *Kill once* |
| Delete / recycle any file | **Never automatic** | you click *Move to Recycle Bin*; permanent deletion is not offered |
| Uninstall software, edit registry/services/tasks/firewall, disable Defender | **Never** | Guardian only shows the command |
| `sfc /scannow`, `DISM /RestoreHealth` | **Never** | shown as a suggestion only |

## Scheduling

Windows Task Scheduler is used; no PowerShell process stays alive. Times come from `config/config.json` and are editable in *Settings → Schedule* (the bridge re-registers tasks).

| Task | Default | Notes |
|---|---|---|
| `\LaptopGuardian\Daily Audit` | every day 19:00 | `StartWhenAvailable` runs it when the laptop wakes if 19:00 was missed; 1 h limit |
| `\LaptopGuardian\Weekly Deep Analysis` | Saturday 02:00 | `WakeToRun`; 5 h limit; shutdown target 05:00 |
| `\LaptopGuardian\Dashboard Bridge` | at logon | least-privilege, 127.0.0.1 only |

**Elevated tasks are never downgraded.** Daily and Weekly run with administrator rights when registered from an elevated shell. Saving Settings from the dashboard (a standard process) only touches Task Scheduler when the schedule itself changed, and never replaces or removes an elevated task: it reports that administrator permission is needed instead. The Overview and Settings pages then offer **Fix with administrator permission**, which shows exactly what will change, asks Windows for permission (UAC), and runs only Guardian's own `Scheduler.ps1 -Action Register`. Declining changes nothing. Task definitions are checked for the `-Scheduled` marker (without it, runs count as manual and the weekly run can never shut down), the start time and day, and the script path.

Tasks run **only while you are logged on** (the screen may be locked). That is required so the DPAPI-protected Gemini key can be decrypted. Leave the laptop plugged in, asleep or locked on Friday night. "Wake to run" also needs wake timers enabled in your power plan.

**Weekly phases:** (1) preflight: AC power, free space, previous-run status, reports writable, Gemini configured; (2) deep analysis, each step bounded by the remaining time budget (ends at shutdown time minus 12 min): collection, Defender full scan, SFC/DISM/component-store, disk reliability + `Repair-Volume -Scan`, scheduled tasks, storage/duplicates; (3) AI patterns and briefing; (4) weekly report; (5) shutdown preparation: report files verified on disk, run state saved, unfinished operations recorded, lock released, then `shutdown.exe /s /t <seconds until 05:00>` (or 60 s if that time has passed). Windows performs the shutdown; Guardian never kills processes. If anything didn't finish it is listed under *incomplete* in the report. If the report cannot be verified, shutdown is withheld.

## Dashboard

Start: `.\src\powershell\Start-Dashboard.ps1` (Start Menu shortcut, or automatically at logon via the *Dashboard Bridge* task).
Development: `cd src\dashboard; npm run dev` (proxies `/api` to the bridge; set `GUARDIAN_DEV_HOST=127.0.0.1:5173` for the bridge).

Pages: **Overview** (health score, security, storage, RAM, CPU, battery, last/next scan, three trend charts with 7/30/90/all ranges, recent recommendations, action timeline, errors, security status, weekly AI briefing) · **Daily / Weekly** (current report, history, compare) · **Processes** (sortable table, filters for flagged / persistent / high-resource / recommended / blacklisted / whitelisted, click for the detail drawer with identity, resources, parent, startup, service, tasks, AI analysis, risk and confidence, exact stop and prevent-restart commands, consequences, action history) · **Files & Storage** · **Health** (CPU, RAM, disk, battery, Windows, Defender, firewall, network) · **Reports** (open, search, filter, compare, export, delete) · **Logs** · **Recommendations** · **Blacklist** · **Whitelist** · **Settings**. Dark, light and automatic (follow Windows) themes persist.

**Layout and interaction.** The sidebar collapses to an icon rail (remembered; on narrow screens it becomes a slide-in menu). The command bar shows the section, page and a one-line status ("2 items need attention", "Daily audit in progress"), the live bridge connection (Connected / Stale / Offline), when data was last refreshed, **Refresh status**, the AI indicator and the theme switch. Overview opens with the health verdict and five vital signs (each a link to the page that explains it), then what needs attention and recommendations (every row is a link), maintenance and recent activity (each entry opens its log line), and trends. Motion is short and CSS-only and is switched off by the operating system's "reduce motion" setting. The dashboard needs a Chromium-based browser (Edge or Chrome 123+), which the app-style launcher already uses.

## Configuration

`config/config.json` (created by the installer; merged over built-in defaults, so partial files are fine). Everything is editable in *Settings*; the bridge validates types, ranges and times.

```jsonc
{
  "schedule": { "daily": {"enabled": true, "time": "19:00"},
                "weekly": {"enabled": true, "day": "Saturday", "time": "02:00", "shutdownTime": "05:00", "shutdownEnabled": true} },
  "safety":   { "safeMode": true, "requireConfirmation": true, "autoKillBlacklisted": true, "automationPaused": false, "weeklyShutdown": true },
  "ai":       { "enabled": false, "model": "gemini-2.5-flash", "maxRequestsPerRun": 15, "maxProcessesPerRun": 10, "dailyTokenBudget": 200000 },
  "cleanup":  { "tempFiles": true, "crashDumps": true, "caches": true, "recycleBin": "never", "tempMinAgeDays": 2 },
  "storage":  { "drives": ["C:"], "excludedDirs": [], "protectedDirs": [], "minLargeFileMB": 500, "oldFileDays": 365, "duplicateScan": true, "duplicateMinMB": 50 },
  "thresholds": { "cpuPct": 50, "memoryMB": 1500, "diskFreeWarnPct": 15, "diskFreeCritPct": 8 },
  "retention": { "reportsDays": 0, "metricsDays": 0, "actionsDays": 0 }   // 0 = keep forever (nothing is ever auto-deleted without an explicit retention policy)
}
```

`safeMode`, `automationPaused`, `autoKillBlacklisted`, `weeklyShutdown` are the prominent **Safety** controls. Cleanup toggles can also live in `config/cleanup-policy.json` (overrides `config.cleanup`).

## Gemini setup

1. Create a key at <https://aistudio.google.com/apikey>.
2. Dashboard → *Settings → Gemini*: paste the key, **Save**, **Test connection**, switch **AI enabled** on. Choose a model and limits (requests per run, processes per run, daily token budget).
3. The key is passed to a PowerShell script over **stdin**, encrypted with Windows **DPAPI** (current user, this machine) into `data/secrets/gemini.dpapi` (ACL restricted to you; git-ignored). It is never returned by any API, never written to logs, never in frontend code, and is sent to Google only in an `x-goog-api-key` header.
4. Without a key, or when Gemini is unreachable, returns garbage, or rate-limits, Guardian logs it, marks AI unavailable for that run, and still produces a full report.

**What leaves your machine:** per process recommendation, a small JSON object (name, path with user profile masked, publisher, signature state, CPU/RAM numbers, persistence mechanism names, local flags). Weekly: aggregated numbers and recommendation titles. Never file contents, never command-line arguments, never documents. The dashboard labels every AI request.

## Process blacklist / whitelist

* **Blacklist** = "terminate this automatically on the daily run". Created only by you (*Blacklist* button in the process drawer, or *Blacklist* page). Each entry records reason, date, executable path (optional scoping), times terminated, last termination, enabled state; *Pause 7 days* sets `disabledUntil`. Terminations are skipped in Safe Mode, when automation is paused, or when auto-kill is off, and **never** touch protected/system processes (lsass, svchost, explorer, anything under `C:\Windows`, Defender, shells…). The PID is re-verified against the executable path immediately before termination (PID-reuse protection).
* **Whitelist** = "never flag or recommend this". Wins over the blacklist.
* **Ignored** = suppress a specific recommendation.
* Matching is by lower-case process name (no `.exe`), plus exact path if the entry has one.

## Reports & data

* `reports/daily/2026-10-03/report.json` + `report.html` (self-contained, scripts blocked by CSP) and `reports/weekly/2026-W40/…`. `data/latest/*.json` always holds the newest.
* History: `data/metrics/metrics.jsonl` (one point per run: CPU, RAM, disk, process counts, flagged, recommendations, actions, errors, startup, service failures, Defender, health score…), `data/actions/actions.jsonl` (every action: timestamp, category, severity, action, target, result, actor, reason, related recommendation, error).
* Retention is **off** (keep everything) unless you set `retention.*Days` > 0. Reports can be deleted explicitly from the dashboard.
* Formats are documented in `docs/DATA-CONTRACT.md` and validated by schemas in `src/shared/schemas/`.

## Security model

* Local-only: the bridge binds `127.0.0.1`, rejects foreign `Host` headers (DNS-rebinding), requires a custom header and same-origin `Origin` on every mutating request, emits no CORS headers, sets a strict CSP, caps request bodies, and serves static files with traversal protection.
* No arbitrary command execution: the bridge only launches **fixed scripts** with typed arguments (`execFile`, never a shell); the API key travels on stdin.
* Kill and recycle requests must match the latest Guardian snapshot **and** are re-validated by the PowerShell script against a protected list, the live process path, and protected directories.
* Files go to the **Recycle Bin only**, one file at a time; directories, reparse points, drive/profile roots, Windows, Program Files and user-protected directories are refused.
* Cleanup can only touch an allowlist of regenerable locations, only files, only older than your threshold, never following junctions.
* AI output is untrusted: strict schema validation, enum checks, markup stripping, command allowlist, retries then graceful degradation. AI cannot trigger execution.
* Secrets: DPAPI storage, redacted everywhere, `.gitignore` excludes `data/secrets`, `config/`, logs, reports.
* Least privilege: only Daily/Weekly request *Highest* (if you installed elevated); the dashboard bridge runs unelevated.

## Action Center and guided remediation

**Action Center** lists everything Guardian can fix: stale Defender definitions, a quick scan that has not run, a skipped integrity check, a firewall profile that is off, failing DNS, drifted scheduled tasks, persistent or unwanted processes, and review-worthy files. Each finding shows what it is, why it was flagged, the evidence, risk and confidence, every possible action with its exact effect, impact, reversibility, whether administrator permission is needed, and previous attempts with their outcomes. The same fixes appear where you find the problem: the process drawer, Files, Recommendations, Health and the schedule repair notice.

Every fix follows one flow: **plan** (Guardian re-checks the live target and shows exactly what will happen) -> **you confirm that exact plan** (plans expire after 10 minutes and work once) -> **execute** (PowerShell re-validates again, refuses protected targets, acts, then reads the system back to verify) -> **audit event** in the action log. Cancelling is logged too. Labels are specific: *Stop process*, *Disable restart*, *Disable scheduled task*, *Disable service*, *Recycle file*, *Update now*, *Run quick scan now*, *Run integrity check now*, *Enable firewall now*, *Flush DNS cache*, *Repair schedule*, *Uninstall cleanly with Revo*, *Fix with administrator permission*, plus **Investigate** and **Review manually** where no safe fix exists.

**What can run is a closed list.** `src/shared/action-catalog.json` is the only source of executable actions. The bridge never builds a command and AI output can never add or change an action (Gemini only explains). Parameters are validated against fixed patterns in both Node and PowerShell; there is no parameter that carries a command. Protected targets are refused even with confirmation: Windows and security processes and services (`Security.psm1` lists, mirrored in `protected.js` and kept identical by a test), anything under the Windows directory, Guardian's own processes and files, Windows and Laptop Guardian scheduled tasks, drivers, and for files the Windows, Program Files and ProgramData trees, the profile root, drive roots, Guardian data and your protected folders. Files only ever go to the Recycle Bin, one file at a time (no folders, links, wildcards or system files). A PID that was reused (different program, start time or path) is refused.

**Reversible fixes can be undone** from *Activity and undo*: startup entries use Windows' own StartupApproved flag, tasks are disabled not deleted, services record their previous start type. Stopping a process and Defender actions are not reversible and say so.

**Administrator actions** (services, Defender, firewall, DNS, integrity check, elevated tasks) show a clear *Windows will ask for permission* note. After you confirm, Guardian starts `Invoke-GuardianAction.ps1` through one fixed `Start-Process -Verb RunAs` for that single catalog action, which re-validates itself and writes its result file; declining the prompt changes nothing. Elevation never opens a general shell. Security note: the elevated script lives in this folder, so on a shared machine install Guardian under a location only administrators can write.

**Revo Uninstaller.** Guardian reads `C:\Users\Public\Desktop\Revo Uninstaller.lnk` without launching it, and only trusts it when it points at `RevoUnin.exe` under Program Files with a valid VS Revo Group signature. *Uninstall cleanly with Revo* is offered only for a clearly identified installed application (never security software, drivers, runtimes or system components, never arbitrary files). Revo opens its own window; Guardian does not claim success until *Check that it is gone* confirms the program is no longer installed. If Revo is missing or untrusted, Guardian says why and points to Windows Settings.

## Testing

```powershell
.\tests\Run-Tests.ps1                 # Pester (Pester 3.4+) + node --test bridge tests
.\tests\Run-Tests.ps1 -Integration    # adds install → real scan → bridge → uninstall end-to-end in a temp copy (~3 min)
```

Development checks (Node 22.18+; run `npm install` once at the repository root):

```powershell
npm run check          # TypeScript (strict), ESLint incl. react-hooks, ASCII-only dashboard source, Node tests
npm run build          # production dashboard build
npm run test:browser   # drives the built dashboard in Edge: all 12 pages, dark/light, 390 px, refresh/offline/scan states
node tests/browser/smoke.mjs --real   # same, read-only against this installation's real data
```

Tests use fixtures, fake PowerShell runners and isolated temp roots; none changes real tasks, shortcuts, reports or files.

Covers configuration, process detection and flagging, persistence mapping, policy/blacklist/whitelist and enforcement (including PID reuse, protected processes, safe mode), recommendation engine and store, file classification and walker robustness (vanishing files, junctions, locked files), duplicates, cleanup safety, report/metric generation and JSON schemas, HTML escaping, AI validation against a mock Gemini (malformed, bad enum, missing fields, dangerous commands, HTTP 500, no network, no key, budget), command allowlist, scheduling (19:00 daily, Saturday 02:00 weekly, edits applied), shutdown policy, failure injection (Defender/DISM/SFC failures and timeouts, event-log denied, firewall/network failures), interrupted runs, bridge security and API.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard won't open | `.\src\powershell\Start-Dashboard.ps1`; check Node ≥ 18 (`node -v`); port in use → change `bridge.port` in config.json |
| Shortcut shows "Node.js was not found" | Install Node.js 18+ (LTS) from nodejs.org and open Laptop Guardian again. Check with `.\src\powershell\Start-Dashboard.ps1 -Check` |
| "Port 7878 is in use by another program" | Close that program, or set `bridge.port` in `config\config.json` (1024-65535) and re-run the installer so the shortcuts and tasks agree |
| Window opens in a normal browser tab, not an app window | Neither Edge nor Chrome was found; install one, or ignore: it works the same |
| Dashboard shows "Bridge offline" | Click the shortcut again (it restarts the bridge). Details: `logs\launcher.log`, `logs\bridge-err.log` |
| Dashboard looks old after updating Laptop Guardian | Open it from a shortcut: a bridge older than its code is restarted automatically. Hard refresh with Ctrl+Shift+R if the page itself is cached |
| A "Waiting for first run" task | Normal until its first trigger (`0x41303`) |
| "A previous run did not finish" banner | The machine shut down or the run was killed mid-scan; the next run recovers by itself |
| "Dashboard not built" | `cd src\dashboard; npm ci; npm run build` (or re-run the installer) |
| SFC/DISM show `requires-admin` | Re-run installer with `-Elevate` (tasks run *Highest*) |
| Weekly run never started | Laptop must be logged in (locked is fine); enable wake timers; check *Task Scheduler → Task Scheduler Library → LaptopGuardian* history |
| Shutdown happened and you didn't want it | Settings → Safety → *Disable weekly shutdown*; to cancel a pending one run `shutdown /a` |
| AI "unavailable" | Settings → Test connection; see Logs (`ai:*` events): `http-401` bad key, `http-429` quota, `http-404` wrong model name |
| Missing data in a section | Look in the report's *Errors* and `logs\guardian-*.log`; one failing collector never aborts the run |
| Defender shows unavailable | A third-party antivirus may have disabled Defender cmdlets |

## Uninstall

```powershell
.\Uninstall-LaptopGuardian.ps1                # removes tasks, bridge process, Start Menu shortcut; keeps reports/data/config
.\Uninstall-LaptopGuardian.ps1 -RemoveData    # also deletes data/, reports/, logs/, config/ (incl. stored Gemini key) after confirmation
shutdown /a                                   # only if a shutdown is pending and you want to cancel it
```

## Known limitations

* `npm audit` reports 2 advisories (vite/esbuild) that affect only the Vite **dev server**, which Guardian never runs; the shipped dashboard is a static build served by the bridge. Upgrading needs Vite 8 (breaking), deferred.
* Tasks run only for a logged-on user (DPAPI + interactive session). A cold-powered-off laptop will not run the 02:00 task.
* Temperature is reported only when Windows exposes `MSAcpi_ThermalZoneTemperature` (often unavailable/admin-only).
* Without elevation: no SFC/DISM/`Repair-Volume`, no `Windows\Temp`/`Minidump` cleanup, process paths of some system services are unreadable (classified by name).
* The "Recycle Bin older than 30 days" policy is best-effort (Shell COM); `always` uses `Clear-RecycleBin`. Both are permanent.
* Duplicate detection covers files ≥ `duplicateMinMB` and hashes at most ~30 GB per run; results are display-only.
* Process "known application" recognition is a curated publisher list + signature check, not a reputation database. Treat classifications as hints.
* Process history in the drawer comes from reports' top-CPU/top-memory tables.
* Gemini results are advisory and can be wrong; they never execute anything.
* Tests use Pester 3.4 syntax (the version bundled with Windows).
