#requires -Version 5.1
# Installer building blocks. The installer script is a thin sequence over these functions, so each one is tested on temp folders
# without elevation, a real Program Files install, scheduled tasks or shortcuts.
Set-StrictMode -Version 2.0

# What an installed copy needs at run time. Source, tests, docs, config, data, reports, logs and node_modules never go to Program Files.
$script:ProgramTrees = @('src\powershell', 'src\bridge', 'src\shared', 'src\assets', 'src\dashboard\dist')
$script:ProgramFiles = @('Install-LaptopGuardian.ps1', 'Uninstall-LaptopGuardian.ps1', 'Open-LaptopGuardian.cmd', 'README.md', 'package.json')
$script:MigrationDirs = @('config', 'data', 'reports', 'logs')
# Left behind on purpose: a stale pid file, lock files, temp files and the browser profile (recreated on first launch).
$script:MigrationSkip = @('data\state\bridge.json', 'data\state\app-profile')

function Get-InstallLayout {
    <# Where an installed copy lives. Defaults are the standard Windows locations; the parameters exist for the tests and for people who
       want another drive. A custom program folder is checked after install and refused for administrator work if ordinary programs can edit it. #>
    param([string]$ProgramDir, [string]$DataDir, [string]$ElevatedDir)
    if (-not $ProgramDir) { $ProgramDir = Join-Path $env:ProgramFiles 'LaptopGuardian' }
    if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA 'LaptopGuardian' }
    if (-not $ElevatedDir) { $ElevatedDir = Join-Path $env:ProgramData 'LaptopGuardian' }
    foreach ($p in $ProgramDir, $DataDir, $ElevatedDir) { if (-not [IO.Path]::IsPathRooted($p)) { throw "'$p' is not an absolute path." } }
    [pscustomobject]@{ programDir = [IO.Path]::GetFullPath($ProgramDir).TrimEnd('\'); dataDir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\'); elevatedDir = [IO.Path]::GetFullPath($ElevatedDir).TrimEnd('\') }
}

function Get-ProgramFileList {
    <# Relative paths that make up the program copy, from a source tree. Missing optional pieces are skipped. #>
    param([Parameter(Mandatory)][string]$SourceRoot)
    $out = New-Object System.Collections.ArrayList
    foreach ($t in $script:ProgramTrees) {
        $d = Join-Path $SourceRoot $t
        if (-not (Test-Path -LiteralPath $d)) { continue }
        foreach ($f in @(Get-ChildItem -LiteralPath $d -Recurse -File -Force)) {
            if ($f.FullName -match '\\node_modules\\') { continue }
            [void]$out.Add($f.FullName.Substring($SourceRoot.TrimEnd('\').Length + 1))
        }
    }
    foreach ($f in $script:ProgramFiles) { if (Test-Path -LiteralPath (Join-Path $SourceRoot $f)) { [void]$out.Add($f) } }
    return @($out)
}

function Get-InstallPlan {
    <# Everything the installer would do, as data. -PlanOnly prints this and changes nothing. #>
    param([Parameter(Mandatory)][string]$SourceRoot, [Parameter(Mandatory)]$Layout, [switch]$SkipTasks, [switch]$SkipShortcuts, [switch]$SkipMigration)
    $src = $SourceRoot.TrimEnd('\')
    $steps = New-Object System.Collections.ArrayList
    $files = @(Get-ProgramFileList -SourceRoot $src)
    $bytes = 0L; foreach ($f in $files) { try { $bytes += (Get-Item -LiteralPath (Join-Path $src $f)).Length } catch { } }
    $existing = Test-Path -LiteralPath (Join-Path $Layout.programDir 'install.json')
    [void]$steps.Add([pscustomobject]@{ step = 'program'; what = $(if ($existing) { 'Update the program files (the old copy is kept until the new one is complete)' } else { 'Copy the program files' }); from = $src; to = $Layout.programDir; detail = "$($files.Count) files, $([math]::Round($bytes / 1MB, 1)) MB. Source, tests, docs, config, data, reports and logs are not copied." })
    [void]$steps.Add([pscustomobject]@{ step = 'install-info'; what = 'Write install.json (where the data and administrator folders are)'; from = $null; to = (Join-Path $Layout.programDir 'install.json'); detail = 'Read by the dashboard, the agents and the launcher. The environment cannot redirect an installed copy.' })
    [void]$steps.Add([pscustomobject]@{ step = 'elevated-folder'; what = 'Create the administrators-only folder and verify its permissions'; from = $null; to = $Layout.elevatedDir; detail = 'SYSTEM and Administrators full control, Users read-only, no inheritance. Elevated results, audit lines and hosts-file backups go here.' })
    [void]$steps.Add([pscustomobject]@{ step = 'data-folder'; what = 'Create the data folder and default settings (Safe Mode on)'; from = $null; to = $Layout.dataDir; detail = 'config, data, reports and logs. Existing files are kept.' })
    $legacy = ($src -ne $Layout.programDir) -and (@($script:MigrationDirs | Where-Object { Test-Path -LiteralPath (Join-Path $src $_) }).Count -gt 0)
    if ($legacy -and -not $SkipMigration) {
        $done = Test-Path -LiteralPath (Join-Path $Layout.dataDir 'migration.json')
        [void]$steps.Add([pscustomobject]@{ step = 'migrate'; what = $(if ($done) { 'Migration already done: nothing is copied again' } else { 'Back up, then COPY (never move) config, data, reports and logs from the old folder' }); from = $src; to = $Layout.dataDir; detail = 'A backup zip is written first. The old folder is left untouched; -Rollback goes back to it, -CleanupLegacy removes the old data once you are happy.' })
    }
    if (-not $SkipTasks) { [void]$steps.Add([pscustomobject]@{ step = 'tasks'; what = 'Register the Daily, Weekly and Dashboard scheduled tasks from the installed copy'; from = $null; to = $Layout.programDir; detail = 'Daily and Weekly with highest privileges (they only start from a trusted folder).' }) }
    if (-not $SkipShortcuts) { [void]$steps.Add([pscustomobject]@{ step = 'shortcuts'; what = 'Create or repoint the Start Menu and Desktop shortcuts'; from = $null; to = $Layout.programDir; detail = 'Open Laptop Guardian from one of these after installing.' }) }
    [void]$steps.Add([pscustomobject]@{ step = 'verify'; what = 'Verify that administrator code may run from the installed copy'; from = $null; to = $Layout.programDir; detail = 'Reads the permissions of the program folder and everything it runs from.' })
    return @($steps)
}

function Copy-ProgramFiles {
    <# Copies the program files to $ProgramDir by staging them next to it and swapping, so an update that fails halfway leaves the
       previous working copy in place. Returns the number of files. Never touches data, config, reports or logs. #>
    param([Parameter(Mandatory)][string]$SourceRoot, [Parameter(Mandatory)][string]$ProgramDir)
    $src = $SourceRoot.TrimEnd('\'); $dest = $ProgramDir.TrimEnd('\')
    if ($src -ieq $dest) { throw 'The source and the program folder are the same folder.' }
    $files = @(Get-ProgramFileList -SourceRoot $src)
    if (-not ($files -contains 'src\powershell\Common\Core.psm1' -and $files -contains 'src\bridge\server.js')) { throw "'$src' does not look like a Laptop Guardian source folder." }
    if (-not ($files | Where-Object { $_ -like 'src\dashboard\dist\*' })) { throw 'The dashboard has not been built (src\dashboard\dist is missing). Build it first, or run the installer without -SkipBuild.' }
    $stage = "$dest.new"; $old = "$dest.old"
    foreach ($p in $stage, $old) { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force } }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    try {
        foreach ($rel in $files) {
            $to = Join-Path $stage $rel
            $dir = Split-Path -Parent $to
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            Copy-Item -LiteralPath (Join-Path $src $rel) -Destination $to -Force
        }
        if (@(Get-ChildItem -LiteralPath $stage -Recurse -File).Count -ne $files.Count) { throw 'The staged copy is incomplete.' }
    } catch { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue; throw }
    $hadOld = Test-Path -LiteralPath $dest
    try {
        if ($hadOld) { Move-Item -LiteralPath $dest -Destination $old }
        Move-Item -LiteralPath $stage -Destination $dest
    } catch {
        # put the previous copy back
        if ($hadOld -and -not (Test-Path -LiteralPath $dest) -and (Test-Path -LiteralPath $old)) { Move-Item -LiteralPath $old -Destination $dest -ErrorAction SilentlyContinue }
        throw
    }
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }
    return $files.Count
}

function Write-InstallInfo {
    param([Parameter(Mandatory)]$Layout, [string]$NodePath, [string]$Version, [string]$Source)
    $info = [ordered]@{ version = $Version; installedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz'); programDir = $Layout.programDir; dataRoot = $Layout.dataDir; elevatedDir = $Layout.elevatedDir; nodePath = $NodePath; installedFrom = $Source }
    $f = Join-Path $Layout.programDir 'install.json'
    [IO.File]::WriteAllText($f, ($info | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    return $f
}

function Get-MigrationFiles {
    <# The files a migration copies (relative paths under the old root), after the deliberate skips. #>
    param([Parameter(Mandatory)][string]$LegacyRoot)
    $out = New-Object System.Collections.ArrayList
    foreach ($d in $script:MigrationDirs) {
        $p = Join-Path $LegacyRoot $d
        if (-not (Test-Path -LiteralPath $p)) { continue }
        foreach ($f in @(Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue)) {
            $rel = $f.FullName.Substring($LegacyRoot.TrimEnd('\').Length + 1)
            if ($f.Name -like '*.lock' -or $f.Name -like '*.tmp') { continue }
            $skip = $false; foreach ($s in $script:MigrationSkip) { if ($rel -ieq $s -or $rel.StartsWith($s + '\', [StringComparison]::OrdinalIgnoreCase)) { $skip = $true } }
            if (-not $skip) { [void]$out.Add($rel) }
        }
    }
    return @($out)
}

function Invoke-DataMigration {
    <# Backs up, then COPIES (never moves) config, data, reports and logs from an old checkout into the new data folder, verifies the
       copy file by file, and records it in migration.json. The old folder is not modified. Running it again does nothing. #>
    param([Parameter(Mandatory)][string]$LegacyRoot, [Parameter(Mandatory)][string]$DataDir, [string]$BackupDir = $DataDir)
    $legacy = $LegacyRoot.TrimEnd('\'); $data = $DataDir.TrimEnd('\')
    $marker = Join-Path $data 'migration.json'
    if (Test-Path -LiteralPath $marker) { return [pscustomobject]@{ status = 'already-migrated'; marker = $marker; files = 0; backup = $null } }
    if ($legacy -ieq $data) { throw 'The old folder and the new data folder are the same folder.' }
    $files = @(Get-MigrationFiles -LegacyRoot $legacy)
    if (-not $files.Count) { return [pscustomobject]@{ status = 'nothing-to-migrate'; marker = $null; files = 0; backup = $null } }
    New-Item -ItemType Directory -Path $data, $BackupDir -Force | Out-Null

    # 1. backup zip, first, so there is always a way back even if the copy is interrupted
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $zip = Join-Path $BackupDir ('migration-backup-{0:yyyyMMdd-HHmmss}.zip' -f (Get-Date))
    $skipped = New-Object System.Collections.ArrayList
    $za = [IO.Compression.ZipFile]::Open($zip, 'Create')
    try {
        foreach ($rel in $files) {
            try { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, (Join-Path $legacy $rel), $rel.Replace('\', '/'), 'Optimal') }
            catch { [void]$skipped.Add($rel) }   # a file open in another program: noted, and still copied below if it can be read
        }
    } finally { $za.Dispose() }

    # 2. copy
    $bytes = 0L; $copied = 0; $failed = New-Object System.Collections.ArrayList
    foreach ($rel in $files) {
        $from = Join-Path $legacy $rel; $to = Join-Path $data $rel
        try {
            $dir = Split-Path -Parent $to
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            Copy-Item -LiteralPath $from -Destination $to -Force -ErrorAction Stop
            $copied++; $bytes += (Get-Item -LiteralPath $from).Length
        } catch { [void]$failed.Add($rel) }
    }
    # 3. verify: every file that could be read is there with the same size
    $bad = @($files | Where-Object { ($failed -notcontains $_) -and ((-not (Test-Path -LiteralPath (Join-Path $data $_))) -or ((Get-Item -LiteralPath (Join-Path $data $_)).Length -ne (Get-Item -LiteralPath (Join-Path $legacy $_)).Length)) })
    if ($bad.Count) { throw "Verification of the copied data failed for $($bad.Count) file(s), for example '$($bad[0])'. The old folder is untouched and the backup is at $zip." }
    $rec = [ordered]@{ from = $legacy; to = $data; at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz'); files = $copied; bytes = $bytes; backupZip = $zip; backupSkipped = @($skipped); copyFailed = @($failed) }
    [IO.File]::WriteAllText($marker, ($rec | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    return [pscustomobject]@{ status = 'migrated'; marker = $marker; files = $copied; backup = $zip; failed = @($failed) }
}

function Get-Migration {
    param([Parameter(Mandatory)][string]$DataDir)
    $f = Join-Path $DataDir 'migration.json'
    if (-not (Test-Path -LiteralPath $f)) { return $null }
    try { Get-Content -LiteralPath $f -Raw | ConvertFrom-Json } catch { $null }
}

function Get-RollbackPlan {
    <# What going back to the old folder involves: the tasks and shortcuts are pointed at it again and run there as a plain checkout
       (no administrator runs, port 7879). Nothing is deleted. #>
    param([Parameter(Mandatory)][string]$DataDir)
    $m = Get-Migration -DataDir $DataDir
    if (-not $m) { throw "There is no migration record in $DataDir, so there is nothing to roll back to." }
    if (-not (Test-Path -LiteralPath (Join-Path ([string]$m.from) 'src\powershell\Scheduler.ps1'))) { throw "The old folder $($m.from) no longer has the program files, so it cannot be used again." }
    [pscustomobject]@{ legacyRoot = [string]$m.from; steps = @(
        "Register the scheduled tasks from $($m.from) (standard rights: the old folder cannot run administrator work)",
        "Point the Start Menu and Desktop shortcuts at $($m.from)",
        'Leave the installed program folder, the data folder and the backup zip in place') }
}

function Invoke-LegacyCleanup {
    <# Removes the OLD folder's config, data, reports and logs, but only after a verified migration, only those four folders, and only
       inside the folder recorded in migration.json. #>
    param([Parameter(Mandatory)][string]$DataDir)
    $m = Get-Migration -DataDir $DataDir
    if (-not $m) { throw 'There is no migration record, so Guardian will not remove anything from an old folder.' }
    $legacy = ([string]$m.from).TrimEnd('\')
    if (-not [IO.Path]::IsPathRooted($legacy) -or $legacy.Length -lt 4) { throw "The recorded old folder '$legacy' is not valid." }
    $stillThere = @(Get-MigrationFiles -LegacyRoot $legacy)
    $missing = @($stillThere | Where-Object { -not (Test-Path -LiteralPath (Join-Path $DataDir $_)) })
    if ($missing.Count) { throw "$($missing.Count) file(s) of the old folder are not in the new data folder (for example '$($missing[0])'), so nothing is removed." }
    $removed = New-Object System.Collections.ArrayList
    foreach ($d in $script:MigrationDirs) {
        $p = Join-Path $legacy $d
        if ((Test-Path -LiteralPath $p) -and ((Split-Path -Parent $p) -ieq $legacy)) { Remove-Item -LiteralPath $p -Recurse -Force; [void]$removed.Add($p) }
    }
    return @($removed)
}

function Get-UninstallLeftovers {
    <# What an uninstall leaves behind, for the final message. #>
    param([Parameter(Mandatory)]$Layout, [switch]$RemovedData)
    $left = New-Object System.Collections.ArrayList
    if (-not $RemovedData -and (Test-Path -LiteralPath $Layout.dataDir)) { [void]$left.Add("Your settings, history and reports: $($Layout.dataDir) (run the uninstaller with -RemoveData to delete them)") }
    if (Test-Path -LiteralPath $Layout.dataDir) { foreach ($z in @(Get-ChildItem -LiteralPath $Layout.dataDir -Filter 'migration-backup-*.zip' -ErrorAction SilentlyContinue)) { [void]$left.Add("Backup from the migration: $($z.FullName) (kept on purpose)") } }
    if (Test-Path -LiteralPath $Layout.elevatedDir) { [void]$left.Add("Administrator audit lines and results: $($Layout.elevatedDir) (needs administrator rights to delete)") }
    $m = if (Test-Path -LiteralPath $Layout.dataDir) { Get-Migration -DataDir $Layout.dataDir } else { $null }
    if ($m -and (Test-Path -LiteralPath ([string]$m.from))) { [void]$left.Add("The old folder: $($m.from) (never touched by the installer)") }
    return @($left)
}

Export-ModuleMember -Function Get-InstallLayout, Get-ProgramFileList, Get-InstallPlan, Copy-ProgramFiles, Write-InstallInfo, Get-MigrationFiles, Invoke-DataMigration, Get-Migration, Get-RollbackPlan, Invoke-LegacyCleanup, Get-UninstallLeftovers
