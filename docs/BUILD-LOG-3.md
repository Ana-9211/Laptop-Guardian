# Build log 3

## Summary
_(written at the end of the run)_

## Rules for this run
Gate in pieces, one at a time: npm run check, npm run lint:ps, Pester one file per process (Integration skipped), then the --real smoke. A killed step is retried once, alone. Commits per step. Nothing was run that triggers UAC, restarts the bridge, re-registers tasks, deletes real files or touches data/, reports/ or logs/ of this checkout.

## Progress

### Step 0. Batch D gate and merge
- Renamed the automatic variable $profile in Network/Guard.psm1 (now $userProfile). lint:ps clean; Pester NetworkActions (25) and Remediation (67) pass; the full Pester suite passed (every file except Integration, which this run skips on purpose). The Batch D gate is therefore green. Committed as a new commit (2299a6f), not an amend, then wip/batch-d was merged into master with a normal merge commit (2de89bc).

## Questions for morning
- None yet.

## Still open
_(written at the end of the run)_

## Interrupted gate (work on branch wip/steps-1-3, NOT merged)
Steps 1, 1b, 2 and 3 are implemented. The Pester step of their gate was killed by the system for low memory after Core, Correctness and Doh had passed; per the memory note it was not restarted. Verified before the kill: npm run check 147 pass (before the guidance and csv tests were added), lint:ps clean, fixture smoke pass for the link checks. NOT run: the rest of the Pester suite, npm run check with the new guidance.test.js and csv.test.js, the final fixture smoke (guidance section) and the --real smoke. Step 3 PowerShell part (healthReasons stored in metrics rows) is not done. Step 4: Pester 5 is not installed (only 3.4.0), nothing was installed; CI stays on 3.x.
