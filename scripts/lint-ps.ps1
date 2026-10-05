#requires -Version 5.1
<#
.SYNOPSIS  Runs PSScriptAnalyzer over the PowerShell source with the repository settings. Exits 1 when anything is reported.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Import-Module PSScriptAnalyzer -ErrorAction Stop
$settings = Join-Path $root 'PSScriptAnalyzerSettings.psd1'
$found = @()
foreach ($p in 'src\powershell', 'Install-LaptopGuardian.ps1', 'Uninstall-LaptopGuardian.ps1') {
    $found += @(Invoke-ScriptAnalyzer -Path (Join-Path $root $p) -Recurse -Settings $settings)
}
foreach ($f in $found) { Write-Host ("{0}  {1}:{2}  {3}" -f $f.RuleName, ($f.ScriptPath.Substring($root.Length + 1)), $f.Line, $f.Message) }
if ($found.Count) { Write-Host "PSScriptAnalyzer: $($found.Count) finding(s)" -ForegroundColor Red; exit 1 }
Write-Host 'PSScriptAnalyzer: clean' -ForegroundColor Green
