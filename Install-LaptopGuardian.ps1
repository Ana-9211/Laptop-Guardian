#requires -Version 5.1
<#
.SYNOPSIS  Installs Laptop Guardian into Program Files, keeps your settings and history in a separate data folder, and registers the scheduled tasks.
.DESCRIPTION
  Program files   %ProgramFiles%\LaptopGuardian        (changeable only by administrators; the only place administrator tasks run from)
  Your data       %LOCALAPPDATA%\LaptopGuardian        (settings, history, reports, logs)
  Admin results   %ProgramData%\LaptopGuardian         (administrators-only: elevated results, audit lines, hosts backups)
  Run it from a checkout or an unpacked download. Existing data in that folder is COPIED (never moved) after a backup zip is written.
.PARAMETER Check         Print a read-only self-check (Node version, free space, ports 7878/7879, write permissions, existing tasks and their paths, leftovers of an old install) and change nothing. Exit code 1 when something would stop the install.
.PARAMETER PlanOnly      Print what would be done and change nothing.
.PARAMETER Elevate       Relaunch elevated (UAC). Writing to Program Files needs it.
.PARAMETER ProgramDir / DataDir / ElevatedDir   Other locations (used by the tests; a program folder that ordinary programs can edit is refused for administrator work).
.PARAMETER Rollback      Point the scheduled tasks and shortcuts back at the old folder recorded by the migration. Deletes nothing. Run it WITHOUT administrator rights.
.PARAMETER CleanupLegacy Delete the old folder's config, data, reports and logs after a verified migration. Asks first.
.PARAMETER SkipTasks / SkipBuild / SkipSmokeTest / SkipShortcuts / NoDesktopShortcut / SkipMigration / RunTests   As named.
.NOTES     Safe by default: config ships with safeMode=true (observe + recommend only; no process kills, no cleanup deletions).
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param([switch]$Check, [switch]$PlanOnly, [switch]$Elevate, [switch]$Rollback, [switch]$CleanupLegacy, [switch]$SkipTasks, [switch]$SkipBuild, [switch]$SkipSmokeTest, [switch]$SkipMigration, [switch]$RunTests,
      [switch]$NoDesktopShortcut, [switch]$SkipShortcuts, [string]$ProgramDir, [string]$DataDir, [string]$ElevatedDir, [string]$TaskFolder = '\LaptopGuardian\')

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
function Step($n, $msg) { Write-Host ("[{0}] {1}" -f $n, $msg) -ForegroundColor Cyan }
function Ok($msg) { Write-Host "       OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "       !!  $msg" -ForegroundColor Yellow }
function Json($r) { try { ($r | Out-String) | ConvertFrom-Json } catch { $null } }

Import-Module (Join-Path $source 'src\powershell\Install\Installer.psm1') -Force
$layout = Get-InstallLayout -ProgramDir $ProgramDir -DataDir $DataDir -ElevatedDir $ElevatedDir
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# ---------- check: a read-only look at this machine ----------
if ($Check) {
    Write-Host "`nLaptop Guardian pre-install check (nothing is changed)`n" -ForegroundColor White
    $worst = 0
    foreach ($c in (Get-InstallCheck -Layout $layout -SourceRoot $source -TaskFolder $TaskFolder)) {
        $tag = switch ($c.status) { 'ok' { 'OK  ' } 'warn' { 'WARN' } 'fail' { 'FAIL' } default { 'INFO' } }
        $color = switch ($c.status) { 'ok' { 'Green' } 'warn' { 'Yellow' } 'fail' { 'Red' } default { 'Gray' } }
        if ($c.status -eq 'fail') { $worst = 1 }
        Write-Host ("[{0}] {1}" -f $tag, $c.title) -ForegroundColor $color
        Write-Host "       $($c.detail)" -ForegroundColor Gray
    }
    Write-Host "`n$(if ($worst) { 'Something above would stop the install. Fix the FAIL items first.' } else { 'Nothing found that would stop the install. WARN items are worth reading.' })" -ForegroundColor $(if ($worst) { 'Red' } else { 'Green' })
    exit $worst
}

# ---------- plan only: nothing is created, copied, registered or elevated ----------
if ($PlanOnly) {
    Write-Host "`nLaptop Guardian install plan (nothing is changed)`n" -ForegroundColor White
    $i = 0
    foreach ($s in (Get-InstallPlan -SourceRoot $source -Layout $layout -SkipTasks:$SkipTasks -SkipShortcuts:$SkipShortcuts -SkipMigration:$SkipMigration)) {
        $i++; Write-Host ("{0}. {1}" -f $i, $s.what) -ForegroundColor Cyan
        if ($s.to) { Write-Host "     to:     $($s.to)" }
        if ($s.from) { Write-Host "     from:   $($s.from)" }
        Write-Host "     note:   $($s.detail)" -ForegroundColor Gray
    }
    Write-Host "`nWrites to Program Files and ProgramData need administrator rights; the installer asks for them with -Elevate." -ForegroundColor Gray
    return
}

# ---------- rollback (standard rights: the old folder cannot run administrator work) ----------
if ($Rollback) {
    if ($isAdmin) { throw 'Run -Rollback from a normal (not administrator) PowerShell window. An old checkout may not run administrator tasks.' }
    $plan = Get-RollbackPlan -DataDir $layout.dataDir
    Write-Host "`nRolling back to $($plan.legacyRoot)`n" -ForegroundColor White
    $plan.steps | ForEach-Object { Write-Host "  - $_" }
    $r = Json (& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $plan.legacyRoot 'src\powershell\Scheduler.ps1') -Action Register -Json -TaskFolder $TaskFolder)
    if (-not $r -or -not $r.ok) { throw "Task registration from the old folder failed: $($r.message)" }
    Ok $r.message
    try {
        Import-Module (Join-Path $plan.legacyRoot 'src\powershell\Launcher\Launcher.psm1') -Force
        $sc = Get-GuardianShortcutPaths
        foreach ($p in $sc.StartMenu, $sc.Desktop) { if (Test-Path -LiteralPath $p) { [void](New-GuardianShortcut -Path $p -Root $plan.legacyRoot) } }
        Ok 'Shortcuts point at the old folder again'
    } catch { Warn "Shortcuts not updated: $($_.Exception.Message)" }
    Write-Host 'Done. The installed copy, your data folder and the backup zip were left in place. Install again any time to switch back.' -ForegroundColor Green
    return
}

# ---------- cleanup of the old folder ----------
if ($CleanupLegacy) {
    $m = Get-Migration -DataDir $layout.dataDir
    if (-not $m) { throw "No migration record in $($layout.dataDir)." }
    if ($PSCmdlet.ShouldProcess("$($m.from) (config, data, reports, logs)", 'Permanently delete the old copy of your data')) {
        $gone = @(Invoke-LegacyCleanup -DataDir $layout.dataDir)
        $gone | ForEach-Object { Write-Host "  Removed $_" }
        Write-Host "The backup zip $($m.backupZip) was kept." -ForegroundColor Yellow
    }
    return
}

# ---------- relaunch elevated ----------
if ($Elevate -and -not $isAdmin) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    foreach ($k in 'SkipTasks', 'SkipBuild', 'SkipSmokeTest', 'SkipMigration', 'RunTests', 'NoDesktopShortcut', 'SkipShortcuts') { if ($PSBoundParameters.ContainsKey($k)) { $argList += "-$k" } }
    foreach ($k in 'ProgramDir', 'DataDir', 'ElevatedDir', 'TaskFolder') { if ($PSBoundParameters.ContainsKey($k)) { $argList += @("-$k", "`"$($PSBoundParameters[$k])`"") } }
    Start-Process $ps -ArgumentList $argList -Verb RunAs -Wait
    return
}

Write-Host "`nLaptop Guardian installer`n" -ForegroundColor White
Write-Host "  Program files: $($layout.programDir)`n  Your data:     $($layout.dataDir)`n  Admin results: $($layout.elevatedDir)`n" -ForegroundColor Gray

Step '1/9' 'Validating prerequisites'
if ($PSVersionTable.PSVersion -lt [version]'5.1') { throw 'PowerShell 5.1 or newer required.' }
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Windows required.' }
$node = (Get-Command node.exe -ErrorAction SilentlyContinue)
if (-not $node) { throw 'Node.js 22+ is required for the dashboard bridge (https://nodejs.org).' }
$nv = [version](($node.Version).ToString())
if ($nv.Major -lt 22) { throw "Node.js 22+ required (found $nv)." }
Ok "PowerShell $($PSVersionTable.PSVersion), Windows $([Environment]::OSVersion.Version), Node.js $nv"
if (-not $isAdmin) { throw "Installing into $($layout.programDir) and $($layout.elevatedDir) needs administrator rights. Run this script from an administrator PowerShell, or add -Elevate to be asked for them." }
if ($source.TrimEnd('\') -ieq $layout.programDir) { throw 'This is already the installed copy. Run the installer from the folder you downloaded or cloned.' }

Step '2/9' 'Building the dashboard (in the source folder)'
$dash = Join-Path $source 'src\dashboard'
if ($SkipBuild) { Warn 'Build skipped' }
else {
    $distIndex = Join-Path $dash 'dist\index.html'
    $srcFiles = @(Get-ChildItem (Join-Path $dash 'src'), (Join-Path $dash 'public') -Recurse -File -ErrorAction SilentlyContinue) + @(Get-Item (Join-Path $dash 'index.html'), (Join-Path $dash 'package-lock.json') -ErrorAction SilentlyContinue)
    $newestSrc = ($srcFiles | Measure-Object LastWriteTimeUtc -Maximum).Maximum
    $stale = -not (Test-Path $distIndex) -or ($newestSrc -and ((Get-Item $distIndex).LastWriteTimeUtc -lt $newestSrc))
    if (-not $stale) { Ok 'dashboard build is up to date' }
    else {
        Push-Location $dash
        try {
            if (-not (Test-Path 'node_modules\.package-lock.json') -or ((Get-Item 'node_modules\.package-lock.json').LastWriteTimeUtc -lt (Get-Item 'package-lock.json').LastWriteTimeUtc)) {
                Write-Host '       installing dependencies from package-lock.json (npm ci)...'
                $out = & npm.cmd ci --no-audit --no-fund 2>&1
                if ($LASTEXITCODE -ne 0) { $out | Select-Object -Last 15 | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }; throw "npm ci failed in $dash. Check network access and Node/npm versions." }
            }
            $out = & npm.cmd run build 2>&1
            if ($LASTEXITCODE -ne 0) { $out | Select-Object -Last 20 | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }; throw "Dashboard type-check/build failed in $dash (output above)." }
            Ok 'dashboard built (type-check + vite build)'
        } finally { Pop-Location }
    }
}

Step '3/9' 'Copying the program files'
$n = Copy-ProgramFiles -SourceRoot $source -ProgramDir $layout.programDir
Ok "$n files in $($layout.programDir)"
$ver = try { (Get-Content (Join-Path $source 'package.json') -Raw | ConvertFrom-Json).version } catch { $null }
[void](Write-InstallInfo -Layout $layout -NodePath $node.Source -Version $ver -Source $source)
Ok 'install.json written'
$prog = $layout.programDir

Step '4/9' 'Creating the administrators-only folder and verifying its permissions'
Import-Module (Join-Path $prog 'src\powershell\Install\InstallSecurity.psm1') -Force -DisableNameChecking
foreach ($sub in '', 'ActionResults', 'ElevatedAudit', 'ElevatedBackups') { $null = New-ProtectedDirectory -Path (Join-Path $layout.elevatedDir $sub) }
Ok "$($layout.elevatedDir): SYSTEM and Administrators full control, Users read-only (verified)"

Step '5/9' 'Creating your data folder and default settings'
$r = Json (& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $prog 'src\powershell\Tools\Initialize-Data.ps1'))
if (-not $r -or -not $r.ok) { throw 'Creating the data folder failed.' }
Ok "$($r.dataRoot) ready$(if ($r.created.Count) { ' (created: ' + ($r.created -join ', ') + ')' } else { ' (existing settings kept)' })"

Step '6/9' 'Migrating data from the folder you installed from'
$legacyHas = @('config', 'data', 'reports', 'logs' | Where-Object { Test-Path -LiteralPath (Join-Path $source $_) }).Count -gt 0
if ($SkipMigration) { Warn 'Skipped (-SkipMigration)' }
elseif (-not $legacyHas) { Ok 'Nothing to migrate' }
else {
    $m = Invoke-DataMigration -LegacyRoot $source -DataDir $layout.dataDir
    switch ($m.status) {
        'migrated' { Ok "Copied $($m.files) files. Backup zip: $($m.backup). The old folder was not changed." }
        'already-migrated' { Ok 'Already migrated earlier; nothing copied again' }
        default { Ok $m.status }
    }
    if ($m.failed -and $m.failed.Count) { Warn "$($m.failed.Count) file(s) could not be copied (open in another program?): $($m.failed -join ', ')" }
}

Step '7/9' 'Registering scheduled tasks from the installed copy'
if ($SkipTasks) { Warn 'Skipped (-SkipTasks)' }
else {
    $r = Json (& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $prog 'src\powershell\Scheduler.ps1') -Action Register -Json -TaskFolder $TaskFolder)
    if (-not $r -or -not $r.ok) { throw "Task registration failed: $($r.message)" }
    Ok $r.message
    Ok 'Daily and Weekly run with highest privileges, only from the installed copy. The dashboard bridge runs with limited rights.'
}

Step '8/9' 'Shortcuts and a check that administrator code may run from here'
if ($SkipShortcuts) { Warn 'Shortcuts skipped (-SkipShortcuts)' } else { try {
    Import-Module (Join-Path $prog 'src\powershell\Launcher\Launcher.psm1') -Force
    if (-not (Test-Path (Join-Path $prog 'src\assets\guardian.ico'))) { Warn 'icon missing; shortcuts use the default icon' }
    $sc = Get-GuardianShortcutPaths
    $targets = @(@{ Label = 'Start Menu'; Path = $sc.StartMenu })
    if (-not $NoDesktopShortcut) { $targets += @{ Label = 'Desktop'; Path = $sc.Desktop } }
    foreach ($t in $targets) {
        [void](New-GuardianShortcut -Path $t.Path -Root $prog)
        $chk = Test-GuardianShortcut -Path $t.Path -Root $prog
        if ($chk.ok) { Ok "$($t.Label) shortcut verified: $($t.Path)" } else { Warn "$($t.Label) shortcut problem: $($chk.reason)" }
    }
} catch { Warn "Shortcut not created: $($_.Exception.Message)" } }
$trust = Json (& $ps -NoProfile -ExecutionPolicy Bypass -Command ". '$prog\src\powershell\Common\Load.ps1'; `$r = Test-InstallTrusted; [pscustomobject]@{ trusted = [bool]`$r.trusted; problems = @(`$r.problems); fix = `$r.fix } | ConvertTo-Json -Compress")
if ($trust -and $trust.trusted) { Ok 'Administrator tasks are allowed to run from the installed copy' }
else { Warn "Administrator tasks will REFUSE to run: $(@($trust.problems) -join ' ') $($trust.fix)" }

Step '9/9' 'Test scan'
if ($SkipSmokeTest) { Warn 'Skipped' }
else {
    & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $prog 'src\powershell\Daily.ps1') -Fast -NoAI -SkipDefenderScan | ForEach-Object { Write-Host "       $_" }
    if ($LASTEXITCODE -ne 0) { Warn "Test scan reported a problem; see $($layout.dataDir)\logs" } else { Ok 'Test scan completed; first report written' }
}
if ($RunTests -and (Test-Path (Join-Path $source 'tests\Run-Tests.ps1'))) { & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $source 'tests\Run-Tests.ps1'); if ($LASTEXITCODE -ne 0) { Warn 'Some tests failed' } }

$port = try { (Get-Content (Join-Path $layout.dataDir 'config\config.json') -Raw | ConvertFrom-Json).bridge.port } catch { 7878 }
Write-Host "`nInstalled. Open Laptop Guardian from the Start Menu or the Desktop icon (dashboard: http://127.0.0.1:$port/)." -ForegroundColor Green
Write-Host 'Daily 19:00 | Weekly Saturday 02:00 (shutdown 05:00). Safe Mode is ON: Guardian only observes and recommends until you turn it off in Settings.' -ForegroundColor Green
if ($legacyHas -and -not $SkipMigration) {
    Write-Host "`nYour old folder ($source) was not changed. When you are happy with the installed copy:" -ForegroundColor Yellow
    Write-Host '  go back:                   Install-LaptopGuardian.ps1 -Rollback   (normal PowerShell, not administrator)' -ForegroundColor Yellow
    Write-Host '  delete the old data copy:  Install-LaptopGuardian.ps1 -CleanupLegacy' -ForegroundColor Yellow
}
