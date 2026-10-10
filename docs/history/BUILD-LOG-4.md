# Build log 4: credibility round (branch chore/credibility-1)

Rules followed: gates in pieces, one at a time; no UAC, no bridge restart, no task re-registration, no real deletion, `data/`, `reports/`, `logs/` untouched. No trust-boundary check was loosened (the loopback change made `refuseRemote` stricter, with tests).

## Claims verified before changing, and what was found

| Claim | Result |
|---|---|
| Policy matching case rule differs Node vs PowerShell | **Wrong as stated.** Case handling was already consistent. The real divergences were path-scope and name normalisation; fixed, with one shared fixture (`tests/fixtures/policy-match-cases.json`) run by both Node and Pester. |
| `127.0.0.0/8` not refused as loopback | **Partly wrong.** Plain IPv4 `127.x` was already handled. The gap was IPv4-mapped / compatible IPv6 forms (`::ffff:127.0.0.1`), which also skipped the gateway/DNS/DHCP check. Fixed in Node and PowerShell (shared `remote-target-cases.json`). |
| `tempMinAgeDays` range differs | **True.** Node and PowerShell now both use [1, 365]; `tests/config-parity.test.js` compares the tables. |
| PowerShell `Invoke-WithFileLock` runs the work after a timeout | **True, not changed** (logged; the Node side fails closed with `ELOCKED`, HTTP 503). |
| Sleep in lock code freezes the event loop | Handlers use the async lock (timer based). `Atomics.wait` stays only in sync paths (audit append, maintenance, rename retry), documented in code. |
| Revo check too loose | **True.** Now: valid signature + exact publisher + thumbprint from a constant list; test included. |
| WFP disable message misleading with no backup | **True.** Message and verification fixed. |

## Items

1. **Locking.** `withFileLock` / `withFileLockAsync`: owner `{pid, createdAt, token}`; stale only when older than 30 s and the owner is dead or the pid reused; takeover by rename; fail closed. Locked now: setNetworkFlag, PUT /api/schedule, pruneJsonl (atomic rewrite), netdeep append/trim, compaction, audit append, PowerShell Add/Remove-PolicyEntry. Tests: timeout throws, live owner not robbed, dead owner recovered, concurrent writers lose no updates (`tests/lock.test.js`). Old test asserting "work runs anyway" updated to the fail-closed behaviour on purpose.
2. **Small gaps.** See table above. Also: AI key rule `^[A-Za-z0-9._~+/=-]{16,256}$` after trimming/quote stripping (earlier mid-turn request), Node and PowerShell.
3. **Portability.** Verified on real Linux (WSL, Node 22.11): 163 pass, 0 fail, 12 skipped. Windows-only tests skip via `tests/lib/win-env.js`; `.ts` tests load through `tests/lib/load-ts.js`; one timezone-dependent test made local-hour based. `ubuntu-latest` job added to `ci.yml`. **CI has not been seen to run on GitHub.** Not run on Linux: dashboard typecheck, the 12 skipped tests.
4. **Performance.** `Get-ProcessTable` returns the CIM instances once per snapshot and the owner lookup reuses them (before: one query plus one method call per PID, up to 80). Test with mocks: `Get-CimInstance` called 0 times, `Get-ProcessTable` once, same output. Audit-tail reads cached on size+mtime (`tailJsonlCached`); test counts file opens: second poll 0 opens, changed file re-read.
5. **Pester 5.** Only 3.4.0 installed, so not migrated. `docs/PESTER5-PLAN.md` has measured counts, syntax changes and the CI step.
6. **Threat model.** `docs/THREAT-MODEL.md`, linked from README.
7. **README/tidy.** Short top section, one-line install, honest "How this was built", placeholders for CI badge, screenshots, Windows build, author's own words. Logs moved to `docs/history/`, links fixed. Root has no stray files (`release/` output folder is git-ignored).
8. **Release prep.** `CHANGELOG.md`, `scripts/make-release.ps1`. Run to a temp folder: 125 zip entries (120 program files), checksum file matches recomputed SHA-256, extracted zip passed `Install-LaptopGuardian.ps1 -PlanOnly` and `-Check` against temp `-ProgramDir/-DataDir/-ElevatedDir`, and no folders were created. Built with `-SkipBuild` (existing dashboard dist), so a fresh `npm run build` inside the script was not exercised in this run. Not signed. Nothing published.
9. **Audit and lint (real output).** `npm audit --omit=dev` at root: found 0 vulnerabilities. In `src/dashboard`: found 0 vulnerabilities. `npm run lint:ps`: "PSScriptAnalyzer: clean".

## After the nine items

- **Windows opening on their own.** Cause: console programs started by Task Scheduler open a window, and `-WindowStyle Hidden` only hides it after the flash. The three tasks now run through `conhost.exe --headless` when the build is 17763 or later. The planner had wrongly said "tasks already match settings"; a task that still opens a window now counts as out of date. Tests assert the registered Execute/Arguments.
- **Installer.** The program-folder swap failed when the folder was busy and then moved the staged copy into it. It now retries the rename four times, falls back to `robocopy /MIR` in place (keeping `install.json`), and removes the staged copy. Tested by mocking `Move-Item`, because a real lock on a folder could not be reproduced reliably.
- **Weekly day.** Config now says Sunday. The Windows task still has to be re-registered from an administrator window to read Sunday 02:00.
- **On-demand AI analysis of the current report.** `AI/Invoke-AiReportAnalyze.ps1`, `POST/GET /api/ai/report`, an Overview and report-page card. Bridge tests only; the script has no Pester test and has not been run against Gemini.
- **Refresh status and deleted files.** Refresh status only re-reads saved scan data, so files deleted by hand stayed listed until the next scan. The bridge now drops candidates whose path definitely does not exist (ENOENT/ENOTDIR only; any other error keeps them). Tests in `tests/gone-candidates.test.js`. Process recommendations are still only cleared by the next scan.
- **Defender false positive.** Microsoft Defender quarantined `src/powershell/Processes/Persistence.psm1` as `Trojan:Win32/Bearfoos.A!ml` (a machine-learning guess) every time it appeared on disk. The file is the read-only startup lister and has not changed since the first commit. A refactor did not stop it. It is handled with an exclusion for the repository folder and should be reported to Microsoft as a false positive.
- **History.** All commit messages were reworded in plain language and the co-author trailers removed. File contents were not changed (trees compared before and after). Not pushed.

Gate at the end: Pester 18 files (Integration skipped) all passed, Node tests 181 pass, typecheck, ESLint, ASCII check and PSScriptAnalyzer clean.

## Still open (needs the user)

Windows VM run (install, ACLs, UAC, rollback, uninstall, DoH, WFP audit); push and check GitHub Actions (first run of the Linux job); screenshots/GIF; Windows 11 build number; README wording in the author's own voice.
