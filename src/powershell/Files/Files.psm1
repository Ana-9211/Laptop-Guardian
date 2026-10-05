#requires -Version 5.1
# Files: weekly candidate detection (large/old/duplicate/installer/archive/crash dump), conservative classification. Never deletes.
Set-StrictMode -Version 2.0

$script:CodeExt = @('.py', '.js', '.ts', '.tsx', '.jsx', '.cs', '.java', '.cpp', '.c', '.h', '.go', '.rs', '.rb', '.php', '.sln', '.csproj', '.ipynb', '.sql', '.ps1', '.sh', '.json', '.yaml', '.yml', '.md')
$script:SecretExt = @('.kdbx', '.pem', '.key', '.pfx', '.p12', '.ppk', '.gpg', '.asc', '.wallet', '.env', '.ovpn')
$script:VmExt = @('.vdi', '.vmdk', '.vhd', '.vhdx', '.qcow2', '.ova', '.ovf')
$script:DocExt = @('.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf', '.odt', '.txt', '.rtf', '.psd', '.ai', '.indd', '.blend', '.dwg', '.pbix')
$script:MediaExt = @('.mp4', '.mkv', '.mov', '.avi', '.mp3', '.wav', '.flac', '.jpg', '.jpeg', '.png', '.heic', '.raw', '.cr2', '.nef', '.webm')
$script:InstallerExt = @('.exe', '.msi', '.msix', '.appx', '.msixbundle', '.dmg', '.pkg')
$script:ArchiveExt = @('.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.iso', '.img', '.bz2', '.xz')
$script:RegenerableMarkers = @('\node_modules\', '\.cache\', '\__pycache__\', '\.gradle\caches\', '\.m2\repository\', '\.nuget\packages\', '\.npm\_cacache\', '\target\debug\', '\.next\cache\')

function Get-FileClassification {
    <# Pure function: metadata in, conservative classification out. Default REVIEW; UNKNOWN when we cannot say anything useful. #>
    param(
        [Parameter(Mandatory)][string]$Path, [double]$SizeMB, [int]$AgeDays, [bool]$IsDuplicate = $false, [string]$DuplicateOf = $null,
        [string[]]$ProtectedDirs = @(), [int]$OldFileDays = 365, [int]$LastAccessDays = -1
    )
    $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
    $lower = $Path.ToLowerInvariant()
    $name = [System.IO.Path]::GetFileName($Path)
    $why = New-Object System.Collections.ArrayList
    $r = [ordered]@{ classification = 'REVIEW'; category = 'other'; whatIsIt = ''; ifDeleted = ''; risk = 'LOW'; recommendedAction = 'Review before deciding'; referencedBySoftware = $null }

    if ($SizeMB -ge 500) { [void]$why.Add(("Very large file ({0:N0} MB)." -f $SizeMB)); $r.category = 'large' }
    elseif ($SizeMB -ge 50) { [void]$why.Add(("Large file ({0:N0} MB)." -f $SizeMB)); $r.category = 'large' }
    if ($AgeDays -ge $OldFileDays) { [void]$why.Add("Not modified for $AgeDays days."); if ($r.category -eq 'other') { $r.category = 'old' } }
    if ($LastAccessDays -ge 365) { [void]$why.Add("Not accessed for about $LastAccessDays days (access time may be unreliable on NTFS).") }
    if ($IsDuplicate) { [void]$why.Add("Identical content exists elsewhere: $DuplicateOf"); $r.category = 'duplicate' }

    if (Test-ProtectedPath -Path $Path -ExtraProtected $ProtectedDirs) {
        $r.classification = 'HIGH_RISK'; $r.risk = 'HIGH'; $r.whatIsIt = 'File in a protected system or user-protected location.'; $r.ifDeleted = 'May break Windows or installed software.'; $r.recommendedAction = 'Do not delete'
        [void]$why.Add('Located in a protected directory.')
    }
    elseif ($script:SecretExt -contains $ext -or $name -match '(?i)(password|secret|wallet|recovery|backup[-_ ]?code)') {
        $r.classification = 'HIGH_RISK'; $r.risk = 'HIGH'; $r.whatIsIt = 'Possible key, credential or password-vault file.'; $r.ifDeleted = 'May permanently lock you out of an account, server or vault.'; $r.recommendedAction = 'Keep'
        [void]$why.Add('File type commonly holds credentials or keys.')
    }
    elseif ($script:VmExt -contains $ext -or $name -ieq 'ext4.vhdx' -or $lower -like '*\wsl\*') {
        $r.classification = 'HIGH_RISK'; $r.risk = 'HIGH'; $r.category = 'large'; $r.whatIsIt = 'Virtual machine / WSL disk image.'; $r.ifDeleted = 'Destroys the entire virtual machine and everything stored inside it.'; $r.recommendedAction = 'Keep unless you are certain the VM is obsolete'
        [void]$why.Add('Disk image of a virtual machine.')
    }
    elseif ($ext -eq '.dmp' -or $name -ieq 'MEMORY.DMP') {
        $r.classification = 'LIKELY_UNNECESSARY'; $r.category = 'crash-dump'; $r.whatIsIt = 'Windows or application crash dump.'; $r.ifDeleted = 'Loses diagnostic data for that crash. Harmless unless you are debugging it.'; $r.recommendedAction = 'Move to Recycle Bin if not debugging'
        [void]$why.Add('Crash dump file.')
    }
    elseif ($lower -match '\\appdata\\local\\temp\\' -or $lower -match '\\windows\\temp\\' -or $ext -in @('.tmp', '.temp', '.crdownload', '.part', '.partial')) {
        $cat = if ($ext -in @('.crdownload', '.part', '.partial')) { 'abandoned-download' } else { 'temp' }
        $r.classification = 'LIKELY_UNNECESSARY'; $r.category = $cat; $r.whatIsIt = if ($cat -eq 'temp') { 'Temporary file.' } else { 'Incomplete download.' }
        $r.ifDeleted = if ($cat -eq 'temp') { 'Usually nothing; a running program may recreate it.' } else { 'The partial download is lost; re-download if still needed.' }
        $r.recommendedAction = 'Move to Recycle Bin'; [void]$why.Add($(if ($cat -eq 'temp') { 'Located in a temporary folder.' } else { 'Partial-download extension.' }))
    }
    elseif ($script:CodeExt -contains $ext -or $lower -match '\\\.git\\') {
        $r.classification = 'KEEP'; $r.risk = 'HIGH'; $r.whatIsIt = 'Source code / project or config file.'; $r.ifDeleted = 'Loses work that may not exist anywhere else.'; $r.recommendedAction = 'Keep'
        [void]$why.Add('Source or configuration file.')
    }
    elseif ($script:RegenerableMarkers | Where-Object { $lower.Contains($_) }) {
        $r.classification = 'REVIEW'; $r.category = 'other'; $r.whatIsIt = 'Dependency or build cache; regenerated by the package manager / build tool.'; $r.ifDeleted = 'Next build or install re-downloads it (needs internet, takes time). Delete the whole folder via the tool (e.g. npm cache clean), not file-by-file.'; $r.recommendedAction = 'Review; clean with the owning tool'
        [void]$why.Add('Located in a regenerable dependency/cache folder.')
    }
    elseif ($script:InstallerExt -contains $ext -and $lower -like '*\downloads\*') {
        $r.category = 'installer'; $r.whatIsIt = 'Downloaded installer.'; $r.risk = 'LOW'
        $r.ifDeleted = 'The installed program keeps working. You would need to download the installer again to reinstall.'
        if ($AgeDays -ge 30 -or $IsDuplicate -or $name -match '\(\d+\)') { $r.classification = 'LIKELY_UNNECESSARY'; $r.recommendedAction = 'Move to Recycle Bin if the program is already installed' } else { $r.recommendedAction = 'Review' }
        [void]$why.Add('Installer file in Downloads.')
    }
    elseif ($script:ArchiveExt -contains $ext) {
        $r.category = 'archive'; $r.whatIsIt = 'Compressed archive or disk image.'; $r.ifDeleted = 'Contents are lost unless already extracted or backed up.'; $r.recommendedAction = 'Review: confirm contents are extracted or backed up'
        if ($lower -like '*\downloads\*' -and $AgeDays -ge 90) { $r.classification = 'REVIEW'; [void]$why.Add('Old archive in Downloads.') }
    }
    elseif ($script:DocExt -contains $ext) {
        $r.classification = 'KEEP'; $r.risk = 'MEDIUM'; $r.whatIsIt = 'Personal document or creative project file.'; $r.ifDeleted = 'Likely irreplaceable personal data.'; $r.recommendedAction = 'Keep; consider backing up'
        [void]$why.Add('Looks like a personal document.')
    }
    elseif ($script:MediaExt -contains $ext) {
        $r.classification = 'REVIEW'; $r.risk = 'MEDIUM'; $r.whatIsIt = 'Photo, video or audio file.'; $r.ifDeleted = 'Personal media is often irreplaceable; check for a backup first.'; $r.recommendedAction = 'Review; back up before removing'
        [void]$why.Add('Personal media file.')
    }
    elseif (-not $ext) {
        $r.classification = 'UNKNOWN'; $r.risk = 'UNKNOWN'; $r.whatIsIt = 'File with no extension; purpose cannot be determined.'; $r.ifDeleted = 'Unknown.'; $r.recommendedAction = 'Investigate'
    }
    else {
        $r.whatIsIt = "Unrecognised file type ($ext)."; $r.ifDeleted = 'Unknown; check what created it first.'; $r.risk = 'UNKNOWN'; $r.classification = 'REVIEW'
    }
    if ($IsDuplicate -and $r.classification -eq 'KEEP') { $r.classification = 'REVIEW' }   # duplicate of a personal doc: user decides which copy
    if ($lower -like "$($env:LOCALAPPDATA.ToLowerInvariant())\programs\*") { $r.referencedBySoftware = $true }
    if ($why.Count -eq 0) { [void]$why.Add('Matched scan thresholds.') }
    $r['whyFlagged'] = @($why)
    [pscustomobject]$r
}

function Get-ScanRoots {
    param($Config)
    $roots = New-Object System.Collections.ArrayList
    $sysDrive = $env:SystemDrive
    foreach ($d in @($Config.storage.drives)) {
        if (-not $d) { continue }
        if ($d -notmatch '^[A-Za-z]:\\?$') { continue }   # local drive letters only (no UNC paths / arbitrary strings)
        $drv = $d.TrimEnd('\')
        if (-not (Test-Path -LiteralPath "$drv\")) { continue }
        if ($drv -ieq $sysDrive) { [void]$roots.Add($env:USERPROFILE) }
        else { [void]$roots.Add("$drv\") }
    }
    return @($roots | Select-Object -Unique)
}

function Get-FileHashCached {
    param([string]$Path, [long]$Size, [long]$MTimeTicks, $Cache, [switch]$Partial)
    $key = "{0}|{1}|{2}|{3}" -f $Path.ToLowerInvariant(), $Size, $MTimeTicks, $(if ($Partial) { 'p' } else { 'f' })
    if ($Cache.ContainsKey($key)) { return $Cache[$key] }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $fs = $null
    try {
        $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite, 65536)
        if ($Partial) { $buf = New-Object byte[] 65536; $n = $fs.Read($buf, 0, $buf.Length); $h = $sha.ComputeHash($buf, 0, $n) }
        else { $h = $sha.ComputeHash($fs) }
        $hex = ($h | ForEach-Object { $_.ToString('x2') }) -join ''
        $Cache[$key] = $hex
        return $hex
    } catch { return $null }
    finally { if ($fs) { $fs.Dispose() }; $sha.Dispose() }
}

function Find-DuplicateGroups {
    param($Entries, [long]$MinBytes, $Cache, [int]$DeadlineSec = 600, [long]$MaxHashBytes = 30GB)
    $deadline = (Get-Date).AddSeconds($DeadlineSec)
    $groups = New-Object System.Collections.ArrayList
    $hashed = 0L
    $bySize = $Entries | Where-Object { $_.Size -ge $MinBytes } | Group-Object Size | Where-Object { $_.Count -gt 1 }
    foreach ($sg in $bySize) {
        if ((Get-Date) -gt $deadline -or $hashed -gt $MaxHashBytes) { break }
        $byPartial = @{}
        foreach ($e in $sg.Group) {
            $ph = Get-FileHashCached -Path $e.Path -Size $e.Size -MTimeTicks $e.MTimeTicks -Cache $Cache -Partial
            if (-not $ph) { continue }
            if (-not $byPartial.ContainsKey($ph)) { $byPartial[$ph] = New-Object System.Collections.ArrayList }
            [void]$byPartial[$ph].Add($e)
        }
        foreach ($pg in $byPartial.Values) {
            if ($pg.Count -lt 2) { continue }
            $byFull = @{}
            foreach ($e in $pg) {
                if ((Get-Date) -gt $deadline) { break }
                $fh = Get-FileHashCached -Path $e.Path -Size $e.Size -MTimeTicks $e.MTimeTicks -Cache $Cache
                $hashed += $e.Size
                if (-not $fh) { continue }
                if (-not $byFull.ContainsKey($fh)) { $byFull[$fh] = New-Object System.Collections.ArrayList }
                [void]$byFull[$fh].Add($e)
            }
            foreach ($kv in $byFull.GetEnumerator()) {
                if ($kv.Value.Count -ge 2) {
                    $sorted = @($kv.Value | Sort-Object MTimeTicks)   # oldest first = presumed original
                    [void]$groups.Add([pscustomobject]@{ hash = $kv.Key; sizeMB = [math]::Round($sorted[0].Size / 1MB, 1); wastedMB = [math]::Round($sorted[0].Size * ($sorted.Count - 1) / 1MB, 1); files = @($sorted | ForEach-Object { $_.Path }) })
                }
            }
        }
    }
    return @($groups)
}

function Invoke-FileAnalysis {
    <# Weekly storage analysis. Returns the files.json payload. #>
    param($Config, [int]$DeadlineSec = 1800)
    Initialize-FsWalker
    $deadline = [datetime]::UtcNow.AddSeconds($DeadlineSec)
    $minLarge = [long]$Config.storage.minLargeFileMB * 1MB
    $minDup = [long]$Config.storage.duplicateMinMB * 1MB
    $minScan = [math]::Min($minLarge, $(if ($Config.storage.duplicateScan) { $minDup } else { $minLarge }))
    $excluded = @($Config.storage.excludedDirs) + @(Get-ProtectedPathPrefixes) + @($Config.storage.protectedDirs)
    $entries = New-Object System.Collections.ArrayList
    $totalBytes = 0L; $truncated = $false; $errors = 0; $totalFiles = 0L
    foreach ($root in (Get-ScanRoots $Config)) {
        [void](Write-GuardianEvent -Category file -Action 'files:scan-started' -Target $root -Result started)
        $w = [Guardian.FsWalker]::Walk($root, [string[]]$excluded, $minScan, [datetime]::MinValue, 300000, $deadline)
        foreach ($e in $w.Entries) { [void]$entries.Add($e) }
        $totalBytes += $w.TotalBytes; $totalFiles += $w.TotalFiles; $errors += $w.Errors; if ($w.Truncated) { $truncated = $true }
    }
    # Old files in Downloads (smaller threshold)
    $dl = Join-Path $env:USERPROFILE 'Downloads'
    if (Test-Path -LiteralPath $dl) {
        $w = [Guardian.FsWalker]::Walk($dl, [string[]]$excluded, 1MB, [datetime]::UtcNow.AddDays(-90), 20000, $deadline)
        $have = @{}; foreach ($e in $entries) { $have[$e.Path.ToLowerInvariant()] = $true }
        foreach ($e in $w.Entries) { if (-not $have.ContainsKey($e.Path.ToLowerInvariant())) { [void]$entries.Add($e) } }
        if ($w.Truncated) { $truncated = $true }
    }
    # crash dumps explicitly
    foreach ($d in @("$env:LOCALAPPDATA\CrashDumps")) {
        if (Test-Path -LiteralPath $d) { $w = [Guardian.FsWalker]::Walk($d, [string[]]@(), 0, [datetime]::MinValue, 2000, $deadline); foreach ($e in $w.Entries) { [void]$entries.Add($e) } }
    }

    $cache = @{}
    $cached = Read-JsonFile -Path (Get-GuardianPath 'FileCache') -Default $null
    if ($cached) { foreach ($p in $cached.PSObject.Properties) { $cache[$p.Name] = $p.Value } }
    $dups = @()
    if ($Config.storage.duplicateScan) {
        $remain = [int]([math]::Max(30, ($deadline - [datetime]::UtcNow).TotalSeconds))
        $dups = @(Find-DuplicateGroups -Entries $entries -MinBytes $minDup -Cache $cache -DeadlineSec ([math]::Min(900, $remain)))
        # prune cache to keep it bounded
        if ($cache.Count -gt 50000) { $cache = @{} }
        Write-JsonFile -Path (Get-GuardianPath 'FileCache') -Object $cache
    }
    $dupLookup = @{}
    foreach ($g in $dups) { for ($i = 1; $i -lt $g.files.Count; $i++) { $dupLookup[$g.files[$i].ToLowerInvariant()] = $g.files[0] } }

    $now = Get-Date
    $cands = New-Object System.Collections.ArrayList
    $old = $Config.storage.oldFileDays
    foreach ($e in ($entries | Sort-Object Size -Descending)) {
        $sizeMB = [math]::Round($e.Size / 1MB, 1)
        $m = [datetime]::new($e.MTimeTicks, [DateTimeKind]::Utc).ToLocalTime()
        $a = [datetime]::new($e.ATimeTicks, [DateTimeKind]::Utc).ToLocalTime()
        $age = [int]($now - $m).TotalDays
        $isDup = $dupLookup.ContainsKey($e.Path.ToLowerInvariant())
        $isLarge = $e.Size -ge $minLarge
        $ext = [System.IO.Path]::GetExtension($e.Path).ToLowerInvariant()
        $interesting = $isLarge -or $isDup -or ($ext -eq '.dmp') -or ($age -ge 90 -and $e.Path -like "$dl\*") -or ($e.Path -like "$env:LOCALAPPDATA\CrashDumps\*")
        if (-not $interesting) { continue }
        $c = Get-FileClassification -Path $e.Path -SizeMB $sizeMB -AgeDays $age -IsDuplicate $isDup -DuplicateOf $(if ($isDup) { $dupLookup[$e.Path.ToLowerInvariant()] } else { $null }) -ProtectedDirs @($Config.storage.protectedDirs) -OldFileDays $old -LastAccessDays ([int]($now - $a).TotalDays)
        $sha = [System.Security.Cryptography.SHA1]::Create()
        try { $id = (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($e.Path.ToLowerInvariant())) | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12) } finally { $sha.Dispose() }
        [void]$cands.Add([pscustomobject][ordered]@{
                id = $id; path = $e.Path; name = [System.IO.Path]::GetFileName($e.Path); sizeMB = $sizeMB; lastModified = ConvertTo-IsoTime $m; lastAccessed = ConvertTo-IsoTime $a
                ageDays = $age; extension = $ext; classification = $c.classification; category = $c.category; whatIsIt = $c.whatIsIt; whyFlagged = @($c.whyFlagged)
                duplicateOf = $(if ($isDup) { $dupLookup[$e.Path.ToLowerInvariant()] } else { $null }); referencedBySoftware = $c.referencedBySoftware
                ifDeleted = $c.ifDeleted; risk = $c.risk; recommendedAction = $c.recommendedAction; ignored = $false
            })
    }
    $top = @($cands | Select-Object -First 400)
    $largest = @($entries | Sort-Object Size -Descending | Select-Object -First 50 | ForEach-Object { [pscustomobject]@{ path = $_.Path; sizeMB = [math]::Round($_.Size / 1MB, 1) } })
    [void](Write-GuardianEvent -Category file -Action 'files:recommendations-generated' -Target "$($top.Count) candidates" -Result success -Reason "scanned $totalFiles files; truncated=$truncated")
    $drives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ drive = $_.DeviceID; totalGB = [math]::Round($_.Size / 1GB, 1); freeGB = [math]::Round($_.FreeSpace / 1GB, 1) } })
    $reclaim = [math]::Round((($top | Where-Object { $_.classification -eq 'LIKELY_UNNECESSARY' } | Measure-Object sizeMB -Sum).Sum) / 1024, 2)
    [pscustomobject][ordered]@{
        generatedAt = Get-IsoNow; drives = $drives; truncated = $truncated; scannedFiles = $totalFiles; scannedGB = [math]::Round($totalBytes / 1GB, 1); errors = $errors
        candidates = $top; largest = $largest; duplicates = @($dups | Sort-Object wastedMB -Descending | Select-Object -First 100)
        downloads = (Get-DownloadsStats); reclaimableGB = $reclaim
    }
}

Export-ModuleMember -Function *
