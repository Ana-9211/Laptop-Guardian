. "$PSScriptRoot\Helpers.ps1"
$repo = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $repo 'src\powershell\Launcher\Launcher.psm1') -Force

function New-LauncherRoot([int]$Port, [switch]$NoDist) {
    $r = Join-Path ([IO.Path]::GetTempPath()) ("lg-launch-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $r, "$r\config", "$r\src\dashboard\dist", "$r\data\state" -Force | Out-Null
    Copy-Item (Join-Path $repo 'src\bridge') "$r\src\bridge" -Recurse
    Copy-Item (Join-Path $repo 'src\shared') "$r\src\shared" -Recurse   # the bridge reads the action catalog from here
    if (-not $NoDist) { Set-Content "$r\src\dashboard\dist\index.html" '<!doctype html><title>t</title>' }
    ([ordered]@{ bridge = [ordered]@{ host = '127.0.0.1'; port = $Port } } | ConvertTo-Json) | Set-Content "$r\config\config.json"
    return $r
}
function Stop-LauncherBridge($Root, $Port) {
    $p = Get-BridgePing -Port $Port
    if ($p) { Stop-Process -Id $p.pid -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 400 }
    Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
}
function Get-FreePort { $l = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0); $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); return $p }

Describe 'Launcher helpers' {
    It 'finds Node.js and reports a major version >= 18' {
        $n = Find-NodeExe; $n | Should Not BeNullOrEmpty
        ((Get-NodeMajor $n) -ge 22) | Should Be $true
    }
    It 'reads the bridge port from config and falls back to the default for a checkout (7879; an installed copy uses 7878)' {
        $r = New-LauncherRoot -Port 18123; (Get-BridgePort -Root $r) | Should Be 18123
        Remove-Item "$r\config\config.json"; (Get-BridgePort -Root $r) | Should Be 7879
        Set-Content "$r\config\config.json" '{ not json'; (Get-BridgePort -Root $r) | Should Be 7879
        Set-Content (Join-Path $r 'install.json') ('{ "dataRoot": "' + ($r -replace '\\', '\\') + '", "elevatedDir": "' + ($r -replace '\\', '\\') + '" }')
        Remove-Item "$r\config\config.json"; (Get-BridgePort -Root $r) | Should Be 7878
        Remove-Item $r -Recurse -Force
    }
    It 'returns $null when nothing answers on the port' { (Get-BridgePing -Port (Get-FreePort) -TimeoutSec 1) | Should BeNullOrEmpty }
    It 'detects a closed vs open port' {
        $port = Get-FreePort; (Test-PortInUse -Port $port) | Should Be $false
        $l = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $port); $l.Start()
        try { (Test-PortInUse -Port $port) | Should Be $true } finally { $l.Stop() }
    }
    It 'finds an app-capable browser on this machine (Edge or Chrome) or returns $null without throwing' {
        $b = Find-AppBrowser; if ($b) { (Test-Path $b.Path) | Should Be $true }
    }
    It 'detects no app window for an unused profile directory' { @(Get-AppWindowProcess -ProfileDir (Join-Path ([IO.Path]::GetTempPath()) 'lg-no-such-profile')).Count | Should Be 0 }
}

Describe 'Start-GuardianDashboard' {
    It 'starts the bridge once, waits until it is reachable, and does not start a second one' {
        $port = Get-FreePort; $r = New-LauncherRoot -Port $port
        try {
            $a = Start-GuardianDashboard -Root $r -NoBrowser
            $a.ok | Should Be $true; $a.bridge | Should Be 'started'; $a.url | Should Be "http://127.0.0.1:$port/"
            $ping = Get-BridgePing -Port $port; $ping.app | Should Be 'laptop-guardian'
            $b = Start-GuardianDashboard -Root $r -NoBrowser
            $b.ok | Should Be $true; $b.bridge | Should Be 'already-running'
            # Exactly ONE existing app window: a StrictMode '.Count on a single object' error was once logged here. The window is focused, none is opened.
            Mock -ModuleName Launcher Get-AppWindowProcess { [pscustomobject]@{ ProcessId = 4242 } }
            Mock -ModuleName Launcher Set-ForegroundWindowOfProcess { $true }
            $f = Start-GuardianDashboard -Root $r
            $f.ok | Should Be $true; $f.window | Should Be 'focused'
            (Get-BridgePing -Port $port).pid | Should Be $ping.pid        # same process: no duplicate bridge
            @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$r*server.js*" }).Count | Should Be 1
            (Get-Content "$r\data\state\bridge.json" -Raw | ConvertFrom-Json).pid | Should Be $ping.pid
            $code = try { (Invoke-WebRequest "http://127.0.0.1:$port/api/status" -UseBasicParsing).StatusCode } catch { [int]$_.Exception.Response.StatusCode }
            $code | Should Be 401                                         # no session token, no API
            $tok = Get-BridgeToken -Root $r -Ping $ping; $tok | Should Not BeNullOrEmpty
            Get-BridgeToken -Root $r -Ping ([pscustomobject]@{ pid = 1 }) | Should BeNullOrEmpty   # a token is only trusted for the bridge that answered
            $s = Invoke-RestMethod "http://127.0.0.1:$port/api/status" -UseBasicParsing -Headers @{ Authorization = "Bearer $tok" }; $s.bridge.ok | Should Be $true
        } finally { Stop-LauncherBridge $r $port }
    }
    It 'returns promptly when its output is piped (the bridge must not inherit the caller pipes)' {
        $port = Get-FreePort; $r = New-LauncherRoot -Port $port
        try {
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $json = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Import-Module '$repo\src\powershell\Launcher\Launcher.psm1' -Force; Start-GuardianDashboard -Root '$r' -NoBrowser | ConvertTo-Json" | Out-String
            ($sw.Elapsed.TotalSeconds -lt 25) | Should Be $true
            ($json | ConvertFrom-Json).bridge | Should Be 'started'
            (Get-BridgePing -Port $port) | Should Not BeNullOrEmpty
        } finally { Stop-LauncherBridge $r $port }
    }
    It 'gives an actionable error when the dashboard is not built' {
        $port = Get-FreePort; $r = New-LauncherRoot -Port $port -NoDist
        try {
            $x = Start-GuardianDashboard -Root $r -NoBrowser
            $x.ok | Should Be $false; $x.bridge | Should Be 'failed'
            $x.message | Should Match 'not been built'; $x.message | Should Match 'Install-LaptopGuardian'
            (Get-Content "$r\logs\launcher.log" -Raw) | Should Match 'ERROR'
        } finally { Remove-Item $r -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It 'refuses to start when another program holds the port, and says so' {
        $port = Get-FreePort; $r = New-LauncherRoot -Port $port
        $l = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $port); $l.Start()
        try {
            $x = Start-GuardianDashboard -Root $r -NoBrowser
            $x.ok | Should Be $false; $x.message | Should Match 'in use by another program'
        } finally { $l.Stop(); Remove-Item $r -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It 'recovers from a stale bridge.json left by a crashed bridge' {
        $port = Get-FreePort; $r = New-LauncherRoot -Port $port
        try {
            Set-Content "$r\data\state\bridge.json" '{"app":"laptop-guardian","pid":2147483000,"port":1}'
            $x = Start-GuardianDashboard -Root $r -NoBrowser
            $x.ok | Should Be $true; $x.bridge | Should Be 'started'
            (Get-Content "$r\data\state\bridge.json" -Raw | ConvertFrom-Json).pid | Should Not Be 2147483000
        } finally { Stop-LauncherBridge $r $port }
    }
    It 'replaces an outdated bridge of this install that answers with the wrong identity' {
        $port = Get-FreePort; $r = New-LauncherRoot -Port $port
        # a stand-in "old bridge": same script path in its command line, but no /api/ping
        $old = Join-Path $r 'src\bridge\server.js'; $backup = Get-Content $old -Raw
        Set-Content $old "require('http').createServer((q,s)=>{s.writeHead(200);s.end('old')}).listen($port,'127.0.0.1')"
        $p = Start-Process (Find-NodeExe) -ArgumentList "`"$old`"" -WindowStyle Hidden -PassThru
        try {
            Start-Sleep -Milliseconds 600; (Test-PortInUse -Port $port) | Should Be $true
            Set-Content $old $backup
            $x = Start-GuardianDashboard -Root $r -NoBrowser
            $x.ok | Should Be $true; $x.bridge | Should Be 'started'
            $p.Refresh(); $p.HasExited | Should Be $true
        } finally { if (-not $p.HasExited) { $p.Kill() }; Stop-LauncherBridge $r $port }
    }
}

Describe 'Bridge ownership and lifecycle safety' {
    It 'only treats `node <this install server.js>` as ours; lookalikes and other scripts are ignored and never stopped' {
        $port = Get-FreePort; $r = New-LauncherRoot -Port $port
        $script = Join-Path $r 'src\bridge\server.js'
        $decoy = Join-Path $r 'decoy.js'; Set-Content $decoy "setTimeout(()=>{}, 60000)"
        # decoy: a different script that merely mentions our server.js path as an argument
        $d = Start-Process (Find-NodeExe) -ArgumentList "`"$decoy`" `"$script`"" -WindowStyle Hidden -PassThru
        try {
            Start-Sleep -Milliseconds 700
            @(Get-OwnedBridgeProcesses -Root $r).Count | Should Be 0
            (Stop-OwnedBridge -Root $r) | Should Be 0
            $d.Refresh(); $d.HasExited | Should Be $false
        } finally { if (-not $d.HasExited) { $d.Kill() }; Remove-Item $r -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It 'never stops a bridge that belongs to another installation, and says which one holds the port' {
        $port = Get-FreePort; $a = New-LauncherRoot -Port $port; $b = New-LauncherRoot -Port $port
        try {
            (Start-GuardianDashboard -Root $a -NoBrowser).bridge | Should Be 'started'
            $pidA = (Get-BridgePing -Port $port).pid
            (Get-BridgeOwnership -Ping (Get-BridgePing -Port $port) -Root $a) | Should Be 'this-install'
            (Get-BridgeOwnership -Ping (Get-BridgePing -Port $port) -Root $b) | Should Be 'other'
            $x = Start-GuardianDashboard -Root $b -NoBrowser
            $x.ok | Should Be $false; $x.message | Should Match 'another installation'
            (Get-BridgePing -Port $port).pid | Should Be $pidA        # untouched
            (Get-Process -Id $pidA -ErrorAction SilentlyContinue) | Should Not BeNullOrEmpty
        } finally { Stop-LauncherBridge $a $port; Remove-Item $b -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It 'does not stop a bridge process that is younger than the boot grace period' {
        $port = Get-FreePort; $r = New-LauncherRoot -Port $port
        $old = Join-Path $r 'src\bridge\server.js'; $backup = Get-Content $old -Raw
        Set-Content $old "setTimeout(()=>{}, 60000)"
        $p = Start-Process (Find-NodeExe) -ArgumentList "`"$old`"" -WindowStyle Hidden -PassThru
        try {
            Start-Sleep -Milliseconds 700
            @(Get-OwnedBridgeProcesses -Root $r).Count | Should Be 1
            (Stop-OwnedBridge -Root $r -MinAgeSec 15) | Should Be 0
            $p.Refresh(); $p.HasExited | Should Be $false
            (Stop-OwnedBridge -Root $r) | Should Be 1               # no grace requested: it is ours, so it is stopped
            $p.WaitForExit(3000) | Out-Null; $p.HasExited | Should Be $true
        } finally { if (-not $p.HasExited) { $p.Kill() }; Set-Content $old $backup; Remove-Item $r -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It 'keeps bridge.json that names a live bridge of this install, and removes one that names a dead or foreign pid' {
        $port = Get-FreePort; $r = New-LauncherRoot -Port $port
        try {
            (Start-GuardianDashboard -Root $r -NoBrowser).ok | Should Be $true
            Clear-StaleBridgeFile -Root $r; (Test-Path "$r\data\state\bridge.json") | Should Be $true
            Set-Content "$r\data\state\bridge.json" ('{"app":"laptop-guardian","pid":' + $PID + ',"port":1}')   # this test process is not a bridge
            Clear-StaleBridgeFile -Root $r; (Test-Path "$r\data\state\bridge.json") | Should Be $false
        } finally { Stop-LauncherBridge $r $port }
    }
    It 'the bridge reports its own root in /api/ping' {
        $port = Get-FreePort; $r = New-LauncherRoot -Port $port
        try { (Start-GuardianDashboard -Root $r -NoBrowser) | Out-Null; (Get-BridgePing -Port $port).root | Should Be $r } finally { Stop-LauncherBridge $r $port }
    }
}

Describe 'Shortcuts' {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("lg-lnk-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path "$tmp\src\powershell" -Force | Out-Null
    Set-Content "$tmp\src\powershell\Start-Dashboard.ps1" '# stub'
    It 'creates a shortcut that points at the launcher with -Gui and verifies it' {
        $p = New-GuardianShortcut -Path "$tmp\Laptop Guardian.lnk" -Root $tmp
        (Test-Path $p) | Should Be $true
        $l = (New-Object -ComObject WScript.Shell).CreateShortcut($p)
        $l.Arguments | Should Match 'Start-Dashboard\.ps1'; $l.Arguments | Should Match '-Gui'; $l.Arguments | Should Match 'Hidden'
        (Test-GuardianShortcut -Path $p -Root $tmp).ok | Should Be $true
    }
    It 'flags a shortcut whose launcher script has gone missing, and a missing shortcut' {
        Remove-Item "$tmp\src\powershell\Start-Dashboard.ps1"
        (Test-GuardianShortcut -Path "$tmp\Laptop Guardian.lnk" -Root $tmp).ok | Should Be $false
        (Test-GuardianShortcut -Path "$tmp\nope.lnk" -Root $tmp).ok | Should Be $false
        Remove-Item $tmp -Recurse -Force
    }
    It 'uses the standard Start Menu and Desktop locations named "Laptop Guardian.lnk"' {
        $s = Get-GuardianShortcutPaths
        (Split-Path $s.StartMenu -Leaf) | Should Be 'Laptop Guardian.lnk'; (Split-Path $s.Desktop -Leaf) | Should Be 'Laptop Guardian.lnk'
    }
    It 'installer creates Start Menu + Desktop shortcuts by default, offers opt-outs, and tests never touch real shortcuts' {
        $inst = Get-Content (Join-Path $repo 'Install-LaptopGuardian.ps1') -Raw
        $inst | Should Match 'NoDesktopShortcut'; $inst | Should Match 'SkipShortcuts'; $inst | Should Match 'Test-GuardianShortcut'
        (Get-Content (Join-Path $repo 'tests\Integration.Tests.ps1') -Raw) | Should Match '-SkipShortcuts'
        (Test-Path (Join-Path $repo 'Open-LaptopGuardian.cmd')) | Should Be $true
        (Test-Path (Join-Path $repo 'src\assets\guardian.ico')) | Should Be $true
    }
}

Describe 'Start-Dashboard.ps1 -Check' {
    It 'prints diagnostics as JSON without starting anything' {
        $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'src\powershell\Start-Dashboard.ps1') -Check -Json | Out-String
        $j = $out | ConvertFrom-Json
        $j.url | Should Match '^http://127\.0\.0\.1:\d+/$'
        ($j.PSObject.Properties.Name -contains 'dashboardBuilt') | Should Be $true
        ($j.PSObject.Properties.Name -contains 'appBrowser') | Should Be $true
    }
}

Describe 'Run-state markers' {
    It 'daily and weekly agents record mode and pid in the run-state marker; weekly records shutdownPossible' {
        $w = Get-Content (Join-Path $repo 'src\powershell\Weekly.ps1') -Raw; $d = Get-Content (Join-Path $repo 'src\powershell\Daily.ps1') -Raw
        $w | Should Match "mode = \`$runMode; shutdownPossible"; $w | Should Match 'pid = \$PID'
        $d | Should Match "mode = \`$runMode; pid = \`$PID"
        (Get-Content (Join-Path $repo 'src\powershell\Scheduler.ps1') -Raw) | Should Match 'Daily\.ps1`" -Scheduled'
    }
}
