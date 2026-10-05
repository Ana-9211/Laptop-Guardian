#requires -Version 5.1
# Storage: sizing of temp/crash/cache areas, Downloads stats, large files, and strictly allowlisted safe cleanup.
Set-StrictMode -Version 2.0

function Initialize-FsWalker {
    if ('Guardian.FsWalker' -as [type]) { return }
    $src = Join-Path $PSScriptRoot 'FsWalker.cs'
    Add-Type -Path $src -ErrorAction Stop
}

function Test-PathHasReparse {
    # $true if the path or any ancestor (up to the drive root) is a reparse point (junction / symlink)
    param([string]$Path)
    try {
        $p = $Path.TrimEnd('\')
        while ($p -and $p.Length -gt 3) {
            $i = Get-Item -LiteralPath $p -Force -ErrorAction Stop
            if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $true }
            $p = Split-Path -Parent $p
        }
        return $false
    } catch { return $true }   # fail closed
}

function Get-CleanupTargets {
    <# The ONLY locations cleanup may ever touch. Each is a well-known, regenerable Windows location. #>
    param([bool]$Admin = $false)
    $local = $env:LOCALAPPDATA
    $t = @(
        @{ kind = 'temp'; path = $env:TEMP; requiresAdmin = $false },
        @{ kind = 'crashDumps'; path = (Join-Path $local 'CrashDumps'); requiresAdmin = $false },
        @{ kind = 'crashDumps'; path = (Join-Path $local 'Microsoft\Windows\WER\ReportArchive'); requiresAdmin = $false },
        @{ kind = 'crashDumps'; path = (Join-Path $local 'Microsoft\Windows\WER\ReportQueue'); requiresAdmin = $false },
        @{ kind = 'caches'; path = (Join-Path $local 'Microsoft\Windows\INetCache'); requiresAdmin = $false },
        @{ kind = 'caches'; path = (Join-Path $local 'D3DSCache'); requiresAdmin = $false }
        # %SystemRoot%\Temp and Minidump are deliberately not cleaned: deleting inside folders that ordinary users can write to,
        # from an elevated run, would let a junction planted there redirect the delete.
    )
    foreach ($x in $t) {
        if (-not $x.path) { continue }
        if ($x.requiresAdmin -and -not $Admin) { continue }
        if (-not (Test-Path -LiteralPath $x.path -PathType Container)) { continue }
        # sanity: must be under local appdata or windows dir
        $full = [System.IO.Path]::GetFullPath($x.path).TrimEnd('\')
        $okRoot = ($local -and $full.StartsWith($local.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) -or ($env:SystemRoot -and $full.StartsWith($env:SystemRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase))
        if (-not $okRoot) { continue }
        # Refuse junctions/symlinks anywhere between the anchor and the target (cleanup must never follow a link out of the allowlist)
        if (Test-PathHasReparse -Path $full) { continue }
        # %TEMP% is user-controlled: it must resolve to a real folder under LocalAppData\Temp
        if ($x.kind -eq 'temp' -and -not $x.requiresAdmin -and -not $full.StartsWith((Join-Path $local 'Temp'), [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        [pscustomobject]@{ kind = $x.kind; path = $full }
    }
}

function Get-AreaSize {
    param([string]$Path, [int]$DeadlineSec = 20)
    Initialize-FsWalker
    $r = [Guardian.FsWalker]::Walk($Path, @(), [long]::MaxValue, [datetime]::MinValue, 0, [datetime]::UtcNow.AddSeconds($DeadlineSec))
    return [pscustomobject]@{ files = $r.TotalFiles; mb = [math]::Round($r.TotalBytes / 1MB, 1); truncated = $r.Truncated }
}

function Get-DownloadsStats {
    param([int]$OldDays = 90)
    $dl = Join-Path $env:USERPROFILE 'Downloads'
    $r = [pscustomobject]@{ count = 0; sizeGB = 0.0; oldCount = 0; installersMB = 0.0 }
    if (-not (Test-Path -LiteralPath $dl)) { return $r }
    Initialize-FsWalker
    $w = [Guardian.FsWalker]::Walk($dl, @(), 0, [datetime]::MinValue, 200000, [datetime]::UtcNow.AddSeconds(30))
    $cut = (Get-Date).AddDays(-$OldDays).ToUniversalTime().Ticks
    $installerBytes = 0L; $old = 0
    foreach ($e in $w.Entries) {
        if ($e.MTimeTicks -lt $cut) { $old++ }
        if ([System.IO.Path]::GetExtension($e.Path) -in @('.exe', '.msi', '.msix', '.appx', '.msixbundle') -and $e.MTimeTicks -lt (Get-Date).AddDays(-30).ToUniversalTime().Ticks) { $installerBytes += $e.Size }
    }
    $r.count = [int]$w.TotalFiles; $r.sizeGB = [math]::Round($w.TotalBytes / 1GB, 2); $r.oldCount = $old; $r.installersMB = [math]::Round($installerBytes / 1MB, 1)
    return $r
}

function Get-StorageSummary {
    param($Config, [int]$LargeScanSec = 45)
    $admin = Test-IsAdmin
    $targets = @(Get-CleanupTargets -Admin $admin)
    $sizes = @{ temp = 0.0; crashDumps = 0.0; caches = 0.0 }
    foreach ($t in $targets) { $s = Get-AreaSize -Path $t.path; $sizes[$t.kind] += $s.mb }
    $dl = Get-DownloadsStats
    # Quick large-file scan of the usual personal folders only (full-drive scan is weekly)
    $large = New-Object System.Collections.ArrayList
    $minBytes = [long]$Config.storage.minLargeFileMB * 1MB
    Initialize-FsWalker
    $deadline = [datetime]::UtcNow.AddSeconds($LargeScanSec)
    foreach ($sub in 'Downloads', 'Desktop', 'Documents', 'Videos') {
        $p = Join-Path $env:USERPROFILE $sub
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $w = [Guardian.FsWalker]::Walk($p, @($Config.storage.excludedDirs), $minBytes, [datetime]::MinValue, 500, $deadline)
        foreach ($e in $w.Entries) { [void]$large.Add([pscustomobject]@{ path = $e.Path; sizeMB = [math]::Round($e.Size / 1MB, 1) }) }
    }
    [pscustomobject][ordered]@{
        tempMB = [math]::Round($sizes.temp, 1); crashDumpMB = [math]::Round($sizes.crashDumps, 1); cacheMB = [math]::Round($sizes.caches, 1)
        installersMB = $dl.installersMB; downloads = [pscustomobject]@{ count = $dl.count; sizeGB = $dl.sizeGB; oldCount = $dl.oldCount }
        largeFiles = @($large | Sort-Object sizeMB -Descending | Select-Object -First 25); duplicateCandidates = 0
    }
}

function Invoke-SafeCleanup {
    <# Deletes only files (never directories) older than N days inside allowlisted regenerable locations. Honors safe mode (dry run). #>
    param($Config)
    $res = [ordered]@{ performed = $false; safeMode = [bool]$Config.safety.safeMode; items = @(); totalFreedMB = 0.0 }
    Initialize-FsWalker
    $admin = Test-IsAdmin
    $enabled = @{ temp = [bool]$Config.cleanup.tempFiles; crashDumps = [bool]$Config.cleanup.crashDumps; caches = [bool]$Config.cleanup.caches }
    $dry = [bool]$Config.safety.safeMode -or [bool]$Config.safety.automationPaused
    $minAge = [math]::Max(1, [int]$Config.cleanup.tempMinAgeDays)
    $older = [datetime]::UtcNow.AddDays(-$minAge)
    $items = New-Object System.Collections.ArrayList
    $total = 0L
    foreach ($t in (Get-CleanupTargets -Admin $admin)) {
        if (-not $enabled[$t.kind]) { continue }
        if (-not $dry -and (Test-PathHasReparse -Path $t.path)) { [void](Write-GuardianEvent -Category cleanup -Action "cleanup:$($t.kind)" -Target $t.path -Result skipped -Severity warning -Reason 'The folder or one of its parents is a junction/symlink; nothing was deleted.'); continue }
        $w = [Guardian.FsWalker]::Walk($t.path, @(), 0, $older, 100000, [datetime]::UtcNow.AddSeconds(60))
        $freed = 0L; $deleted = 0; $failed = 0
        foreach ($e in $w.Entries) {
            if ($dry) { $freed += $e.Size; $deleted++; continue }
            try {
                $item = Get-Item -LiteralPath $e.Path -Force -ErrorAction Stop
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $failed++; continue }   # never follow or delete links
                Remove-Item -LiteralPath $e.Path -Force -ErrorAction Stop; $freed += $e.Size; $deleted++
            } catch { $failed++ }   # in use / denied: skip silently
        }
        $total += $freed
        $result = if ($dry) { 'would-delete' } elseif ($failed -gt 0 -and $deleted -eq 0) { 'failed' } else { 'deleted' }
        [void]$items.Add([pscustomobject]@{ kind = $t.kind; path = $t.path; freedMB = [math]::Round($freed / 1MB, 1); files = $deleted; skipped = $failed; result = $result })
        [void](Write-GuardianEvent -Category cleanup -Action "cleanup:$($t.kind)" -Target $t.path -Result $(if ($dry) { 'skipped' } elseif ($result -eq 'failed') { 'failure' } else { 'success' }) -Reason $(if ($dry) { "Dry run (safe mode/paused): $deleted file(s), $([math]::Round($freed/1MB,1)) MB would be removed" } else { "$deleted file(s) older than $minAge day(s), $([math]::Round($freed/1MB,1)) MB" }))
    }
    # Recycle Bin policy (permanent removal of items YOU already deleted; opt-in via Settings, never in safe mode)
    $rb = [string]$Config.cleanup.recycleBin
    if ($rb -in 'always', 'older-than-30-days') {
        if ($dry) { [void](Write-GuardianEvent -Category cleanup -Action 'cleanup:recycle-bin' -Result skipped -Reason "Dry run (safe mode/paused): policy '$rb' not applied") }
        else {
            try {
                if ($rb -eq 'always') { Clear-RecycleBin -Force -ErrorAction Stop; [void](Write-GuardianEvent -Category cleanup -Action 'cleanup:recycle-bin' -Result success -Reason 'Emptied per policy: always') }
                else { [void](Write-GuardianEvent -Category cleanup -Action 'cleanup:recycle-bin' -Result skipped -Reason "Policy 'older-than-30-days' is not supported safely (locale-dependent dates); nothing removed. Use 'always' or 'never'.") }
            } catch { [void](Write-GuardianEvent -Category cleanup -Action 'cleanup:recycle-bin' -Result failure -Severity warning -ErrorDetails $_.Exception.Message) }
        }
    }
    $res.performed = (-not $dry); $res.items = @($items); $res.totalFreedMB = [math]::Round($total / 1MB, 1)
    [pscustomobject]$res
}

Export-ModuleMember -Function *
