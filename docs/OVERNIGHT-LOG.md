# Overnight log

## Summary
_(written at the end of the run)_

## Start of run
- Leftover processes checked. The only Laptop Guardian processes were the live bridge (node, started 2026-10-05 23:15, left alone) and the current gate run started in this session (not stale). Nothing was stopped.
- `git status`: Batch 4 was in the working tree, uncommitted (dashboard files, `tests/browser/smoke.mjs`, `tests/fixtures/make-fixtures.js`, `Network/Guard.psm1`, `server.js`). Nothing discarded.

## Progress
### 1. Batch 4 (UI/UX and accessibility) - committed
- Finished: ActionFlow rewrite (sequence guards, no close while starting, resilient polling, background tracker with indicator, exact action text before the UAC prompt); Network Guard fixes; ui.tsx accessibility fixes; tab panels (aria-controls, role=tabpanel) on **every** page with tabs; keyboard and table view for bar charts; control contrast token; mobile nav focus and inert; copy and label fixes; error states; Action Center refresh; Logs deep links; ignored-processes list; unsaved-changes guard on Settings; request timeout and GET coalescing.
- Tooltip audit: the only critical text that lived only in a tooltip was the "how to restart the bridge" advice; it is now a visible banner when the bridge is offline. All other tooltips repeat visible text or are optional detail.
- Chart empty-state text is a prop; set for the network trend, the weekly health chart and the bar charts.
- Gate (run in pieces, one at a time): npm run check = PASS (typecheck, eslint, ascii, 108 node tests); Pester one file per process = PASS (all 14 files, Integration included); smoke --real = PASS; fixture smoke = PASS.
- Skipped: none from the list.

### 2. Batch 6 (CI and tooling) - committed
- Finished: .github/workflows/ci.yml (windows-latest; Node 22 and 24: npm ci, npm run check, npm audit --omit=dev for root and dashboard, build; a PowerShell job: PSScriptAnalyzer then Pester one file per process); PSScriptAnalyzerSettings.psd1 and scripts/lint-ps.ps1 (npm run lint:ps; clean after fixing 4 real findings: unused variables, and Clean-AiText renamed ConvertTo-CleanAiText); check:ascii now covers src/powershell, src/bridge and the installers; vite dev proxy no longer rewrites Origin; errorCount now includes failed and timed-out phases (Get-RunProblemCount, tested); .nvmrc already present; README testing section and dev-token note.
- Pester 5 migration: **not done on purpose** (see Questions). CI pins Pester 3.x through Run-Tests.ps1 (Import-Module Pester -MaximumVersion 3.99.99).
- PSScriptAnalyzer 1.25.0 was installed for the current user to run the lint (Install-Module -Scope CurrentUser). 254 findings before settings; the excluded rules are documented in the settings file.
- Gate: npm run check PASS (108 node tests); Pester one file per process PASS (14 of 14 incl. Integration); smoke --real PASS.
- Not verifiable here: the GitHub Actions workflow itself has never run (no GitHub access).

### 3a. Install split: program, data and elevated folders - committed
- Code root and data root are separate concepts now: Get-GuardianCodeRoot (always from the module's own location), Get-GuardianDataRoot (from install.json for an installed copy, which the environment cannot redirect; from GUARDIAN_ROOT or the checkout otherwise), Get-GuardianRoots (both, used by the stop/recycle/block protections). Elevated results, audit lines and hosts backups have their own paths (ActionResults, ElevatedAudit, ElevatedBackups) that point into the administrators-only folder of an installed copy and stay where they were in a checkout.
- Bridge: reads install.json itself, serves the dashboard and PowerShell from the program folder, keeps data in the data folder, merges the administrators-only audit file into the log, reads elevated results from the administrators-only folder, reports both roots in /api/ping, and treats both folders as protected.
- Launcher: finds config, logs, bridge.json and the app profile in the data folder.
- Default bridge port: 7879 for a development checkout, 7878 for an installed copy (PowerShell, Node, launcher, vite dev proxy).
- Tests: tests/install.test.js (readInstall, port, protected roots, merged audit and results dir) and an installed-copy Describe in tests/Correctness.Tests.ps1 that loads a copy of the PowerShell tree from a temp program folder in a child process.
- Gate: npm run check PASS (112 node tests); PSScriptAnalyzer clean; Pester one file per process PASS (14 of 14); smoke --real PASS.
- Note for you: because a checkout now defaults to port 7879, the next restart of the live bridge from this checkout will listen on 7879 unless config.json sets bridge.port. The launcher follows the same rule, so the shortcut still works.

## Questions for morning
- Pester 5: the suites rely on Pester 3 behaviour (legacy Should syntax, top-level setup shared with It blocks, Mock -ModuleName by name). A migration touches about 400 tests and I only have Pester 3.4 here to verify, so I kept CI on 3.x. Do you want the migration as its own piece of work later?
- CI: the Pester job excludes Integration (it registers real scheduled tasks). Several other suites start a real node bridge; they should work on a runner, but the first CI run may show environment-specific failures I cannot see from here.
_(none yet)_

## Still open
_(written at the end of the run)_
