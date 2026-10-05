#requires -Version 5.1
<#
.SYNOPSIS  Removes Laptop Guardian scheduled tasks and shortcuts. Reports/data are preserved unless -RemoveData is given.
.PARAMETER RemoveData  Also delete data\, reports\, logs\ and config\ (including stored Gemini key). Irreversible.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param([switch]$RemoveData, [string]$TaskFolder = '\LaptopGuardian\')
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot


Write-Host 'Removing scheduled tasks...' -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$root\src\powershell\Scheduler.ps1" -Action Unregister -Json -TaskFolder $TaskFolder | ConvertFrom-Json | ForEach-Object { Write-Host "  $($_.message)" }

# stop the dashboard bridge if running
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*$root*src\bridge\server.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "  Stopped dashboard bridge (PID $($_.ProcessId))" }

$sm = Join-Path ([Environment]::GetFolderPath('Programs')) 'Laptop Guardian.lnk'
if (Test-Path $sm) { Remove-Item $sm -Force; Write-Host '  Removed Start Menu shortcut' }

if ($RemoveData) {
    if ($PSCmdlet.ShouldProcess("$root (data, reports, logs, config)", 'Permanently delete')) {
        foreach ($d in 'data', 'reports', 'logs', 'config') { $p = Join-Path $root $d; if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Host "  Deleted $d\" } }
    }
} else {
    Write-Host 'Reports, history, logs, config and your Gemini key were PRESERVED. Re-run with -RemoveData to delete them.' -ForegroundColor Yellow
}
Write-Host 'Uninstall complete. You can delete the LaptopGuardian folder manually if you no longer need it.' -ForegroundColor Green
