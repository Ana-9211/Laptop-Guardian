# file.recycle
# Dot-sourced by Actions\Remediation.psm1 (same module scope, so Pester mocks and exports are unchanged).
# ---------- file.recycle ----------
function Test-FileRecycle {
    param([hashtable]$P)
    $path = [string]$P.path
    $cfg = Get-GuardianConfig
    if ($path -match '[*?]') { return New-RemResult -Ok $false -Errors @('Wildcards are never accepted.') }
    if (Test-ProtectedPath -Path $path -ExtraProtected @($cfg.storage.protectedDirs)) { return New-RemResult -Ok $false -Errors @('Protected path: Windows, Program Files, ProgramData, your profile root, Guardian data and your protected folders are never touched.') }
    $fullPath = Get-LongPathName ([IO.Path]::GetFullPath($path))
    foreach ($root in @(Get-GuardianRoots)) {
        if ($fullPath -ieq $root.TrimEnd('\') -or $fullPath.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { return New-RemResult -Ok $false -Errors @('Protected path: Laptop Guardian''s own files are never recycled.') }
    }
    $files = Read-JsonFile -Path (Get-GuardianPath 'LatestFiles') -Default $null
    $cand = $null
    if ($files) { $cand = @($files.candidates | Where-Object { $_.path -ieq $path } | Select-Object -First 1)[0] }
    if (-not $cand) { return New-RemResult -Ok $false -Errors @('This file is not in the latest Guardian findings; refusing. Run a scan first.') }
    if ($cand.classification -in 'KEEP', 'HIGH_RISK', 'UNKNOWN') { return New-RemResult -Ok $false -Errors @("Guardian classified this file as $($cand.classification) and will not recycle it. Delete it yourself in Explorer if you are sure.") }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if (-not $item) { return New-RemResult -Ok $false -Errors @('The file no longer exists.') }
    if ($item.PSIsContainer) { return New-RemResult -Ok $false -Errors @('Folders are never recycled by Guardian; only single files.') }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return New-RemResult -Ok $false -Errors @('Links and junctions are never recycled.') }
    if ($item.Attributes -band [IO.FileAttributes]::System) { return New-RemResult -Ok $false -Errors @('System files are never recycled.') }
    if (Test-PathHasReparse -Path (Split-Path -Parent $path)) { return New-RemResult -Ok $false -Errors @('The path passes through a junction or symbolic link; refusing.') }
    $candModified = Get-OptionalProp $cand 'lastModified'
    if ($candModified -and ([math]::Abs(($item.LastWriteTime - [datetime]$candModified).TotalSeconds) -gt 2)) { return New-RemResult -Ok $false -Errors @('The file changed since it was analysed. Re-scan, then review again.') }
    $binProblem = Test-RecycleBinSafe -Path $path -SizeBytes ([int64]$item.Length)
    if ($binProblem) { return New-RemResult -Ok $false -Errors @($binProblem) }
    $ageDays = [int]((Get-Date) - $item.LastWriteTime).TotalDays
    return New-RemResult -Ok $true -IdentityKey (Get-StringKey @($path, $item.Length, $item.LastWriteTimeUtc.ToString('o'))) -Details ([ordered]@{ path = $path; sizeBytes = [int64]$item.Length; ageDays = $ageDays; classification = [string]$cand.classification; reason = $(if (Get-OptionalProp $cand 'whyFlagged') { (@($cand.whyFlagged) -join ' ') } else { '' }) })
}
function Invoke-FileRecycle {
    param([hashtable]$P, $Validated)
    $cfg = Get-GuardianConfig
    try { [void](Move-FileToRecycle -Path ([string]$P.path) -ProtectedDirs @($cfg.storage.protectedDirs)) } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    if (Test-Path -LiteralPath ([string]$P.path)) { return New-RemResult -Ok $false -Errors @('The file is still there after the request.') }
    return New-RemResult -Ok $true -Verified $true -Message $(if ([string]$cfg.cleanup.recycleBin -eq 'always') { 'Moved to the Recycle Bin and confirmed there. Your setting empties the Recycle Bin on every run, so restore it soon or it will be gone for good.' } else { 'Moved to the Recycle Bin and confirmed there. Open the Recycle Bin and choose Restore to undo.' }) -Details ([ordered]@{ sizeBytes = $Validated.details.sizeBytes })
}
