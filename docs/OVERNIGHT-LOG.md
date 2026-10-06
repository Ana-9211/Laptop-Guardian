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

### 3b. Trust boundary for administrator runs - committed
- New module src/powershell/Install/InstallSecurity.psm1 (loaded by Common\Load.ps1): Test-InstallTrusted / Assert-ElevatedCodeTrusted refuse administrator work unless the copy is an installed one (install.json) and every folder it runs from (program folder and parents, the PowerShell tree, the catalog, install.json) can be changed only by SYSTEM, Administrators and TrustedInstaller (owner checked too). The message says exactly what to do (run Install-LaptopGuardian.ps1 from an administrator PowerShell). There is no switch or environment variable that overrides it (a test checks that).
- Wired into: Daily.ps1 and Weekly.ps1 (when elevated), Invoke-GuardianAction.ps1 (Execute), Request-ElevatedAction.ps1 (before the UAC prompt), Scheduler.ps1 (Set-GuardianTask for Highest tasks, and Request-ElevatedRegister). Standard-user runs are never blocked.
- New-ProtectedDirectory creates the administrators-only folder with explicit rules (SYSTEM and Administrators full control, Users read-only, no inheritance) and reads the ACL back, throwing loudly if it is not exactly that (owner, inheritance, any extra writer). It writes permissions with [IO.Directory]::SetAccessControl.
- Untrusted inputs in elevated runs: Limit-ConfigForElevation (clamps every numeric setting to the dashboard's ranges, coerces switches, validates drive letters and folder entries, never uses a config path as a delete target), Get-SafeIgnoredIds (only 12-hex ids), and the blacklist only ends a program when running as administrator if the entry names its exact executable path.
- Dashboard: an attention item "Administrator tasks are blocked" appears for three days after a refusal. Defender attention no longer treats failed-action statuses (102 to 106) as handled.
- Tests: tests/InstallSecurity.Tests.ps1 (15), a Policy test, a status test.
- Gate: npm run check PASS (113); PSScriptAnalyzer clean; Pester one file per process PASS (15 of 15); smoke --real PASS.
- **Important for you**: your existing Daily and Weekly tasks are registered as Highest and point at this checkout. From now on they will refuse to run (they log install:untrusted-refused and the dashboard shows a red item) until Install-LaptopGuardian.ps1 is run elevated. The installer itself (3c) is NOT written yet; see below.
- Not verifiable here: the real ACL of Program Files; New-ProtectedDirectory was tested on temp folders with a non-elevated owner.

### 3c. Installer, uninstaller, migration - NOT DONE (carried over)
A newer instruction (docs/BUILD-LOG-2.md) replaced the rest of this run's order, so the installer rewrite (program/data/ProgramData install, plan-only mode, backup zip, -Rollback, -CleanupLegacy, uninstaller messages) and Batch 5 were not started here. Batch 5's four items are folded into Batch E of BUILD-LOG-2.md. The installer work is listed as Batch F there.

## Questions for morning
- Pester 5: the suites rely on Pester 3 behaviour (legacy Should syntax, top-level setup shared with It blocks, Mock -ModuleName by name). A migration touches about 400 tests and I only have Pester 3.4 here to verify, so I kept CI on 3.x. Do you want the migration as its own piece of work later?
- CI: the Pester job excludes Integration (it registers real scheduled tasks). Several other suites start a real node bridge; they should work on a runner, but the first CI run may show environment-specific failures I cannot see from here.
_(none yet)_

## Still open
_(written at the end of the run)_
