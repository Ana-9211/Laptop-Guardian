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
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$root\src\powershell\Scheduler.ps1" -Action Unregister -Json -TaskFolder $TaskFolder | ConvertFrom-Json | ForEach-Object { Write-Host "  $($_.message)"; if ($_.needsElevation) { $script:tasksLeft = $true } }
if ($script:tasksLeft) {
    Write-Host ''
    Write-Host 'NOT UNINSTALLED: the Daily/Weekly scheduled tasks run with administrator rights and were left in place.' -ForegroundColor Red
    Write-Host 'Run this script again from an administrator PowerShell window to remove them.' -ForegroundColor Red
    exit 2
}

# stop the dashboard bridge if running
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf((Join-Path $root 'src\bridge\server.js'), [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "  Stopped dashboard bridge (PID $($_.ProcessId))" }

foreach ($e in @(@{ L = 'Start Menu'; P = (Join-Path ([Environment]::GetFolderPath('Programs')) 'Laptop Guardian.lnk') }, @{ L = 'Desktop'; P = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Laptop Guardian.lnk') })) {
    if (-not (Test-Path $e.P)) { continue }
    # only remove shortcuts that point at THIS install
    $lnkArgs = (New-Object -ComObject WScript.Shell).CreateShortcut($e.P).Arguments
    if ($lnkArgs -and $lnkArgs.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) { Remove-Item $e.P -Force; Write-Host "  Removed $($e.L) shortcut" } else { Write-Host "  Left $($e.L) shortcut (belongs to another install)" -ForegroundColor Yellow }
}

if ($RemoveData) {
    if ($PSCmdlet.ShouldProcess("$root (data, reports, logs, config)", 'Permanently delete')) {
        foreach ($d in 'data', 'reports', 'logs', 'config') { $p = Join-Path $root $d; if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Host "  Deleted $d\" } }
    }
} else {
    Write-Host 'Reports, history, logs, config and your Gemini key were PRESERVED. Re-run with -RemoveData to delete them.' -ForegroundColor Yellow
}
Write-Host 'Uninstall complete. You can delete the LaptopGuardian folder manually if you no longer need it.' -ForegroundColor Green
