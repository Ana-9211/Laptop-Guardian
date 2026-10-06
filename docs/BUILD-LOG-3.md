# Build log 3

## Summary
Everything asked for in this run is implemented, gated and merged into master, except what is listed under "Still open". The last gate on the merged result: npm run check 154 pass; lint:ps clean; Pester 18 files pass (Integration skipped on purpose); fixture smoke (including the links and guidance sections) pass; --real smoke pass. Two gate runs were killed for low memory earlier; the work was parked on wip branches and finished after memory was freed.

What was added: the Batch D gate fix and merge (step 0); a locale-independent connection sampler for Deep Network Guard with a tested netstat fallback; encrypted-DNS (DoH) actions with undo and DNS findings; retention and compaction of metrics, audit log and network events with byte-capped reads; links, filters in the address bar, remembered tabs and sort, and a Back target for drawers; first-run checklist, score explanation (now with a trend from stored reasons), what-changed card, Safe Mode dry run, undo in toasts, CSV export; README and DATA-CONTRACT updates.

## Rules for this run
Gate in pieces, one at a time: npm run check, npm run lint:ps, Pester one file per process (Integration skipped), then the --real smoke. A killed step is retried once, alone. Commits per step. Nothing was run that triggers UAC, restarts the bridge, re-registers tasks, deletes real files or touches data/, reports/ or logs/ of this checkout.

## Progress

### Step 0. Batch D gate and merge
- Renamed the automatic variable $profile in Network/Guard.psm1 (now $userProfile). lint:ps clean; Pester NetworkActions (25) and Remediation (67) pass; the full Pester suite passed (every file except Integration, which this run skips on purpose). The Batch D gate is therefore green. Committed as a new commit (2299a6f), not an amend, then wip/batch-d was merged into master with a normal merge commit (2de89bc).

### Step 1. Finish Batch D - done
- Deep Network Guard sampler: Network/Stream-Connections.ps1 (one long-lived process printing a JSON line per sample from Get-NetTCPConnection and Get-NetUDPEndpoint, ends by itself when the bridge is gone), lib/netsampler.js (restart with 1, 2, 4, 8, 16 s backoff, gives up after 5 restarts in 5 minutes, always killed on stop, runaway lines dropped), ps.stream() in ps.js. netdeep uses a fresh sample, otherwise netstat (parseNetstat kept, tested). tests/netsampler.test.js.
- DNS: the DNS cache view and flush button already existed. New dns.doh-enable / dns.doh-restore (fixed provider table: Cloudflare, Google, Quad9; no address or URL from input; previous servers saved in the administrators-only backups folder; undo restores exactly; DoH entries Guardian added are removed again), snapshot dnsConfig, findings for unfamiliar DNS servers, public resolvers without encryption and programs that appear to use their own DoH (with the plain statement that this bypasses hosts blocking), and a DoH card in Network Guard. tests/Doh.Tests.ps1 and netposture tests.

### Step 1b. File growth - done
lib/compact.js (streamed, under the shared file lock, strict: refuses without the lock, atomic replace, unreadable rows kept), lib/maintenance.js (daily and 90 s after start, never during a scan). Metrics: 180 days raw, then daily summaries. Audit log: 90 days raw, older rows moved to data/actions/archive/actions-YYYY-MM.jsonl, nothing deleted, daily summaries. Deep events: summarised per expired day, and the size cap keeps only the newest bytes by reading just that tail. PowerShell Add-JsonLine now appends under the same lock; the bridge audit append too. /api/metrics and /api/overview read a byte-capped tail plus summaries. tests/compact.test.js (large fixtures: 400 days x 50 rows, a 20 MB metrics file, 100k rows through the bridge).

### Step 2. Navigation - done
state/pageState.ts (tabs and filters live in the address and in browser storage), components/Linked.tsx (risk chips and badges as links), Stat tiles with href, chart points open that day's report, DataTable remembers its sort (persistKey), Drawer back target (useBack). Pages covered: Overview, Action Center, Recommendations, Processes, Files, Health, Network Guard, Logs, Reports, Daily, Weekly. Smoke checks click a stat tile, a risk chip, a tab (and refresh), a vital tile, a count badge, a chart point, a row, and Back.

### Step 3. Batch E - done
First-run checklist (/api/setup), what changed (/api/changes), Safe Mode dry run (/api/safemode/preview), undo toasts (recommendation status, policy lists, ignored list, file ignore), persisted tabs/filters/sort, CSV export (Action Center history, Logs, Processes, Network connections; formula guard), score explanation with points per factor. healthReasons are now stored in each metrics row from PowerShell (Reports.psm1, schema updated, Pester test) and the explanation shows the most frequent deductions over the last runs (healthTrend.ts, tested). README and DATA-CONTRACT updated.

### Step 4. Pester 5 - skipped
Only Pester 3.4.0 is installed. Nothing was installed. CI stays on 3.x.

## Questions for morning
- Retention windows (180 days metrics, 90 days audit rows) are constants, not settings. Say if you want them in Settings. Chosen as the safer option: nothing in the audit log is ever deleted.
- file.delete-permanent exists in the catalog and is offered through the confirmation flow only when something asks for it; there is no button for it on the Files page, because "Recycle" is the safer default there. Say if you want one for items already in the Recycle Bin.
- The DoH providers are fixed to three. Say if you want others added to the table.

## Still open
Skipped or partial:
- Per-program summary and timeline views in Network Guard, and a CSV export of the firewall connection log (the connection table and the log's JSON export exist).
- Not every stat tile links: purely informational ones (core count, pagefile size, battery charge) have no useful target.
- Pester 5 migration (not installed here).
- Archived audit rows are not searchable from the dashboard (the Logs page reads the live 90 days).
- The old Revo flow is guided, not automatic: this Revo 2.7 has no command line.

Not verifiable here without administrator rights, a real install or your machine:
- The real Program Files install: ACLs on the program folder and on %ProgramData%, the UAC relaunch, the final trust check, the uninstall helper deleting the program folder, migration of your real data, -Rollback and -CleanupLegacy against real tasks.
- Firewall connection logging (auditpol) and reading Security events 5156/5157/5152/5158.
- DoH registration and interface DNS changes, and their undo.
- The Windows Update search, Defender real-time enable, service stop/start, Clean temp and Empty Recycle Bin against real Windows.
- GitHub Actions workflow (no GitHub access from here).
- The output of the new sampler on this machine.

Manual steps for you, in this order:
1. Review the merges (git log --merges: Batch D, steps 1 to 3, health reasons).
2. Restart the bridge from a fresh window (Open-LaptopGuardian.cmd after closing the old dashboard window) so the new code runs.
3. Check the sampler: run  powershell -NoProfile -File src\powershell\Network\Stream-Connections.ps1 -IntervalSec 2  in a normal window for a few seconds. You should see one JSON line every 2 seconds with TCP and UDP rows and a names map. Stop it with Ctrl+C.
4. Real elevated install: .\Install-LaptopGuardian.ps1 -PlanOnly first, then -Elevate. Check %ProgramFiles%\LaptopGuardian, %ProgramData%\LaptopGuardian (administrators only) and the Daily/Weekly tasks.
5. Approve the UAC repair of the scheduled tasks if the dashboard shows "Repair with administrator permission" (until an installed copy exists, Daily and Weekly refuse to run from this checkout).
6. Try one real Revo uninstall of an app you do not need: Action Center, Uninstall cleanly with Revo, then Check that it is gone, then Look for leftovers.
7. Try the real DoH change on one interface (Network Guard, DNS), then Restore previous, and confirm the DNS servers are back as before.
8. Optionally turn on firewall connection logging and look at the Connection log.

## Interrupted gate (work on branch wip/steps-1-3, NOT merged)
Steps 1, 1b, 2 and 3 are implemented. The Pester step of their gate was killed by the system for low memory after Core, Correctness and Doh had passed; per the memory note it was not restarted. Verified before the kill: npm run check 147 pass (before the guidance and csv tests were added), lint:ps clean, fixture smoke pass for the link checks. NOT run: the rest of the Pester suite, npm run check with the new guidance.test.js and csv.test.js, the final fixture smoke (guidance section) and the --real smoke. Step 3 PowerShell part (healthReasons stored in metrics rows) is not done. Step 4: Pester 5 is not installed (only 3.4.0), nothing was installed; CI stays on 3.x.
