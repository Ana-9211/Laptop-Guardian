# Build log 2

## Summary
_(written at the end of the run)_

## Start of run
- Continued from docs/OVERNIGHT-LOG.md. Install step 3b (trust boundary) was in the working tree; it was finished, gated and committed first. The installer rewrite (3c) and the overnight Batch 5 are carried over: Batch 5 is part of Batch E below, and the installer is Batch F at the end.
- Working order for this run: A (garbled text), B (deep clean), C (an action for every finding), D (network firewall layer), E (QoL), F (installer, carried over), final pass.

## Progress

### Order change
Batch F (installer) moves to right after A. Reason: the previous commit makes the Highest Daily/Weekly tasks refuse to run from a checkout, and the installer that fixes that does not exist yet, so the 19:00 audit would keep refusing until it does.

### A. Garbled text - committed
- Cause (reproduced): Windows PowerShell 5.1 writes stdout in the console code page (OEM) when redirected to a pipe, and the bridge decodes it as UTF-8. Any non-ASCII task name, process name or path became U+FFFD replacement characters, and characters the code page cannot hold (CJK, em dash) became question marks.
- Fix at the boundary: Common/Encoding.ps1 (dot-sourced first by Common\Load.ps1, so by every script the bridge starts) sets [Console]::OutputEncoding, InputEncoding and $OutputEncoding to UTF-8 without a byte-order mark; ps.js decodes stdout as UTF-8 explicitly and drops a BOM. Files written to disk were already UTF-8 without BOM, and the bridge already strips a BOM when reading.
- Tests: tests/ps-runner.test.js (real round trip of accented, Japanese and em dash text and an accented path through a script that loads the encoding setup), tests/encoding.test.js (a task with a non-ASCII name through /api/status, UTF-8 content type, no replacement characters), a Pester check that loading Load.ps1 leaves OutputEncoding utf-8 with no preamble, and a smoke check that the refresh area and status rail contain no replacement characters or mojibake patterns and read like "Updated ... Refresh status".
- Other glitches fixed: the "Updated x ago" label no longer changes the toolbar width as it ticks (fixed minimum width, tabular digits) and the refresh button keeps one width between "Refresh status" and "Refreshing..." (not on narrow screens, where only the icon shows). Tab panels now use minmax(0,1fr) so wide content cannot widen a page.
- Found while testing: tests/browser/find-overflow.mjs did not send the session token (it timed out); fixed, and added tests/browser/wide-elements.mjs.
- Gate: npm run check PASS (115); lint:ps clean; Pester one file per process PASS (15 of 15); smoke fixture PASS; smoke --real PASS.

### F. Installer, uninstaller, migration, rollback - committed (carried-over step 3c)
- Install/Installer.psm1: layout, program file list (no tests, docs, dashboard source, node_modules, config, data, reports, logs), plan as data, staged copy with swap (a failed update keeps the working copy), install.json writer, data migration (backup zip first, COPY never move, size-verified, migration.json marker, idempotent), rollback plan, legacy cleanup (only the four data folders of the recorded old folder, only after verification), uninstall leftovers.
- Install-LaptopGuardian.ps1 rewritten: -PlanOnly (prints, creates nothing), -ProgramDir/-DataDir/-ElevatedDir for temp-folder tests, -Rollback (refuses to run as administrator), -CleanupLegacy (asks first), elevated install into Program Files, ACL-verified %ProgramData% folder, data defaults via Tools/Initialize-Data.ps1 run from the installed copy, tasks registered from the installed copy, final trust check that warns if administrator tasks would refuse.
- Uninstall-LaptopGuardian.ps1 rewritten: installed copy removes tasks, bridge, shortcuts and the program folder (through a helper that waits for the script to end), -RemoveData deletes the data folder after confirmation, -PlanOnly, and a closing "Left in place on purpose" list (data, migration backup, administrators folder, old checkout). A checkout still works as before.
- Tests: tests/Installer.Tests.ps1 (17, all on temp folders). tests/Integration.Tests.ps1 setup step now uses Initialize-Data + Scheduler + Daily scan in a copy, because the real installer needs administrator rights.
- README quick start/where things go/migration/uninstall updated.
- NOT verified here (needs you): a real elevated install to Program Files, the real ACL on %ProgramData%, UAC relaunch with -Elevate, the real migration of your data, -Rollback against real tasks, and the uninstall helper deleting the program folder.
- Gate: npm run check PASS (115); lint:ps clean; Pester one file per process PASS (16 files incl. Installer, Integration).

### B. Behaviour-preserving deep clean - committed
- Bridge: server.js (896 lines) is now a thin wiring file. lib/context.js (shared state), lib/network-context.js, lib/http.js (error type, headers, body, static files, request pipeline), lib/constants.js, and routes/{status,reports,files,settings,ai,schedule,network,remediation}.js. Same routes in the same order, same checks.
- PowerShell: Remediation.psm1 and NetworkActions.psm1 keep their header and exports; each action family is a file under ActionsRemediation and ActionsNetworkActions that the module dot-sources. Same module scope on purpose, so every Pester mock and export is unchanged. Source-scan tests read all the pieces (Get-RemediationSource, Get-NetworkActionsSource).
- Dashboard: components/ui.tsx became components/ui/{icons,display,controls,feedback,overlay,actions,table}.tsx with an index barrel (no import changed). Settings.tsx is the page plus components/settings/ (fields and six cards). NetworkParts.tsx re-exports components/network/*. The Action Center findings and history are one shared query (state/findings.ts) used by Action Center, Health, Recommendations and Network Guard.
- Dead code: no exported function was entirely unused (checked with a script); the unused http.js exports were removed. Over-exported helpers were left alone.
- docs/ARCHITECTURE.md written: folders, module map, request path, how to add an action or an endpoint, tests.
- Test updates caused by moved code: source-scan tests follow the files; the Launcher/Scheduling checks point at the new files.
- Gate: npm run check 115 PASS; tsc and eslint clean; lint:ps clean; Pester one file per process PASS (Installer, Launcher, Scheduling re-run after fixing paths); smoke fixture and --real PASS.

## Questions for morning

## Still open
