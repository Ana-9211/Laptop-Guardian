. "$PSScriptRoot\Helpers.ps1"
# End-to-end in a COPY of the repo: install (sandbox task folder) -> real daily scan -> bridge API -> uninstall. Slow (~2-3 min).
$copy = Join-Path $env:TEMP ('guardian-e2e-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
$folder = '\LaptopGuardianE2E\'
$port = 17999
Remove-Item Env:\GUARDIAN_ROOT -ErrorAction SilentlyContinue
$skip = @('node_modules', '.git', (Join-Path $script:RepoRoot 'data'), (Join-Path $script:RepoRoot 'reports'), (Join-Path $script:RepoRoot 'logs'), (Join-Path $script:RepoRoot 'config'))
& robocopy $script:RepoRoot $copy /E /XD $skip /XF *.log /NFL /NDL /NJH /NJS /NP | Out-Null
$script:bridge = $null
function Get-Status($url, $headers = @{}) { try { [int](Invoke-WebRequest $url -Headers $headers -UseBasicParsing -TimeoutSec 10).StatusCode } catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } } }

Describe 'Install -> scan -> dashboard -> uninstall' {
    It 'installer completes (sandbox task folder, safe test scan)' {
        $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $copy 'Install-LaptopGuardian.ps1') -SkipBuild -TaskFolder $folder 2>&1 | Out-String
        $out | Should Match 'Installed\. Dashboard'
        (Test-Path (Join-Path $copy 'config\config.json')) | Should Be $true
        (Test-Path (Join-Path $copy 'config\process-policy.json')) | Should Be $true
        @(Get-ChildItem (Join-Path $copy 'reports\daily') -Directory).Count | Should BeGreaterThan 0
        (Test-Path (Join-Path $copy 'data\latest\processes.json')) | Should Be $true
    }
    It 'installed config is in Safe Mode and tasks exist' {
        (Get-Content (Join-Path $copy 'config\config.json') -Raw | ConvertFrom-Json).safety.safeMode | Should Be $true
        (Get-ScheduledTask -TaskPath $folder -TaskName 'Daily Audit').State | Should Not BeNullOrEmpty
    }
    It 'dashboard bridge serves real data from the report the daily agent produced' {
        $env:GUARDIAN_PORT = [string]$port
        $script:bridge = Start-Process node -ArgumentList ('"' + (Join-Path $copy 'src\bridge\server.js') + '"') -WorkingDirectory $copy -WindowStyle Hidden -PassThru
        $up = $false
        1..20 | ForEach-Object { if (-not $up) { if ((Get-Status "http://127.0.0.1:$port/api/run") -eq 200) { $up = $true } else { Start-Sleep -Milliseconds 500 } } }
        $up | Should Be $true
        $ov = (Invoke-WebRequest "http://127.0.0.1:$port/api/overview" -UseBasicParsing).Content | ConvertFrom-Json
        $ov.daily.type | Should Be 'daily'
        $ov.daily.healthScore | Should BeGreaterThan 0
        @($ov.metrics).Count | Should BeGreaterThan 0
        $procs = (Invoke-WebRequest "http://127.0.0.1:$port/api/processes" -UseBasicParsing).Content | ConvertFrom-Json
        @($procs.processes).Count | Should BeGreaterThan 20
        $reps = @((Invoke-WebRequest "http://127.0.0.1:$port/api/reports?type=daily" -UseBasicParsing).Content | ConvertFrom-Json)
        $reps.Count | Should Be 1
        $html = Invoke-WebRequest "http://127.0.0.1:$port/api/reports/daily/$($reps[0].id)/html" -UseBasicParsing
        $html.Content | Should Match 'Laptop Guardian'
        (Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing).Content | Should Match 'id="root"'
    }
    It 'bridge blocks mutating requests without the CSRF header' {
        $code = try { (Invoke-WebRequest "http://127.0.0.1:$port/api/process/kill" -Method Post -Body '{}' -ContentType 'application/json' -UseBasicParsing).StatusCode } catch { [int]$_.Exception.Response.StatusCode }
        $code | Should Be 403
    }
    It 'bridge rejects a foreign Host header (DNS-rebinding defence)' {
        $client = New-Object System.Net.Sockets.TcpClient('127.0.0.1', $port)
        $s = $client.GetStream(); $req = [Text.Encoding]::ASCII.GetBytes("GET /api/overview HTTP/1.1`r`nHost: evil.example.com`r`nConnection: close`r`n`r`n"); $s.Write($req, 0, $req.Length)
        $buf = New-Object byte[] 256; $n = $s.Read($buf, 0, 256); $client.Close()
        [Text.Encoding]::ASCII.GetString($buf, 0, $n) | Should Not Match '^HTTP/1.1 200'
    }
    It 'policy added through the API is honoured by the PowerShell agent (round trip)' {
        $h = @{ 'X-Guardian' = '1'; Origin = "http://127.0.0.1:$port" }
        Invoke-WebRequest "http://127.0.0.1:$port/api/policy" -Method Post -Headers $h -ContentType 'application/json' -Body '{"list":"whitelist","name":"mytool","reason":"e2e"}' -UseBasicParsing | Out-Null
        $pol = Get-Content (Join-Path $copy 'config\process-policy.json') -Raw | ConvertFrom-Json
        @($pol.whitelist | Where-Object { $_.name -eq 'mytool' }).Count | Should Be 1
        $env:GUARDIAN_ROOT = $copy
        . (Join-Path $copy 'src\powershell\Common\Load.ps1')
        (Find-PolicyMatch -Policy (Get-ProcessPolicy) -Name 'mytool' -Path 'C:\x').list | Should Be 'whitelist'
        Remove-Item Env:\GUARDIAN_ROOT
    }
    It 'uninstaller removes tasks but preserves reports' {
        if ($script:bridge) { Stop-Process -Id $script:bridge.Id -Force -ErrorAction SilentlyContinue }
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $copy 'Uninstall-LaptopGuardian.ps1') -TaskFolder $folder 2>&1 | Out-Null
        @(Get-ScheduledTask -TaskPath $folder -ErrorAction SilentlyContinue).Count | Should Be 0
        @(Get-ChildItem (Join-Path $copy 'reports\daily') -Directory).Count | Should BeGreaterThan 0
    }
}
if ($script:bridge) { Stop-Process -Id $script:bridge.Id -Force -ErrorAction SilentlyContinue }
Remove-Item Env:\GUARDIAN_PORT -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Remove-Item $copy -Recurse -Force -ErrorAction SilentlyContinue
