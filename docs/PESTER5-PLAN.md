# Plan: moving the PowerShell tests from Pester 3.4 to Pester 5

Status: **not started on purpose.** Only Pester 3.4.0 (the version Windows ships) is installed on the development laptop, and installing Pester 5 system-wide
was not wanted. A migration that cannot be run is a migration that cannot be trusted, so the suites stay on 3.x and CI stays on 3.x until someone with Pester 5
installed can run each converted file. This page is the exact work list, with the numbers measured from the repository on 2026-10-07.

## What is there today

| | |
|---|---|
| Test files | 19 (`tests/*.Tests.ps1`), plus `tests/Helpers.ps1` |
| `Describe` / `It` blocks | 100 / 412 |
| `Should <Operator>` assertions in the old form | 1109 (`Be` 706, `Match` 232, `Not BeNullOrEmpty` 41, `BeNullOrEmpty` 34, `Not Match` 34, `Throw` 22, `BeGreaterThan` 19, `Not Throw` 11, `Not Be` 6, `BeLessThan` 4) |
| `Mock -ModuleName` | 239 |
| `Assert-MockCalled` | 5 |
| `$global:T_*` variables used to pass data into mocks | about 200 |
| `BeforeEach` | 4 (no `BeforeAll`, no `Context`, no `TestDrive`) |
| Runner | `tests/Run-Tests.ps1`: one PowerShell process per file, `Invoke-Pester -Script`, pinned with `-MaximumVersion 3.99.99` |

## The syntax changes, in order of how much they touch

1. **Assertions get dashes.** `| Should Be 3` becomes `| Should -Be 3`; `Should Not BeNullOrEmpty` becomes `Should -Not -BeNullOrEmpty`; `Should Throw` becomes
   `Should -Throw`. Pester 5 still accepts the old form with a deprecation warning only up to a point, so convert all 1109. A regex does most of it
   (`\|\s*Should\s+(Not\s+)?([A-Z]\w+)` to `| Should -$1$2` with the `Not` turned into `-Not`), then review the diff: `Should Throw` with a message argument
   and `Should Match` with a regex need a look, and `Should Not Throw` blocks are `{ ... } | Should -Not -Throw`.
2. **Discovery and run are separate phases.** In Pester 5 the body of `Describe` runs first to *discover* the tests and the `It` bodies run later, in a
   different scope. So:
   * variables assigned in a `Describe` body and read inside `It` (very common here: `$cfg`, `$root`, `$victimExe`, `$fx`, `$goodTp`) must be set in
     `BeforeAll { ... }` (or passed with `-ForEach`/`-TestCases`);
   * helper functions defined in a `Describe` body or at the top of the file (`New-FakeSource`, `New-TempDir`, `Run`, `First`, `Check`, ...) are not visible in
     `It` unless they are defined in `BeforeAll`;
   * code at the top of a test file that does real work (`New-TestRoot; Import-Guardian; Initialize-GuardianDirectories`, `Import-Module ...Remediation.psm1`)
     runs during discovery; it moves into `BeforeAll` at the top of the file, and `Remove-TestRoot $root` at the bottom moves into `AfterAll`.
   * `. "$PSScriptRoot\Helpers.ps1"` also moves into `BeforeAll` (dot-sourcing in discovery would not reach the `It` scope).
3. **Mocks are scoped to the block that defines them** (`It`, `Context`, `Describe`) in Pester 5, which is what the current tests wish they had (several
   comments in the suites explain workarounds for Pester 3 mocks leaking between `It` blocks and a `Describe` per mock set). Most workarounds can stay
   unchanged. Two things to re-check: `Mock -ModuleName X Name { ... }` bodies run in the module's scope, so the `$global:T_*` pattern keeps working but is
   better replaced with `$script:` variables set in `BeforeAll`; and `Mock` of a command with typed parameters still binds like the original
   (`Invoke-CimMethod -InputObject` needed a thin wrapper to be mocked with a plain object, and still will).
4. **`Assert-MockCalled` becomes `Should -Invoke`.** Five uses: `Assert-MockCalled -ModuleName Guard Get-ProcessTable -Times 1 -Exactly` becomes
   `Should -Invoke -ModuleName Guard Get-ProcessTable -Times 1 -Exactly`.
5. **`InModuleScope` / calling module-private functions.** The tests call private functions with `& (Get-Module Remediation) { ... }`; that still works.
6. **Runner.** `Invoke-Pester -Script <file> -PassThru` becomes
   `Invoke-Pester -Configuration (New-PesterConfiguration -Hashtable @{ Run = @{ Path = '<file>'; PassThru = $true }; Output = @{ Verbosity = 'Detailed' } })`,
   and the pin `-MaximumVersion 3.99.99` becomes `-MinimumVersion 5.5 -MaximumVersion 5.99.99`. One process per file stays (module mocks still collide
   when files import the same module from different temp roots). `Run-Tests.ps1` also greps the output (`Passed:`/`Failed:`); Pester 5 prints different
   summary lines, so read `$r.FailedCount` from the result object instead.
7. **`Describe` blocks that only hold shared setup** (the `$root = New-TestRoot ...` lines at file scope) are the riskiest part: do those files first.

## Suggested order

1. Install Pester 5 for the current user only (`Install-Module Pester -MinimumVersion 5.5 -Scope CurrentUser -Force -SkipPublisherCheck`), leave 3.4 alone, and
   keep the old runner working next to a new `tests/Run-Tests5.ps1`.
2. Convert the smallest files first and run each one: `WfpEvents`, `Doh`, `Reports`, `Core`, `Processes`, then `Policy`, `AI`, `Files`, `Failures`.
3. Then the module-mock heavy files: `NetworkActions`, `Remediation`, `RemediationMore`, `InstallSecurity`, `Installer`, `Launcher`, `Scheduling`, `Security`,
   `Correctness`, `Integration` (slow; keep it behind `-Integration`).
4. When every file passes under Pester 5 and the file count and `It` count match (19 and 412 plus any new ones), switch `Run-Tests.ps1` and CI, delete
   the old runner, and update the README ("Tests use Pester 3.4 syntax") and `docs/ARCHITECTURE.md`.

## CI step to add once the suites are converted

```yaml
      - name: Pester 5 (one file per process)
        shell: powershell
        run: |
          Install-Module Pester -MinimumVersion 5.5 -Scope CurrentUser -Force -SkipPublisherCheck
          ./tests/Run-Tests.ps1 -SkipNode
```

(`windows-latest` images already carry a newer Pester next to 3.4; the runner imports a 5.x explicitly so the choice does not depend on image contents.)
Until then the existing step keeps running the 3.x suites:

```yaml
      - name: Pester (one file per process)
        shell: powershell
        run: ./tests/Run-Tests.ps1 -SkipNode
```

## Why not just do it

* A syntax conversion without the ability to run the result silently turns real tests into tests that pass for the wrong reason (an `It` that no longer
  runs, a variable that is now `$null` in the run phase and makes a `Should -Be $null` accidentally true).
* The Pester 3 suites are green today (19 files); that is worth more than the newer syntax.
