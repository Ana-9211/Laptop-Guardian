#requires -Version 5.1
<# Runs the whole suite: PowerShell (Pester 3+) then Node bridge tests. -Integration adds the slow end-to-end test. -Filter limits PowerShell test files by name. #>
[CmdletBinding()]
param([switch]$Integration, [string]$Filter = '*', [switch]$SkipNode)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
Import-Module Pester -ErrorAction Stop
$files = @(Get-ChildItem $here -Filter "$Filter.Tests.ps1" | Where-Object { $Integration -or $_.Name -ne 'Integration.Tests.ps1' })
$failed = 0
foreach ($f in $files) {
    Write-Host "`n=== $($f.Name) ===" -ForegroundColor Cyan
    # Every file runs in its own PowerShell process: the suites import the modules from different temp roots, and Pester 3 cannot mock a module that is loaded twice in one session.
    $cmd = "Import-Module Pester; `$r = Invoke-Pester -Script '$($f.FullName)' -PassThru; exit [int]`$r.FailedCount"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $cmd
    $n = $LASTEXITCODE
    $failed += $n
    "{0}: {1}" -f $f.Name, $(if ($n -eq 0) { 'all passed' } else { "$n failed" }) | Out-Host
}
if (-not $SkipNode -and (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "`n=== bridge.test.js (node --test) ===" -ForegroundColor Cyan
    & node --test (Join-Path $here 'bridge.test.js') (Join-Path $here 'status.test.js') (Join-Path $here 'schedule.test.js') (Join-Path $here 'state.test.js') (Join-Path $here 'remediation.test.js') (Join-Path $here 'network.test.js') (Join-Path $here 'ps-runner.test.js')
    if ($LASTEXITCODE -ne 0) { $failed++ }
}
if ($failed -gt 0) { Write-Host "`nFAILED: $failed" -ForegroundColor Red; exit 1 } else { Write-Host "`nALL TESTS PASSED" -ForegroundColor Green; exit 0 }
