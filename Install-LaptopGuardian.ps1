#requires -Version 5.1
<#
.SYNOPSIS  Installs Laptop Guardian: directories, default config, dashboard build, scheduled tasks, safe smoke test.
.PARAMETER Elevate     Relaunch elevated (UAC) so tasks run with highest privileges (needed for SFC / DISM / Repair-Volume).
.PARAMETER SkipTasks   Do not register scheduled tasks.
.PARAMETER SkipBuild   Do not (re)build the dashboard.
.PARAMETER SkipSmokeTest  Do not run the safe test scan.
.PARAMETER SkipShortcuts  Create no shortcuts at all (used by automated tests).
.PARAMETER NoDesktopShortcut  Create only the Start Menu shortcut (a Desktop shortcut is created by default).
.PARAMETER RunTests    Also run the unit test suite.
.NOTES     Safe by default: config ships with safeMode=true (observe + recommend only; no process kills, no cleanup deletions).
#>
[CmdletBinding()]
param([switch]$Elevate, [switch]$SkipTasks, [switch]$SkipBuild, [switch]$SkipSmokeTest, [switch]$RunTests, [switch]$NoDesktopShortcut, [switch]$SkipShortcuts, [string]$TaskFolder = '\LaptopGuardian\')

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
function Step($n, $msg) { Write-Host ("[{0}/10] {1}" -f $n, $msg) -ForegroundColor Cyan }
function Ok($msg) { Write-Host "       OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "       !!  $msg" -ForegroundColor Yellow }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Elevate -and -not $isAdmin) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    foreach ($k in 'SkipTasks', 'SkipBuild', 'SkipSmokeTest', 'RunTests', 'NoDesktopShortcut', 'SkipShortcuts') { if ($PSBoundParameters.ContainsKey($k)) { $argList += "-$k" } }
    Start-Process powershell.exe -ArgumentList $argList -Verb RunAs -Wait
    return
}

Write-Host "`nLaptop Guardian installer`n" -ForegroundColor White

Step 1 'Validating prerequisites'
if ($PSVersionTable.PSVersion -lt [version]'5.1') { throw 'PowerShell 5.1 or newer required.' }
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Windows required.' }
Ok "PowerShell $($PSVersionTable.PSVersion), Windows $([Environment]::OSVersion.Version)"
$node = (Get-Command node.exe -ErrorAction SilentlyContinue)
if (-not $node) { throw 'Node.js 18+ is required for the dashboard bridge (https://nodejs.org).' }
$nv = [version](($node.Version).ToString())
if ($nv.Major -lt 18) { throw "Node.js 18+ required (found $nv)." }
Ok "Node.js $nv"
if ($isAdmin) { Ok 'Running elevated: tasks will use highest privileges (SFC/DISM/filesystem scan enabled)' }
else { Warn 'Not elevated: tasks will run with limited rights; SFC/DISM/Repair-Volume/Windows\Temp cleanup will be skipped. Re-run with -Elevate to enable.' }
try { Get-MpComputerStatus -ErrorAction Stop | Out-Null; Ok 'Microsoft Defender cmdlets available' } catch { Warn 'Defender cmdlets unavailable (third-party AV?); Defender checks will report unavailable.' }

Step 2 'Creating directories'
foreach ($d in 'config', 'data\history', 'data\recommendations', 'data\actions', 'data\processes', 'data\metrics', 'data\state', 'data\latest', 'data\secrets', 'reports\daily', 'reports\weekly', 'logs') {
    New-Item -ItemType Directory -Path (Join-Path $root $d) -Force | Out-Null
}
Ok 'data/, reports/, logs/, config/ ready'
# restrict secrets folder to current user
try { & icacls.exe (Join-Path $root 'data\secrets') /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" 2>&1 | Out-Null; Ok 'data\secrets restricted to current user' } catch { Warn 'Could not tighten ACL on data\secrets' }

Step 3 'Writing default configuration (existing files are preserved)'
. "$root\src\powershell\Common\Load.ps1"
if (-not (Test-Path (Join-Path $root 'config\config.json'))) { Save-GuardianConfig -Config (Get-DefaultConfig); Ok 'config.json created (safeMode = ON)' } else { Ok 'config.json kept' }
if (-not (Test-Path (Join-Path $root 'config\process-policy.json'))) { Write-JsonFile -Path (Join-Path $root 'config\process-policy.json') -Object ([ordered]@{ blacklist = @(); whitelist = @(); ignored = @() }); Ok 'process-policy.json created (empty)' }
if (-not (Test-Path (Join-Path $root 'config\cleanup-policy.json'))) { Write-JsonFile -Path (Join-Path $root 'config\cleanup-policy.json') -Object ([ordered]@{}); Ok 'cleanup-policy.json created' }

Step 4 'Configuring the dashboard'
$dash = Join-Path $root 'src\dashboard'
if ($SkipBuild) { Warn 'Build skipped' }
else {
    $distIndex = Join-Path $dash 'dist\index.html'
    $srcFiles = @(Get-ChildItem (Join-Path $dash 'src'), (Join-Path $dash 'public') -Recurse -File -ErrorAction SilentlyContinue) + @(Get-Item (Join-Path $dash 'index.html'), (Join-Path $dash 'package-lock.json'), (Join-Path $dash 'vite.config.ts'))
    $newestSrc = ($srcFiles | Measure-Object LastWriteTimeUtc -Maximum).Maximum
    $stale = -not (Test-Path $distIndex) -or ((Get-Item $distIndex).LastWriteTimeUtc -lt $newestSrc)
    if (-not $stale) { Ok 'dashboard build is up to date' }
    else {
        Push-Location $dash
        try {
            if (-not (Test-Path 'node_modules\.package-lock.json') -or ((Get-Item 'node_modules\.package-lock.json').LastWriteTimeUtc -lt (Get-Item 'package-lock.json').LastWriteTimeUtc)) {
                Write-Host '       installing dependencies from package-lock.json (npm ci)...'
                $out = & npm.cmd ci --no-audit --no-fund 2>&1
                if ($LASTEXITCODE -ne 0) { $out | Select-Object -Last 15 | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }; throw "npm ci failed in $dash. Check network access and Node/npm versions, then re-run the installer (or run 'npm ci' there manually)." }
            }
            $out = & npm.cmd run build 2>&1
            if ($LASTEXITCODE -ne 0) { $out | Select-Object -Last 20 | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }; throw "Dashboard type-check/build failed in $dash (output above). Fix the error or use -SkipBuild to keep the existing dist/." }
            Ok 'dashboard built (type-check + vite build)'
        } finally { Pop-Location }
    }
}

Step 5 'Registering scheduled tasks'
if ($SkipTasks) { Warn 'Skipped (-SkipTasks)' }
else {
    $r = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$root\src\powershell\Scheduler.ps1" -Action Register -Json -TaskFolder $TaskFolder | ConvertFrom-Json
    if (-not $r.ok) { throw "Task registration failed: $($r.message)" }
    Ok $r.message
}

Step 6 'Configuring privileges'
if ($SkipTasks) { Warn 'Skipped (-SkipTasks)' } elseif ($isAdmin) { Ok 'Daily/Weekly tasks: RunLevel Highest. Dashboard bridge: Limited (least privilege).' } else { Warn 'Tasks registered with RunLevel Limited.' }

Step 7 'Verifying task registration'
if (-not $SkipTasks) {
    $st = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$root\src\powershell\Scheduler.ps1" -Action Status -Json -TaskFolder $TaskFolder | ConvertFrom-Json).tasks
    foreach ($t in $st) {
        if ($t.state -eq 'NotRegistered') { Warn "$($t.name): NOT registered" } else { Ok ("{0}: {1}, next run {2}" -f $t.name, $t.state, $t.nextRun) }
    }
    $missing = @($st | Where-Object { $_.kind -in 'daily', 'weekly' -and $_.state -eq 'NotRegistered' })
    if ($missing.Count -gt 0) { throw 'Daily/weekly task registration could not be verified.' }
} else { Warn 'Skipped' }

Step 8 'Running a safe test scan (observe-only, fast, no AI, no cleanup)'
if ($SkipSmokeTest) { Warn 'Skipped' }
else {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$root\src\powershell\Daily.ps1" -Fast -NoAI -SkipDefenderScan | ForEach-Object { Write-Host "       $_" }
    if ($LASTEXITCODE -ne 0) { Warn 'Test scan reported a problem; see logs\' } else { Ok 'Test scan completed; first report written' }
}

Step 9 'Unit tests'
if ($RunTests) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$root\tests\Run-Tests.ps1"; if ($LASTEXITCODE -ne 0) { Warn 'Some tests failed' } } else { Ok 'Skipped (use -RunTests)' }

Step 10 'Start Menu shortcut + dashboard location'
if ($SkipShortcuts) { Warn 'Shortcuts skipped (-SkipShortcuts)' } else { try {
    Import-Module "$root\src\powershell\Launcher\Launcher.psm1" -Force
    if (-not (Test-Path "$root\src\assets\guardian.ico")) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$root\src\powershell\Tools\New-GuardianIcon.ps1" | Out-Null }
    $sc = Get-GuardianShortcutPaths
    $targets = @(@{ Label = 'Start Menu'; Path = $sc.StartMenu })
    if (-not $NoDesktopShortcut) { $targets += @{ Label = 'Desktop'; Path = $sc.Desktop } }
    foreach ($t in $targets) {
        [void](New-GuardianShortcut -Path $t.Path -Root $root)
        $chk = Test-GuardianShortcut -Path $t.Path -Root $root
        if ($chk.ok) { Ok "$($t.Label) shortcut verified: $($t.Path)" } else { Warn "$($t.Label) shortcut problem: $($chk.reason)" }
    }
    if ($NoDesktopShortcut) { Ok 'Desktop shortcut skipped (-NoDesktopShortcut)' }
} catch { Warn "Shortcut not created: $($_.Exception.Message)" } }
Write-Host '       Launch any time: Start Menu > "Laptop Guardian", the Desktop icon, or Open-LaptopGuardian.cmd' -ForegroundColor Gray
$cfg = Get-GuardianConfig
Write-Host "`nInstalled. Dashboard: http://127.0.0.1:$($cfg.bridge.port)/  (start with: .\src\powershell\Start-Dashboard.ps1)" -ForegroundColor Green
Write-Host 'Daily 19:00 | Weekly Saturday 02:00 (shutdown 05:00). Safe Mode is ON: Guardian only observes and recommends until you turn it off in Settings.' -ForegroundColor Green
