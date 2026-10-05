. "$PSScriptRoot\Helpers.ps1"
$root = New-TestRoot; Import-Guardian; Initialize-GuardianDirectories; Initialize-FsWalker
$dl = "$env:USERPROFILE\Downloads"

Describe 'File classification' {
    It 'crash dumps are LIKELY_UNNECESSARY' { $c = Get-FileClassification -Path "$env:LOCALAPPDATA\CrashDumps\app.dmp" -SizeMB 200 -AgeDays 10; $c.classification | Should Be 'LIKELY_UNNECESSARY'; $c.category | Should Be 'crash-dump' }
    It 'old installers in Downloads are LIKELY_UNNECESSARY' { (Get-FileClassification -Path "$dl\setup.exe" -SizeMB 80 -AgeDays 120).classification | Should Be 'LIKELY_UNNECESSARY' }
    It 'new installers are only REVIEW' { (Get-FileClassification -Path "$dl\setup.exe" -SizeMB 80 -AgeDays 3).classification | Should Be 'REVIEW' }
    It 'password vaults / keys are HIGH_RISK, never suggested for deletion' { $c = Get-FileClassification -Path "$env:USERPROFILE\vault.kdbx" -SizeMB 1 -AgeDays 900; $c.classification | Should Be 'HIGH_RISK'; $c.recommendedAction | Should Match 'Keep' }
    It 'files named like secrets are HIGH_RISK' { (Get-FileClassification -Path "$env:USERPROFILE\Desktop\my passwords.txt" -SizeMB 1 -AgeDays 5).classification | Should Be 'HIGH_RISK' }
    It 'VM disk images are HIGH_RISK' { (Get-FileClassification -Path "$env:USERPROFILE\VMs\a.vdi" -SizeMB 14000 -AgeDays 400).classification | Should Be 'HIGH_RISK' }
    It 'source code is KEEP' { (Get-FileClassification -Path "$env:USERPROFILE\proj\main.py" -SizeMB 60 -AgeDays 900).classification | Should Be 'KEEP' }
    It 'documents are KEEP even when old and large' { (Get-FileClassification -Path "$env:USERPROFILE\Documents\thesis.pdf" -SizeMB 90 -AgeDays 2000).classification | Should Be 'KEEP' }
    It 'protected paths are HIGH_RISK' { (Get-FileClassification -Path "$env:SystemRoot\System32\big.dll" -SizeMB 900 -AgeDays 900).classification | Should Be 'HIGH_RISK' }
    It 'user-protected dirs are HIGH_RISK' { (Get-FileClassification -Path "$env:USERPROFILE\Keep\x.bin" -SizeMB 900 -AgeDays 900 -ProtectedDirs @("$env:USERPROFILE\Keep")).classification | Should Be 'HIGH_RISK' }
    It 'unknown extension-less files are UNKNOWN' { (Get-FileClassification -Path "$env:USERPROFILE\Downloads\blob" -SizeMB 600 -AgeDays 5).classification | Should Be 'UNKNOWN' }
    It 'defaults to REVIEW for unrecognised types' { (Get-FileClassification -Path "$env:USERPROFILE\Downloads\thing.xyz" -SizeMB 600 -AgeDays 5).classification | Should Be 'REVIEW' }
    It 'incomplete downloads / temp are LIKELY_UNNECESSARY' { (Get-FileClassification -Path "$dl\movie.mkv.crdownload" -SizeMB 300 -AgeDays 40).category | Should Be 'abandoned-download' }
    It 'duplicate documents are downgraded to REVIEW (user picks the copy)' { (Get-FileClassification -Path "$env:USERPROFILE\Documents\a (1).pdf" -SizeMB 60 -AgeDays 10 -IsDuplicate $true -DuplicateOf 'x').classification | Should Be 'REVIEW' }
    It 'always explains itself' {
        $c = Get-FileClassification -Path "$dl\setup.exe" -SizeMB 80 -AgeDays 120
        $c.whatIsIt | Should Not BeNullOrEmpty; $c.ifDeleted | Should Not BeNullOrEmpty; @($c.whyFlagged).Count | Should BeGreaterThan 0
    }
}

Describe 'File walker robustness' {
    $d = Join-Path $root 'walk'; New-Item -ItemType Directory $d | Out-Null
    1..30 | ForEach-Object { Set-Content (Join-Path $d "f$_.bin") ('x' * 2000) }
    It 'finds files above the size threshold' { $w = [Guardian.FsWalker]::Walk($d, @(), 1000, [datetime]::MinValue, 1000, [datetime]::UtcNow.AddSeconds(30)); $w.Entries.Count | Should Be 30 }
    It 'skips excluded directories' { New-Item -ItemType Directory "$d\skip" | Out-Null; Set-Content "$d\skip\a.bin" ('x' * 5000); $w = [Guardian.FsWalker]::Walk($d, @("$d\skip"), 1000, [datetime]::MinValue, 1000, [datetime]::UtcNow.AddSeconds(30)); @($w.Entries | Where-Object { $_.Path -like '*skip*' }).Count | Should Be 0 }
    It 'honours its deadline' { $w = [Guardian.FsWalker]::Walk($root, @(), 0, [datetime]::MinValue, 1000, [datetime]::UtcNow.AddSeconds(-1)); $w.Truncated | Should Be $true }
    It 'tolerates files vanishing during the scan' {
        $j = Start-Job -ArgumentList $d { param($d) 1..30 | ForEach-Object { Remove-Item (Join-Path $d "f$_.bin") -Force -ErrorAction SilentlyContinue } }
        { $null = [Guardian.FsWalker]::Walk($d, @(), 0, [datetime]::MinValue, 1000, [datetime]::UtcNow.AddSeconds(30)) } | Should Not Throw
        Receive-Job $j -Wait | Out-Null; Remove-Job $j
    }
    It 'does not follow junctions (no infinite loops)' {
        $j1 = Join-Path $d 'junc'; cmd /c mklink /J "$j1" "$d" 2>&1 | Out-Null
        $w = [Guardian.FsWalker]::Walk($d, @(), 0, [datetime]::MinValue, 100000, [datetime]::UtcNow.AddSeconds(20))
        $w.Truncated | Should Be $false
        cmd /c rmdir "$j1" 2>&1 | Out-Null
    }
    It 'tolerates an unreadable path' { { $null = [Guardian.FsWalker]::Walk('C:\System Volume Information', @(), 0, [datetime]::MinValue, 100, [datetime]::UtcNow.AddSeconds(10)) } | Should Not Throw }
}

Describe 'Duplicate detection' {
    $d = Join-Path $root 'dups'; New-Item -ItemType Directory $d | Out-Null
    $bytes = New-Object byte[] 200000; (New-Object Random 5).NextBytes($bytes)
    [IO.File]::WriteAllBytes("$d\a.bin", $bytes); [IO.File]::WriteAllBytes("$d\b.bin", $bytes)
    $other = New-Object byte[] 200000; (New-Object Random 6).NextBytes($other); [IO.File]::WriteAllBytes("$d\c.bin", $other)
    $w = [Guardian.FsWalker]::Walk($d, @(), 1000, [datetime]::MinValue, 1000, [datetime]::UtcNow.AddSeconds(30))
    It 'groups identical files and ignores same-size different content' {
        $g = @(Find-DuplicateGroups -Entries $w.Entries -MinBytes 1000 -Cache @{})
        $g.Count | Should Be 1
        @($g[0].files).Count | Should Be 2
        ($g[0].files -join ';') | Should Not Match 'c\.bin'
    }
    It 'skips files it cannot open (locked) without failing' {
        $fs = [IO.File]::Open("$d\a.bin", 'Open', 'Read', 'None')
        try { { $null = Find-DuplicateGroups -Entries $w.Entries -MinBytes 1000 -Cache @{} } | Should Not Throw } finally { $fs.Dispose() }
    }
}

Describe 'Safe cleanup' {
    $cfgDry = [pscustomobject]@{ safety = [pscustomobject]@{ safeMode = $true; automationPaused = $false }; cleanup = [pscustomobject]@{ tempFiles = $true; crashDumps = $false; caches = $false; tempMinAgeDays = 2; recycleBin = 'never' } }
    It 'only plans (dry run) in safe mode and deletes nothing' {
        $old = Join-Path $env:TEMP "guardian-cleanup-probe-$([guid]::NewGuid().ToString('N')).tmp"
        Set-Content $old 'x'; (Get-Item $old).LastWriteTime = (Get-Date).AddDays(-10)
        try {
            $r = Invoke-SafeCleanup -Config $cfgDry
            $r.performed | Should Be $false
            (Test-Path $old) | Should Be $true
        } finally { Remove-Item $old -Force -ErrorAction SilentlyContinue }
    }
    It 'deletes only OLD files in allowlisted dirs when safe mode is off; keeps fresh and locked files' {
        $cfg = [pscustomobject]@{ safety = [pscustomobject]@{ safeMode = $false; automationPaused = $false }; cleanup = [pscustomobject]@{ tempFiles = $true; crashDumps = $false; caches = $false; tempMinAgeDays = 2; recycleBin = 'never' } }
        $tag = [guid]::NewGuid().ToString('N')
        $old = Join-Path $env:TEMP "gcl-old-$tag.tmp"; $new = Join-Path $env:TEMP "gcl-new-$tag.tmp"; $locked = Join-Path $env:TEMP "gcl-locked-$tag.tmp"
        Set-Content $old 'x'; Set-Content $new 'x'; Set-Content $locked 'x'
        (Get-Item $old).LastWriteTime = (Get-Date).AddDays(-10); (Get-Item $locked).LastWriteTime = (Get-Date).AddDays(-10)
        $fs = [IO.File]::Open($locked, 'Open', 'Read', 'None')
        try {
            $r = Invoke-SafeCleanup -Config $cfg
            $r.performed | Should Be $true
            (Test-Path $old) | Should Be $false
            (Test-Path $new) | Should Be $true
            (Test-Path $locked) | Should Be $true      # in use: skipped, no exception
        } finally { $fs.Dispose(); Remove-Item $old, $new, $locked -Force -ErrorAction SilentlyContinue }
    }
    It 'never targets anything outside the allowlist' {
        foreach ($t in @(Get-CleanupTargets -Admin $true)) { ($t.path -like "$env:LOCALAPPDATA\*" -or $t.path -like "$env:SystemRoot\Temp" -or $t.path -like "$env:SystemRoot\Minidump") | Should Be $true }
    }
}
Remove-TestRoot $root
