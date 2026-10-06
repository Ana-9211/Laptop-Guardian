#requires -Version 5.1
<#
.SYNOPSIS  Removes Laptop Guardian: scheduled tasks, shortcuts and (for an installed copy) the Program Files copy. Your data is kept unless -RemoveData is given.
.PARAMETER RemoveData  Also delete your settings, history, reports and logs (including the stored Gemini key). Irreversible.
.PARAMETER PlanOnly    Say what would be removed and what would stay; change nothing.
.NOTES     Run from an administrator PowerShell for an installed copy (the Daily and Weekly tasks and the Program Files folder need it).
           The migration backup zip, the administrators-only %ProgramData% folder and any old checkout are never deleted by this script; it says so at the end.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param([switch]$RemoveData, [switch]$PlanOnly, [string]$TaskFolder = '\LaptopGuardian\')
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot.TrimEnd('\')
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Import-Module (Join-Path $root 'src\powershell\Install\Installer.psm1') -Force

# An installed copy has install.json beside it; a plain checkout does not.
$installFile = Join-Path $root 'install.json'
$installed = Test-Path -LiteralPath $installFile
if ($installed) {
    $info = Get-Content -LiteralPath $installFile -Raw | ConvertFrom-Json
    $layout = Get-InstallLayout -ProgramDir $root -DataDir ([string]$info.dataRoot) -ElevatedDir ([string]$info.elevatedDir)
} else {
    $layout = Get-InstallLayout -ProgramDir $root -DataDir $root -ElevatedDir (Join-Path $env:ProgramData 'LaptopGuardian')
}
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($PlanOnly) {
    Write-Host "`nUninstall plan (nothing is changed)`n" -ForegroundColor White
    Write-Host '  Remove: the Daily, Weekly and Dashboard scheduled tasks; the Start Menu and Desktop shortcuts that point at this copy; the running dashboard bridge'
    if ($installed) { Write-Host "  Remove: the program folder $($layout.programDir)" }
    if ($RemoveData) { Write-Host "  Remove: your data ($(if ($installed) { $layout.dataDir } else { 'config, data, reports and logs in ' + $root }))" }
    Write-Host '  Stays:'
    foreach ($l in (Get-UninstallLeftovers -Layout $layout -RemovedData:$RemoveData)) { Write-Host "    - $l" }
    return
}
if ($installed -and -not $isAdmin) { throw "This is an installed copy. Run the uninstaller from an administrator PowerShell window (it removes the tasks that run with administrator rights and the Program Files folder)." }

Write-Host 'Removing scheduled tasks...' -ForegroundColor Cyan
$script:tasksLeft = $false
& $ps -NoProfile -ExecutionPolicy Bypass -File "$root\src\powershell\Scheduler.ps1" -Action Unregister -Json -TaskFolder $TaskFolder | ConvertFrom-Json | ForEach-Object { Write-Host "  $($_.message)"; if ($_.needsElevation) { $script:tasksLeft = $true } }
if ($script:tasksLeft) {
    Write-Host ''
    Write-Host 'NOT UNINSTALLED: the Daily/Weekly scheduled tasks run with administrator rights and were left in place.' -ForegroundColor Red
    Write-Host 'Run this script again from an administrator PowerShell window to remove them.' -ForegroundColor Red
    exit 2
}

# stop the dashboard bridge if running from this copy
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf((Join-Path $root 'src\bridge\server.js'), [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "  Stopped dashboard bridge (PID $($_.ProcessId))" }

foreach ($e in @(@{ L = 'Start Menu'; P = (Join-Path ([Environment]::GetFolderPath('Programs')) 'Laptop Guardian.lnk') }, @{ L = 'Desktop'; P = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Laptop Guardian.lnk') })) {
    if (-not (Test-Path $e.P)) { continue }
    # only remove shortcuts that point at THIS install
    $lnkArgs = (New-Object -ComObject WScript.Shell).CreateShortcut($e.P).Arguments
    if ($lnkArgs -and $lnkArgs.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) { Remove-Item $e.P -Force; Write-Host "  Removed $($e.L) shortcut" } else { Write-Host "  Left $($e.L) shortcut (it points somewhere else)" }
}

$removedData = $false
if ($RemoveData) {
    if ($installed) {
        if ($PSCmdlet.ShouldProcess($layout.dataDir, 'Permanently delete your settings, history, reports and logs')) {
            if (Test-Path -LiteralPath $layout.dataDir) { Remove-Item -LiteralPath $layout.dataDir -Recurse -Force; Write-Host "  Deleted $($layout.dataDir)" }
            $removedData = $true
        }
    } elseif ($PSCmdlet.ShouldProcess("$root (data, reports, logs, config)", 'Permanently delete')) {
        foreach ($d in 'data', 'reports', 'logs', 'config') { $p = Join-Path $root $d; if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Host "  Deleted $d\" } }
        $removedData = $true
    }
}

# The leftovers are worked out BEFORE the program folder (and with it this script) goes away.
$left = @(Get-UninstallLeftovers -Layout $layout -RemovedData:$removedData)
if ($installed) {
    # a running script cannot delete its own folder: hand that to a helper that waits for this process to end
    $cmd = "ping -n 4 127.0.0.1 >nul & rmdir /s /q `"$($layout.programDir)`""
    if ($layout.programDir.Length -gt 8 -and (Split-Path -Leaf $layout.programDir) -ieq 'LaptopGuardian') {
        Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList @('/c', $cmd) -WindowStyle Hidden
        Write-Host "  Removing the program folder $($layout.programDir) (finishes a few seconds after this window closes)"
    } else { $left += "The program folder $($layout.programDir) (its name is not LaptopGuardian, so it was not deleted automatically)" }
}

Write-Host "`nUninstall complete." -ForegroundColor Green
if ($left.Count) {
    Write-Host 'Left in place on purpose:' -ForegroundColor Yellow
    $left | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
}
if (-not $installed) { Write-Host 'You can delete this folder manually if you no longer need it.' }
