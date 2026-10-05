#requires -Version 5.1
# Launcher: one-click start of the local dashboard. Starts the bridge if needed, waits for it, opens an app-style window.
# Never opens a duplicate window or bridge, and always explains failures (message box when started from a shortcut).
Set-StrictMode -Version 2.0
$script:BridgeBootGraceSec = 15   # a bridge process younger than this may still be starting (e.g. begun by the logon task); never kill it

function Write-LauncherLog {
    param([string]$Root, [string]$Message)
    try {
        $dir = Join-Path $Root 'logs'; if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $f = Join-Path $dir 'launcher.log'
        if ((Test-Path $f) -and (Get-Item $f).Length -gt 512KB) { Move-Item $f "$f.old" -Force }
        Add-Content -Path $f -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $Message) -Encoding UTF8
    } catch { }
}

function Get-GuardianRoot { Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) }

function Find-NodeExe {
    $c = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) { if ($p -and (Test-Path $p)) { return $p } }
    return $null
}

function Get-NodeMajor {
    param([string]$Node)
    try { $v = (& $Node -v 2>$null | Select-Object -First 1); if ($v -match 'v(\d+)\.') { return [int]$Matches[1] } } catch { }
    return 0
}

function Get-BridgePort {
    param([string]$Root)
    $port = 7878
    try { $cfg = Join-Path $Root 'config\config.json'; if (Test-Path $cfg) { $p = [int](Get-Content $cfg -Raw | ConvertFrom-Json).bridge.port; if ($p -ge 1024 -and $p -le 65535) { $port = $p } } } catch { }
    return $port
}

function Get-BridgePing {
    <# Returns the /api/ping object if a Laptop Guardian bridge answers on the port, else $null. #>
    param([int]$Port, [int]$TimeoutSec = 2)
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/ping" -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
        if ($r -and $r.app -eq 'laptop-guardian') { return $r }
    } catch { }
    return $null
}

function Test-PortInUse {
    param([int]$Port)
    $c = New-Object System.Net.Sockets.TcpClient
    try { $iar = $c.BeginConnect('127.0.0.1', $Port, $null, $null); if ($iar.AsyncWaitHandle.WaitOne(500) -and $c.Connected) { return $true } return $false } catch { return $false } finally { $c.Close() }
}

function Find-AppBrowser {
    <# Edge first (always present on Windows 11), then Chrome. Returns @{ Name; Path } or $null. #>
    $cands = @(
        @{ Name = 'Microsoft Edge'; Keys = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe'); Files = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") },
        @{ Name = 'Google Chrome'; Keys = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe'); Files = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") }
    )
    foreach ($c in $cands) {
        foreach ($k in $c.Keys) { try { $p = (Get-ItemProperty -Path $k -ErrorAction Stop).'(default)'; if ($p -and (Test-Path $p)) { return [pscustomobject]@{ Name = $c.Name; Path = $p } } } catch { } }
        foreach ($f in $c.Files) { if ($f -and (Test-Path $f)) { return [pscustomobject]@{ Name = $c.Name; Path = $f } } }
    }
    return $null
}

function Get-AppWindowProcess {
    <# Browser processes that belong to Guardian's dedicated app profile (so we can detect an already-open window). #>
    param([string]$ProfileDir)
    $needle = $ProfileDir.TrimEnd('\')
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -notmatch '--type=' }
        return @($procs)
    } catch { return @() }
}

function Set-ForegroundWindowOfProcess {
    param([int[]]$ProcessIds)
    try {
        if (-not ('GuardianWin32' -as [type])) {
            Add-Type -Namespace '' -Name 'GuardianWin32' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr h, int cmd);
'@
        }
        foreach ($id in $ProcessIds) {
            $p = Get-Process -Id $id -ErrorAction SilentlyContinue
            if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { [void][GuardianWin32]::ShowWindowAsync($p.MainWindowHandle, 9); [void][GuardianWin32]::SetForegroundWindow($p.MainWindowHandle); return $true }
        }
    } catch { }
    return $false
}

function Show-LauncherError {
    param([string]$Root, [string]$Message, [switch]$Gui)
    Write-LauncherLog -Root $Root -Message "ERROR $Message"
    if ($Gui) { try { [void](New-Object -ComObject WScript.Shell).Popup($Message, 0, 'Laptop Guardian', 0x10) } catch { } }
    else { Write-Host "Laptop Guardian: $Message" -ForegroundColor Red }
}

function Get-OwnedBridgeProcesses {
    <# node.exe processes whose command line is exactly `node <this install's server.js>`. Nothing else is ever considered ours. #>
    param([string]$Root)
    $script = Join-Path $Root 'src\bridge\server.js'
    $pattern = '^\s*(?:"[^"]*"|\S+)\s+"?' + [regex]::Escape($script) + '"?(?:\s|$)'
    $now = Get-Date
    try {
        return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop | Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern } | ForEach-Object {
            [pscustomobject]@{ ProcessId = [int]$_.ProcessId; CreationDate = $_.CreationDate; AgeSec = $(if ($_.CreationDate) { [int]($now - $_.CreationDate).TotalSeconds } else { 9999 }) }
        })
    } catch { return @() }
}

function Get-BridgeOwnership {
    <# 'this-install' when the answering bridge was started from $Root, else 'other'. Bridges from before `root` was reported are matched by process. #>
    param($Ping, [string]$Root)
    if ($Ping.PSObject.Properties['root'] -and $Ping.root) {
        $a = [IO.Path]::GetFullPath([string]$Ping.root).TrimEnd('\'); $b = [IO.Path]::GetFullPath($Root).TrimEnd('\')
        return $(if ($a -ieq $b) { 'this-install' } else { 'other' })
    }
    if (@(Get-OwnedBridgeProcesses -Root $Root | Where-Object { $_.ProcessId -eq [int]$Ping.pid }).Count -gt 0) { return 'this-install' }
    return 'other'
}

function Stop-OwnedBridge {
    <# Stops this install's bridge process(es). Re-checks identity (PID + start time) immediately before stopping so a recycled PID is never hit. #>
    param([string]$Root, [int]$MinAgeSec = 0)
    $stopped = 0
    foreach ($p in @(Get-OwnedBridgeProcesses -Root $Root)) {
        if ($p.AgeSec -lt $MinAgeSec) { Write-LauncherLog -Root $Root -Message "bridge pid $($p.ProcessId) is only $($p.AgeSec) s old; leaving it to finish starting"; continue }
        $live = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
        if (-not $live) { continue }
        try { if ($p.CreationDate -and [math]::Abs(($live.StartTime - $p.CreationDate).TotalSeconds) -gt 2) { Write-LauncherLog -Root $Root -Message "pid $($p.ProcessId) was reused; not stopping it"; continue } } catch { continue }
        Write-LauncherLog -Root $Root -Message "stopping unresponsive/outdated bridge pid $($p.ProcessId)"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $stopped++
    }
    if ($stopped) { Start-Sleep -Milliseconds 500 }
    return $stopped
}

function Clear-StaleBridgeFile {
    <# Removes data\state\bridge.json unless it names a live bridge process of this install. #>
    param([string]$Root)
    $f = Join-Path $Root 'data\state\bridge.json'
    if (-not (Test-Path $f)) { return }
    try {
        $pidInFile = [int](Get-Content $f -Raw | ConvertFrom-Json).pid
        if (@(Get-OwnedBridgeProcesses -Root $Root | Where-Object { $_.ProcessId -eq $pidInFile }).Count -gt 0) { return }
    } catch { }
    Remove-Item $f -Force -ErrorAction SilentlyContinue
}

function Stop-StaleBridge {
    <# Replaces a hung or outdated bridge of THIS install and clears a pid file left by a crashed bridge. #>
    param([string]$Root, [int]$MinAgeSec = 0)
    try { [void](Stop-OwnedBridge -Root $Root -MinAgeSec $MinAgeSec) } catch { }
    Clear-StaleBridgeFile -Root $Root
}

function Get-LaunchDiagnostics {
    param([string]$Root)
    $node = Find-NodeExe
    $port = Get-BridgePort -Root $Root
    $ping = Get-BridgePing -Port $port
    $browser = Find-AppBrowser
    [pscustomobject]@{
        root = $Root; url = "http://127.0.0.1:$port/"; port = $port
        node = $node; nodeMajor = $(if ($node) { Get-NodeMajor $node } else { 0 })
        dashboardBuilt = (Test-Path (Join-Path $Root 'src\dashboard\dist\index.html'))
        bridgeRunning = [bool]$ping; bridgePid = $(if ($ping) { $ping.pid } else { $null })
        portBlockedByOtherApp = (-not $ping -and (Test-PortInUse -Port $port))
        appBrowser = $(if ($browser) { $browser.Name } else { $null })
        appWindowOpen = (@(Get-AppWindowProcess -ProfileDir (Join-Path $Root 'data\state\app-profile')).Count -gt 0)
    }
}

function Start-GuardianDashboard {
    <#
    .SYNOPSIS Starts the bridge if needed, waits until reachable, then opens (or focuses) an app-style window.
    .OUTPUTS  { ok; url; bridge: already-running|started|failed; window: opened|focused|default-browser|none; message }
    #>
    param([string]$Root = (Get-GuardianRoot), [switch]$NoBrowser, [switch]$Gui, [int]$WaitSec = 20)
    $result = [ordered]@{ ok = $false; url = $null; bridge = 'failed'; window = 'none'; message = '' }
    $mutex = New-Object System.Threading.Mutex($false, 'Local\LaptopGuardianLauncher')
    $held = $false
    try {
        try { $held = $mutex.WaitOne(25000) } catch [System.Threading.AbandonedMutexException] { $held = $true }
        $port = Get-BridgePort -Root $Root
        $url = "http://127.0.0.1:$port/"; $result.url = $url
        $ping = Get-BridgePing -Port $port
        if ($ping -and (Get-BridgeOwnership -Ping $ping -Root $Root) -ne 'this-install') {
            $who = if ($ping.PSObject.Properties['root'] -and $ping.root) { " ($($ping.root))" } else { '' }
            $result.message = "Port $port is used by a Laptop Guardian bridge from another installation$who. It was left running. Change bridge.port in $(Join-Path $Root 'config\config.json'), or stop that installation."
            Show-LauncherError -Root $Root -Message $result.message -Gui:$Gui; return [pscustomobject]$result
        }
        if (-not $ping) {
            # A bridge of this install that is still starting (for example begun by the logon task) is waited for, never killed.
            $booting = @(Get-OwnedBridgeProcesses -Root $Root | Where-Object { $_.AgeSec -lt $script:BridgeBootGraceSec })
            if ($booting.Count) {
                $until = (Get-Date).AddSeconds($script:BridgeBootGraceSec)
                while (-not $ping -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 300; $ping = Get-BridgePing -Port $port -TimeoutSec 1 }
            }
        }
        if ($ping) {
            # A bridge started before its code was updated keeps serving the old code: restart it once.
            try {
                $newest = (Get-ChildItem (Join-Path $Root 'src\bridge') -Recurse -Filter *.js -ErrorAction Stop | Measure-Object LastWriteTime -Maximum).Maximum
                if ($newest -and ([datetime]::Parse($ping.startedAt) -lt $newest.AddSeconds(-1))) {
                    Write-LauncherLog -Root $Root -Message 'bridge code is newer than the running bridge; restarting it'
                    Stop-StaleBridge -Root $Root; $ping = $null
                }
            } catch { }
        }
        if ($ping) { $result.bridge = 'already-running' }
        else {
            $node = Find-NodeExe
            if (-not $node) { $result.message = 'Node.js was not found. Install the LTS version from https://nodejs.org, then open Laptop Guardian again.'; Show-LauncherError -Root $Root -Message $result.message -Gui:$Gui; return [pscustomobject]$result }
            if ((Get-NodeMajor $node) -lt 18) { $result.message = "Node.js 18 or newer is required (found $node). Update Node.js from https://nodejs.org."; Show-LauncherError -Root $Root -Message $result.message -Gui:$Gui; return [pscustomobject]$result }
            if (-not (Test-Path (Join-Path $Root 'src\dashboard\dist\index.html'))) { $result.message = "The dashboard has not been built. Run Install-LaptopGuardian.ps1 in $Root (or: cd src\dashboard; npm ci; npm run build)."; Show-LauncherError -Root $Root -Message $result.message -Gui:$Gui; return [pscustomobject]$result }
            if (-not (Test-Path (Join-Path $Root 'src\bridge\server.js'))) { $result.message = "src\bridge\server.js is missing from $Root. Re-install Laptop Guardian."; Show-LauncherError -Root $Root -Message $result.message -Gui:$Gui; return [pscustomobject]$result }
            if (Test-PortInUse -Port $port) {
                Stop-StaleBridge -Root $Root -MinAgeSec $script:BridgeBootGraceSec   # a hung bridge of this install is replaced; anything else keeps the port
                if (Test-PortInUse -Port $port) { $result.message = "Port $port is in use by another program. Close it, or change bridge.port in config\config.json."; Show-LauncherError -Root $Root -Message $result.message -Gui:$Gui; return [pscustomobject]$result }
            } else { Clear-StaleBridgeFile -Root $Root }
            $logDir = Join-Path $Root 'logs'; if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
            $errLog = Join-Path $logDir 'bridge-err.log'; $outLog = Join-Path $logDir 'bridge-out.log'
            Write-LauncherLog -Root $Root -Message "starting bridge: $node"
            # ShellExecute (no -Redirect* switches) so the bridge does not inherit the caller's pipes - otherwise whoever launched us
            # (a script piping our output, Task Scheduler, a test runner) would wait for the bridge to exit. cmd.exe does the log redirection.
            # GUARDIAN_ROOT is set explicitly so the bridge always serves THIS install, whatever environment the launcher inherited.
            $inner = "set `"GUARDIAN_ROOT=$Root`" && `"$node`" `"$(Join-Path $Root 'src\bridge\server.js')`" > `"$outLog`" 2> `"$errLog`""
            $proc = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList "/d /c `"$inner`"" -WorkingDirectory $Root -WindowStyle Hidden -PassThru
            $deadline = (Get-Date).AddSeconds($WaitSec)
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Milliseconds 250
                $ping = Get-BridgePing -Port $port -TimeoutSec 1
                if ($ping) { break }
                if ($proc.HasExited) { Start-Sleep -Milliseconds 300; $ping = Get-BridgePing -Port $port -TimeoutSec 1; break }  # lost a race to a concurrent launch
            }
            if (-not $ping) {
                $why = ''; try { if (Test-Path $errLog) { $why = (Get-Content $errLog -Tail 1 -ErrorAction SilentlyContinue) } } catch { }
                $result.message = "The dashboard bridge did not start within $WaitSec s.$(if ($why) { " Last error: $why." }) See $errLog."
                Show-LauncherError -Root $Root -Message $result.message -Gui:$Gui; return [pscustomobject]$result
            }
            $result.bridge = 'started'
        }
        $result.ok = $true; $result.message = "Dashboard ready at $url"
        if ($NoBrowser) { return [pscustomobject]$result }

        $profile = Join-Path $Root 'data\state\app-profile'
        $existing = @(Get-AppWindowProcess -ProfileDir $profile)
        if ($existing.Count -gt 0) {
            if (Set-ForegroundWindowOfProcess -ProcessIds @($existing | ForEach-Object { [int]$_.ProcessId })) { $result.window = 'focused'; Write-LauncherLog -Root $Root -Message 'focused existing window'; return [pscustomobject]$result }
        }
        $browser = Find-AppBrowser
        $opened = $false
        if ($browser) {
            try {
                New-Item -ItemType Directory -Path $profile -Force | Out-Null
                Start-Process -FilePath $browser.Path -ArgumentList @("--app=$url", "--user-data-dir=`"$profile`"", '--no-first-run', '--no-default-browser-check', '--window-size=1366,880') | Out-Null
                $result.window = 'opened'; $opened = $true; Write-LauncherLog -Root $Root -Message "opened app window with $($browser.Name)"
            } catch { Write-LauncherLog -Root $Root -Message "app-mode launch failed: $($_.Exception.Message)" }
        }
        if (-not $opened) {
            try { Start-Process $url; $result.window = 'default-browser'; $result.message = "Opened in your default browser: $url" } catch { $result.window = 'none'; $result.message = "Dashboard is running. Open $url in your browser." }
            Write-LauncherLog -Root $Root -Message "fallback: $($result.window)"
        }
        return [pscustomobject]$result
    } finally { if ($held) { try { $mutex.ReleaseMutex() } catch { } }; $mutex.Dispose() }
}

function New-GuardianShortcut {
    <# Creates a .lnk that launches the dashboard hidden-console. Returns the path. #>
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Root)
    $icon = Join-Path $Root 'src\assets\guardian.ico'
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($Path)
    $lnk.TargetPath = (Get-Command powershell.exe).Source
    $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $Root 'src\powershell\Start-Dashboard.ps1')`" -Gui"
    $lnk.WorkingDirectory = $Root
    $lnk.WindowStyle = 7
    $lnk.Description = 'Open the Laptop Guardian dashboard'
    if (Test-Path $icon) { $lnk.IconLocation = "$icon,0" }
    $lnk.Save()
    return $Path
}

function Test-GuardianShortcut {
    <# Reads the shortcut back and checks that it points at an existing launcher script. #>
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Root)
    if (-not (Test-Path $Path)) { return [pscustomobject]@{ ok = $false; reason = 'shortcut file missing' } }
    $l = (New-Object -ComObject WScript.Shell).CreateShortcut($Path)
    if (-not (Test-Path $l.TargetPath)) { return [pscustomobject]@{ ok = $false; reason = "target not found: $($l.TargetPath)" } }
    if ($l.Arguments -notmatch [regex]::Escape((Join-Path $Root 'src\powershell\Start-Dashboard.ps1'))) { return [pscustomobject]@{ ok = $false; reason = 'arguments do not point at Start-Dashboard.ps1' } }
    if (-not (Test-Path (Join-Path $Root 'src\powershell\Start-Dashboard.ps1'))) { return [pscustomobject]@{ ok = $false; reason = 'launcher script missing' } }
    return [pscustomobject]@{ ok = $true; reason = 'ok' }
}

function Get-GuardianShortcutPaths {
    [pscustomobject]@{
        StartMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Laptop Guardian.lnk'
        Desktop   = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Laptop Guardian.lnk'
    }
}

Export-ModuleMember -Function *
