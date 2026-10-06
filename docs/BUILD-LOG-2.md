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

## Questions for morning

## Still open
