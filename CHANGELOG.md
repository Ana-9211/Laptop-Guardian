# Changelog

All notable changes to Laptop Guardian. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [Semantic Versioning](https://semver.org/).
Nothing here has been published or tagged yet. "Verified" means checked by the automated suites on the author's machine; the items that need a real
installed Windows machine are listed in the README ("How this was built") and in `docs/history/BUILD-LOG-3.md` and `BUILD-LOG-4.md`.

## [Unreleased] (the 1.1.0 line)

### Added
- **Installer layout.** Program files in `%ProgramFiles%\LaptopGuardian`, your data in `%LOCALAPPDATA%\LaptopGuardian`, administrator results and audit lines in an
  administrators-only `%ProgramData%\LaptopGuardian`; `install.json` ties them together. `-Check` (read-only self-check), `-PlanOnly`, `-Rollback`,
  `-CleanupLegacy`, a backup zip before data is copied from an old checkout, an uninstaller that says what it leaves behind.
- **Trust boundary for administrator runs.** Daily/Weekly with highest privileges and the elevated action helper refuse to run from a folder ordinary programs
  can edit; the user-editable config, policy and ignore files are clamped when elevated; lookalike Windows process names no longer borrow trust.
- **Action Center for every finding.** A closed catalog of 49 typed actions (scans, setup steps, Defender, Windows Update search, services, cleanup,
  permanent delete of Recycle Bin items with a typed confirmation, guided Revo uninstall, encrypted DNS) with plan, confirm, execute, verify and audit for each;
  every status item and finding has a button or an explicit reason it has none.
- **Network Guard.** Firewall posture audit and score, new-listener, first-seen and beaconing detection, a per-program view and timeline, Windows Filtering
  Platform connection log (events 5156, 5157, 5152, 5158) with CSV export, DNS findings, encrypted DNS (DoH) with undo, a locale-independent connection sampler.
- **Everyday use.** First-run checklist, score explanation with a trend, what changed since the last run, Safe Mode dry-run preview, undo in toasts, filters and
  sorting kept in the address and the browser, links from tiles, chips, badges and chart points, CSV export, a Diagnostics page with a masked copy.
- **Data hygiene.** Metrics and audit rows are rolled into daily summaries and monthly archives (windows are settings, 30-730 days); nothing in the audit log is deleted.
- **Docs.** Architecture, threat model, data contract, Pester 5 plan.
- **CI.** A Linux job (type check, lint, ASCII check, Node tests) next to the Windows jobs. Not yet seen to run on GitHub.

### Changed
- File locks fail closed and never take a lock from a live owner; every shared-file write takes the lock.
- Policy matching, number ranges and loopback rules are the same in Node and PowerShell, each checked against one shared fixture or table.
- The Revo Uninstaller signature check needs the exact signer name and a known certificate thumbprint.
- The Gemini API key check accepts the newer dotted keys and pasted whitespace or quotes.
- The default bridge port is 7878 for an installed copy and 7879 for a development checkout.

### Fixed
- Garbled text in the status area (PowerShell wrote the console code page into the pipe; everything is UTF-8 now).
- Every Settings save failed with HTTP 400; a failed scan was recorded as complete; quarantined Defender detections counted as active threats; the weekly
  run's status ignored failed phases; ISO week numbers at year boundaries; several races in shared files; an IPv4-mapped loopback address could be blocked.

### Security
- Session token, `Sec-Fetch-Site`, Host and Origin checks, CORP/COOP headers, absolute system paths, a PowerShell concurrency cap; details in `docs/THREAT-MODEL.md`.

## Earlier

The history before the 1.1.0 work is in git (`git log`); it is not itemised here.
