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
    $r = Invoke-Pester -Script $f.FullName -PassThru
    $failed += $r.FailedCount
    "{0}: {1} passed, {2} failed" -f $f.Name, $r.PassedCount, $r.FailedCount | Out-Host
}
if (-not $SkipNode -and (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "`n=== bridge.test.js (node --test) ===" -ForegroundColor Cyan
    & node --test (Join-Path $here 'bridge.test.js')
    if ($LASTEXITCODE -ne 0) { $failed++ }
}
if ($failed -gt 0) { Write-Host "`nFAILED: $failed" -ForegroundColor Red; exit 1 } else { Write-Host "`nALL TESTS PASSED" -ForegroundColor Green; exit 0 }
