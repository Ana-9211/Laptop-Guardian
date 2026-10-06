# storage.clean-temp, cleanup.empty-recycle-bin, file.delete-permanent.
# Dot-sourced by Actions\Remediation.psm1 (same module scope, so Pester mocks and exports are unchanged).
# These are the only deletions Guardian offers. They stay inside regenerable locations, never follow links and never touch protected paths.

# ---------- storage.clean-temp (user level: temp files, crash dumps, caches older than your age setting) ----------
function Get-CleanupTargetsForAction { Get-CleanupTargets -Admin $false }
function Get-CleanupFiles {
    <# Files (never folders) older than the cutoff inside one allowlisted location. Does not follow links. #>
    param([string]$Path, [datetime]$OlderThanUtc)
    Initialize-FsWalker
    $w = [Guardian.FsWalker]::Walk($Path, @(), 0, $OlderThanUtc, 100000, [datetime]::UtcNow.AddSeconds(60))
    return @($w.Entries)
}
function Test-CleanTemp {
    param([hashtable]$P)
    $kinds = if ([string]$P.scope -eq 'all') { @('temp', 'crashDumps', 'caches') } else { @([string]$P.scope) }
    $cfg = Get-GuardianConfig
    $minAge = [math]::Max(1, [int]$cfg.cleanup.tempMinAgeDays)
    $older = [datetime]::UtcNow.AddDays(-$minAge)
    $targets = @(Get-CleanupTargetsForAction | Where-Object { $kinds -contains $_.kind })
    if (-not $targets.Count) { return New-RemResult -Ok $false -Errors @('Guardian found no cleanup location of this kind that is safe to use on this laptop.') }
    $files = 0; $bytes = 0L
    foreach ($t in $targets) { foreach ($e in @(Get-CleanupFiles -Path $t.path -OlderThanUtc $older)) { $files++; $bytes += [int64]$e.Size } }
    if ($files -eq 0) { return New-RemResult -Ok $false -Errors @("Nothing to clean: no file older than $minAge day(s) in these locations.") }
    return New-RemResult -Ok $true -IdentityKey (Get-StringKey @('clean', [string]$P.scope, $minAge)) -Details ([ordered]@{ scope = [string]$P.scope; files = $files; sizeMB = [math]::Round($bytes / 1MB, 1); minAgeDays = $minAge; locations = @($targets | ForEach-Object { $_.path }) })
}
function Invoke-CleanTemp {
    param([hashtable]$P, $Validated)
    $kinds = if ([string]$P.scope -eq 'all') { @('temp', 'crashDumps', 'caches') } else { @([string]$P.scope) }
    $cfg = Get-GuardianConfig
    $older = [datetime]::UtcNow.AddDays(-([math]::Max(1, [int]$cfg.cleanup.tempMinAgeDays)))
    $freed = 0L; $deleted = 0; $skipped = 0
    foreach ($t in @(Get-CleanupTargetsForAction | Where-Object { $kinds -contains $_.kind })) {
        if (Test-PathHasReparse -Path $t.path) { $skipped++; continue }
        foreach ($e in @(Get-CleanupFiles -Path $t.path -OlderThanUtc $older)) {
            try {
                $item = Get-Item -LiteralPath $e.Path -Force -ErrorAction Stop
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $skipped++; continue }
                Remove-Item -LiteralPath $e.Path -Force -ErrorAction Stop; $freed += [int64]$e.Size; $deleted++
            } catch { $skipped++ }   # in use or denied: left alone
        }
    }
    if ($deleted -eq 0) { return New-RemResult -Ok $false -Errors @('Every file was in use or protected, so nothing was removed.') }
    return New-RemResult -Ok $true -Verified $true -Message "Removed $deleted file(s), $([math]::Round($freed / 1MB, 1)) MB freed ($skipped skipped because they were in use)." -Details ([ordered]@{ files = $deleted; freedMB = [math]::Round($freed / 1MB, 1); skipped = $skipped })
}

# ---------- cleanup.empty-recycle-bin ----------
function Get-RecycleBinSizeForAction {
    $bytes = 0L; $count = 0
    try { $shell = New-Object -ComObject Shell.Application; foreach ($i in @($shell.Namespace(0xA).Items())) { $count++; $bytes += [int64]$i.Size } } catch { }
    [pscustomobject]@{ bytes = $bytes; items = $count }
}
function Clear-RecycleBinForAction { Clear-RecycleBin -Force -ErrorAction Stop }
function Test-EmptyRecycleBin {
    $b = Get-RecycleBinSizeForAction
    if ($b.items -eq 0) { return New-RemResult -Ok $false -Errors @('The Recycle Bin is already empty.') }
    return New-RemResult -Ok $true -IdentityKey (Get-StringKey @('recycle-bin', $b.items)) -Details ([ordered]@{ items = $b.items; sizeMB = [math]::Round($b.bytes / 1MB, 1) })
}
function Invoke-EmptyRecycleBin {
    $before = Get-RecycleBinSizeForAction
    try { Clear-RecycleBinForAction } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    $after = Get-RecycleBinSizeForAction
    if ($after.items -gt 0) { return New-RemResult -Ok $false -Errors @("$($after.items) item(s) are still in the Recycle Bin (in use or denied).") }
    return New-RemResult -Ok $true -Verified $true -Message "Recycle Bin emptied ($($before.items) item(s), $([math]::Round($before.bytes / 1MB, 1)) MB). This cannot be undone." -Details ([ordered]@{ items = $before.items; freedMB = [math]::Round($before.bytes / 1MB, 1) })
}

# ---------- file.delete-permanent ----------
# Only (a) files that are already in the current user's Recycle Bin, or (b) files inside a cleanup location. Never a protected path, a link, a folder or a system file.
function Get-CurrentUserSid { [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
function Test-PermanentDeleteLocation {
    <# 'recycle-bin', 'cleanup:<kind>', or $null when the path is in neither. #>
    param([string]$FullPath)
    $drive = [IO.Path]::GetPathRoot($FullPath).TrimEnd('\')
    $bin = "$drive\`$Recycle.Bin\$(Get-CurrentUserSid)"
    if ($FullPath.StartsWith($bin + '\', [StringComparison]::OrdinalIgnoreCase)) { return 'recycle-bin' }
    foreach ($t in @(Get-CleanupTargetsForAction)) { if ($FullPath.StartsWith($t.path.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { return "cleanup:$($t.kind)" } }
    return $null
}
function Test-FilePermanentDelete {
    param([hashtable]$P)
    $path = [string]$P.path
    if ($path -match '[*?]') { return New-RemResult -Ok $false -Errors @('Wildcards are never accepted.') }
    $full = Get-LongPathName ([IO.Path]::GetFullPath($path))
    $where = Test-PermanentDeleteLocation -FullPath $full
    if (-not $where) { return New-RemResult -Ok $false -Errors @('Guardian deletes permanently only files that are already in your Recycle Bin or in a temp, crash-dump or cache location. Use Recycle for anything else.') }
    if ($where -ne 'recycle-bin') {
        $cfg = Get-GuardianConfig
        if (Test-ProtectedPath -Path $full -ExtraProtected @($cfg.storage.protectedDirs)) { return New-RemResult -Ok $false -Errors @('Protected path: Guardian will not delete this.') }
    }
    foreach ($root in @(Get-GuardianRoots)) { if ($full -ieq $root.TrimEnd('\') -or $full.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { return New-RemResult -Ok $false -Errors @('Protected path: Laptop Guardian''s own folders are never deleted.') } }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
    if (-not $item) { return New-RemResult -Ok $false -Errors @('The file no longer exists.') }
    if ($item.PSIsContainer) { return New-RemResult -Ok $false -Errors @('Folders are never deleted by Guardian; only single files.') }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return New-RemResult -Ok $false -Errors @('Links and junctions are never deleted.') }
    if ($item.Attributes -band [IO.FileAttributes]::System) { return New-RemResult -Ok $false -Errors @('System files are never deleted.') }
    if (Test-PathHasReparse -Path (Split-Path -Parent $full)) { return New-RemResult -Ok $false -Errors @('The path passes through a junction or symbolic link; refusing.') }
    return New-RemResult -Ok $true -IdentityKey (Get-StringKey @($full, $item.Length, $item.LastWriteTimeUtc.ToString('o'))) -Details ([ordered]@{ path = $full; location = $where; sizeBytes = [int64]$item.Length; name = $item.Name })
}
function Invoke-FilePermanentDelete {
    param([hashtable]$P, $Validated)
    $full = Get-LongPathName ([IO.Path]::GetFullPath([string]$P.path))
    try { Remove-Item -LiteralPath $full -Force -ErrorAction Stop } catch { return New-RemResult -Ok $false -Errors @("The file could not be deleted: $($_.Exception.Message)") }
    if (Test-Path -LiteralPath $full) { return New-RemResult -Ok $false -Errors @('The file is still there after the delete.') }
    return New-RemResult -Ok $true -Verified $true -Message "Permanently deleted $($Validated.details.name) ($([math]::Round([double]$Validated.details.sizeBytes / 1MB, 2)) MB). This cannot be undone."
}
