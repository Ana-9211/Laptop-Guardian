#requires -Version 5.1
<# Starts the local dashboard bridge (127.0.0.1 only) if it is not already running, then opens the browser. #>
[CmdletBinding()] param([switch]$NoBrowser)
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cfgPath = Join-Path $root 'config\config.json'
$port = 7878
try { if (Test-Path $cfgPath) { $port = [int](Get-Content $cfgPath -Raw | ConvertFrom-Json).bridge.port } } catch { }
$url = "http://127.0.0.1:$port/"
function Test-Up { try { $null = Invoke-WebRequest -Uri "${url}api/run" -UseBasicParsing -TimeoutSec 2; $true } catch { $false } }
if (-not (Test-Up)) {
    $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $node) { Write-Error 'Node.js not found. Install Node 18+ from https://nodejs.org'; exit 1 }
    if (-not (Test-Path (Join-Path $root 'src\dashboard\dist\index.html'))) { Write-Error 'Dashboard not built. Run Install-LaptopGuardian.ps1 (or: cd src\dashboard; npm install; npm run build).'; exit 1 }
    Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $root 'src\bridge\server.js')`"" -WorkingDirectory $root -WindowStyle Hidden
    for ($i = 0; $i -lt 20 -and -not (Test-Up); $i++) { Start-Sleep -Milliseconds 500 }
}
if (Test-Up) { Write-Host "Laptop Guardian dashboard: $url"; if (-not $NoBrowser) { Start-Process $url } } else { Write-Error 'Dashboard bridge did not start.'; exit 1 }
