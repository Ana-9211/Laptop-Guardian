#requires -Version 5.1
<#
.SYNOPSIS  Builds the dashboard and packs the installable program files into a zip with a SHA-256 checksum. Publishes nothing.
.DESCRIPTION
  The zip holds exactly what the installer copies (the same list, from Install\Installer.psm1: Get-ProgramFileList) plus the installer scripts, the
  README, CHANGELOG.md and the documents under docs\ (not docs\history). It never contains tests, dashboard source, node_modules, config, data,
  reports or logs. The result is a folder LaptopGuardian-<version>\ inside the zip, so extracting it gives one tidy folder to run the installer from.
.PARAMETER OutDir     Where to write the zip, its .sha256 file and a manifest. Default: .\release (created if missing).
.PARAMETER SkipBuild  Use the dashboard build that is already in src\dashboard\dist (it must exist).
.NOTES     Nothing is uploaded, tagged or pushed. Code is not signed; the checksum only proves the file was not changed after it was made.
#>
[CmdletBinding()]
param([string]$OutDir, [switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root 'release' }
Import-Module (Join-Path $root 'src\powershell\Install\Installer.psm1') -Force -DisableNameChecking

$pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string]$pkg.version
if ($version -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') { throw "package.json has no usable version ('$version')." }

# ---------- the dashboard ----------
$dash = Join-Path $root 'src\dashboard'
if (-not $SkipBuild) {
    Push-Location $dash
    try {
        if (-not (Test-Path 'node_modules\.package-lock.json')) { & npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed in src\dashboard.' } }
        & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'The dashboard build failed (type check or bundle).' }
    } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath (Join-Path $dash 'dist\index.html'))) { throw 'The dashboard has not been built (src\dashboard\dist\index.html is missing). Run without -SkipBuild.' }

# ---------- the file list ----------
$files = New-Object System.Collections.ArrayList
foreach ($f in @(Get-ProgramFileList -SourceRoot $root)) { [void]$files.Add($f) }
foreach ($extra in 'CHANGELOG.md') { if (Test-Path -LiteralPath (Join-Path $root $extra)) { [void]$files.Add($extra) } }
foreach ($d in @(Get-ChildItem -LiteralPath (Join-Path $root 'docs') -Filter *.md -File -ErrorAction SilentlyContinue)) { [void]$files.Add("docs\$($d.Name)") }
$files = @($files | Sort-Object -Unique)
$bad = @($files | Where-Object { $_ -match '^(tests|config|data|reports|logs|node_modules|release)\\|\\node_modules\\|^docs\\history\\|^src\\dashboard\\src\\|\.lock$|\.tmp$' })
if ($bad.Count) { throw "Refusing to pack files that must not ship: $($bad[0])" }
if (-not ($files -contains 'src\powershell\Common\Core.psm1' -and $files -contains 'src\bridge\server.js' -and $files -contains 'Install-LaptopGuardian.ps1')) { throw 'The file list is incomplete.' }

# ---------- the zip ----------
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$name = "LaptopGuardian-$version"
$zip = Join-Path $OutDir "$name.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$za = [IO.Compression.ZipFile]::Open($zip, 'Create')
try {
    foreach ($rel in $files) {
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, (Join-Path $root $rel), ("$name/" + $rel.Replace('\', '/')), 'Optimal')
    }
} finally { $za.Dispose() }

# ---------- checksum and manifest ----------
$sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$zip.sha256", "$sha  $name.zip`n", (New-Object Text.UTF8Encoding($false)))
$commit = $null; $dirty = $null
try { $commit = (& git -C $root rev-parse HEAD 2>$null); $dirty = [bool]((& git -C $root status --porcelain 2>$null) | Select-Object -First 1) } catch { }
$manifest = [ordered]@{ name = $name; version = $version; builtAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz'); sha256 = $sha; files = $files.Count; sourceCommit = $commit; sourceHadUncommittedChanges = $dirty; signed = $false }
[IO.File]::WriteAllText("$zip.manifest.json", ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))

$size = (Get-Item -LiteralPath $zip).Length
Write-Host "Release package (nothing was published):" -ForegroundColor Green
Write-Host "  $zip  ($($files.Count) files, $([math]::Round($size / 1MB, 2)) MB)"
Write-Host "  SHA-256 $sha"
if ($dirty) { Write-Host '  Note: the working tree has uncommitted changes, so this package is not an exact copy of any commit.' -ForegroundColor Yellow }
Write-Host '  Not code-signed. To check a download: Get-FileHash <zip> -Algorithm SHA256 and compare with the .sha256 file.' -ForegroundColor Gray
[pscustomobject]@{ zip = $zip; sha256 = $sha; files = $files.Count; bytes = $size }
