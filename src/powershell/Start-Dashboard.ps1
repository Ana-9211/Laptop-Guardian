#requires -Version 5.1
<#
.SYNOPSIS  One-click launcher: starts the local dashboard bridge (127.0.0.1 only) if needed and opens it in an app-style window.
.PARAMETER NoBrowser  Start/verify the bridge but do not open a window.
.PARAMETER Gui        Report failures in a message box (used by the Start Menu / Desktop shortcuts, which have no console).
.PARAMETER Check      Only print a diagnostic summary (Node, build, bridge, port, browser); start nothing.
.PARAMETER Json       Print the result as JSON.
#>
[CmdletBinding()]
param([switch]$NoBrowser, [switch]$Gui, [switch]$Check, [switch]$Json)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Launcher\Launcher.psm1') -Force
$root = Get-GuardianRoot
try {
    if ($Check) { $r = Get-LaunchDiagnostics -Root $root; if ($Json) { $r | ConvertTo-Json -Depth 3 } else { $r | Format-List | Out-String | Write-Host }; exit 0 }
    $r = Start-GuardianDashboard -Root $root -NoBrowser:$NoBrowser -Gui:$Gui
    if ($Json) { $r | ConvertTo-Json -Depth 3 }
    elseif ($r.ok) { Write-Host "Laptop Guardian dashboard: $($r.url)  (bridge $($r.bridge), window $($r.window))" }
    exit $(if ($r.ok) { 0 } else { 1 })
} catch {
    Show-LauncherError -Root $root -Message "Unexpected launcher error: $($_.Exception.Message)" -Gui:$Gui
    exit 1
}
