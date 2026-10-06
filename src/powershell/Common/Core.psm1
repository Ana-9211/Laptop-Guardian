#requires -Version 5.1
# Core: paths, config, JSON IO, event log, safe command execution. No Windows-specific analysis here.
Set-StrictMode -Version 2.0

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:RunType = $null
$script:RunEvents = New-Object System.Collections.ArrayList
$script:RunErrors = New-Object System.Collections.ArrayList
$script:Timings = [ordered]@{}
$script:InstallInfo = $null
$script:InstallInfoLoaded = $false

function Get-SystemPowerShellPath {
    # Windows PowerShell by absolute path, never whatever "powershell.exe" a PATH entry happens to name (this is what elevated launches use).
    Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
}

function Get-GuardianCodeRoot {
    # Where the program files are (module lives in <root>/src/powershell/Common). Always derived from this file's own location, never from the environment.
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
}

function Get-GuardianInstall {
    <# install.json next to the program files marks an INSTALLED copy: { dataRoot, elevatedDir, ... } written by the installer.
       Returns $null for a development checkout. A damaged file throws: guessing which folders to trust would be worse than stopping. #>
    if ($script:InstallInfoLoaded) { return $script:InstallInfo }
    $f = Join-Path (Get-GuardianCodeRoot) 'install.json'
    $info = $null
    if (Test-Path -LiteralPath $f) {
        try { $info = Get-Content -LiteralPath $f -Raw | ConvertFrom-Json } catch { throw "install.json is damaged ($f). Run Install-LaptopGuardian.ps1 again from an administrator PowerShell." }
        foreach ($k in 'dataRoot', 'elevatedDir') {
            if (-not ($info.PSObject.Properties[$k] -and [IO.Path]::IsPathRooted([string]$info.$k))) { throw "install.json has no valid '$k' ($f). Run Install-LaptopGuardian.ps1 again from an administrator PowerShell." }
        }
    }
    $script:InstallInfo = $info; $script:InstallInfoLoaded = $true
    return $info
}

function Get-GuardianDataRoot {
    # config, data, reports and logs. An installed copy gets this from install.json, so the environment cannot redirect it.
    $i = Get-GuardianInstall
    if ($i) { return [string]$i.dataRoot }
    if ($env:GUARDIAN_ROOT -and (Test-Path -LiteralPath $env:GUARDIAN_ROOT)) { return (Resolve-Path -LiteralPath $env:GUARDIAN_ROOT).Path }
    return (Get-GuardianCodeRoot)
}

# Historical name: the folder that holds config, data, reports and logs.
function Get-GuardianRoot { Get-GuardianDataRoot }

# Guardian's own folders: the data folder and the program folder (the same folder in a development checkout). Both are protected from stop/recycle/block actions.
function Get-GuardianRoots { @((Get-GuardianDataRoot), (Get-GuardianCodeRoot)) | Where-Object { $_ } | Select-Object -Unique }

function Get-DefaultBridgePort {
    # The installed copy and a development checkout must not fight over one port.
    if (Get-GuardianInstall) { return 7878 } else { return 7879 }
}

function Get-GuardianPath {
    param([Parameter(Mandatory)][string]$Name)
    $r = Get-GuardianRoot
    $inst = Get-GuardianInstall
    switch ($Name) {
        'Config'          { Join-Path $r 'config\config.json' }
        'ProcessPolicy'   { Join-Path $r 'config\process-policy.json' }
        'Actions'         { Join-Path $r 'data\actions\actions.jsonl' }
        'Metrics'         { Join-Path $r 'data\metrics\metrics.jsonl' }
        'Recommendations' { Join-Path $r 'data\recommendations\recommendations.json' }
        'RunState'        { Join-Path $r 'data\state\run-state.json' }
        'QueuedRun'       { Join-Path $r 'data\state\queued-run.json' }
        'AiUsage'         { Join-Path $r 'data\state\ai-usage.jsonl' }
        'AiCache'         { Join-Path $r 'data\state\ai-cache.json' }
        'FileCache'       { Join-Path $r 'data\state\file-hash-cache.json' }
        'LatestDaily'     { Join-Path $r 'data\latest\daily.json' }
        'LatestWeekly'    { Join-Path $r 'data\latest\weekly.json' }
        'LatestProcesses' { Join-Path $r 'data\latest\processes.json' }
        'LatestFiles'     { Join-Path $r 'data\latest\files.json' }
        'GeminiKey'       { Join-Path $r 'data\secrets\gemini.dpapi' }
        'Logs'            { Join-Path $r 'logs' }
        'Reports'         { Join-Path $r 'reports' }
        'Root'            { $r }
        # What an elevated run writes goes to an administrators-only folder of an installed copy (ACL set by the installer);
        # a development checkout keeps everything under the data folder, exactly as before.
        'ActionResults'   { if ($inst) { Join-Path ([string]$inst.elevatedDir) 'results' } else { Join-Path $r 'data\state\action-results' } }
        'ElevatedAudit'   { if ($inst) { Join-Path ([string]$inst.elevatedDir) 'audit\actions.jsonl' } else { Join-Path $r 'data\actions\actions.jsonl' } }
        'ElevatedBackups' { if ($inst) { Join-Path ([string]$inst.elevatedDir) 'backups' } else { Join-Path $r 'data\network' } }
        default           { throw "Unknown path name '$Name'" }
    }
}

function Get-PropNames { param($Object) if ($null -eq $Object) { return @() }; return @($Object.PSObject.Properties | ForEach-Object { $_.Name }) }

function Get-IsoNow { (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz") }
function ConvertTo-IsoTime { param($Date) if ($null -eq $Date) { return $null }; try { ([datetime]$Date).ToString("yyyy-MM-ddTHH:mm:sszzz") } catch { $null } }
function New-ShortId { [guid]::NewGuid().ToString('N').Substring(0, 12) }

function Initialize-GuardianDirectories {
    $r = Get-GuardianRoot
    foreach ($d in 'config', 'data\history', 'data\recommendations', 'data\actions', 'data\processes', 'data\metrics', 'data\state', 'data\latest', 'data\secrets', 'reports\daily', 'reports\weekly', 'logs') {
        $p = Join-Path $r $d
        if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
    }
}

# ---------- JSON IO ----------
function Read-JsonFile {
    param([Parameter(Mandatory)][string]$Path, $Default = $null)
    if (-not (Test-Path -LiteralPath $Path)) { return $Default }
    try {
        $raw = [System.IO.File]::ReadAllText($Path, $script:Utf8NoBom)
        if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
        return ($raw | ConvertFrom-Json)
    } catch {
        return $Default
    }
}

function Assert-NoLinkWhenElevated {
    # An elevated write that follows a junction or symlink planted in a user-writable folder could land anywhere. Refuse instead.
    param([string]$Dir)
    if (-not $Dir -or -not (Test-IsAdmin)) { return }
    $root = Get-GuardianRoot
    $p = $Dir.TrimEnd([char]92)
    while ($p -and $p.Length -gt 3 -and $p.StartsWith($root.TrimEnd([char]92), [System.StringComparison]::OrdinalIgnoreCase)) {
        $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
        if ($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Refusing to write through a junction or symbolic link: $p" }
        $p = Split-Path -Parent $p
    }
}

function Invoke-WithFileLock {
    <# Holds <Path>.lock (created exclusively; the dashboard bridge uses the same protocol) around a read-modify-write of a shared file. Runs anyway if the lock cannot be had in time. #>
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][scriptblock]$ScriptBlock, [int]$TimeoutMs = 6000)
    $lock = "$Path.lock"; $dir = Split-Path -Parent $lock
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs); $fs = $null
    while (-not $fs) {
        try { $fs = [System.IO.File]::Open($lock, 'CreateNew', 'Write', 'None') }
        catch {
            try { if (((Get-Date) - (Get-Item -LiteralPath $lock -ErrorAction Stop).LastWriteTime).TotalSeconds -gt 30) { Remove-Item -LiteralPath $lock -Force -ErrorAction Stop } } catch { }
            if ((Get-Date) -gt $deadline) { break }
            Start-Sleep -Milliseconds (15 + (Get-Random -Maximum 30))
        }
    }
    try { & $ScriptBlock } finally { if ($fs) { $fs.Dispose(); Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue } }
}

function Write-JsonFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Object, [int]$Depth = 14)
    $dir = Split-Path -Parent $Path
    Assert-NoLinkWhenElevated -Dir $dir
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $json = ConvertTo-Json -InputObject $Object -Depth $Depth
    $tmp = "$Path.$([guid]::NewGuid().ToString('N').Substring(0,8)).tmp"
    [System.IO.File]::WriteAllText($tmp, $json, $script:Utf8NoBom)
    # Swap the new file in, retrying briefly if another process (the bridge, antivirus) has the old one open.
    for ($try = 0; $try -lt 8; $try++) {
        try {
            if (Test-Path -LiteralPath $Path) { [System.IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $Path) }
            return
        } catch {
            if ($try -ge 7) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; throw }
            Start-Sleep -Milliseconds (20 * ($try + 1))
        }
    }
}

function Add-JsonLine {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Object)
    $dir = Split-Path -Parent $Path
    Assert-NoLinkWhenElevated -Dir $dir
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $line = (ConvertTo-Json -InputObject $Object -Depth 8 -Compress) + "`n"
    # The append holds the same <file>.lock the bridge's compaction uses, so a compaction can never swap the file between our check and our write.
    Invoke-WithFileLock -Path $Path -TimeoutMs 3000 -ScriptBlock {
        # If a previous write was torn (no trailing newline), start on a fresh line so only the torn record is lost
        try {
            if (Test-Path -LiteralPath $Path) {
                $fs = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
                try { if ($fs.Length -gt 0) { $fs.Seek(-1, 'End') | Out-Null; if ($fs.ReadByte() -ne 10) { $line = "`n" + $line } } } finally { $fs.Dispose() }
            }
        } catch { }
        [System.IO.File]::AppendAllText($Path, $line, $script:Utf8NoBom)
    }
}

function Read-JsonLines {
    param([Parameter(Mandatory)][string]$Path, [int]$Last = 0)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    $lines = [System.IO.File]::ReadAllLines($Path, $script:Utf8NoBom)
    if ($Last -gt 0 -and $lines.Count -gt $Last) { $lines = $lines[($lines.Count - $Last)..($lines.Count - 1)] }
    $out = New-Object System.Collections.ArrayList
    foreach ($l in $lines) {
        if ([string]::IsNullOrWhiteSpace($l)) { continue }
        try { [void]$out.Add(($l | ConvertFrom-Json)) } catch { }   # skip torn/corrupt line
    }
    return @($out)
}

# ---------- Config ----------
function Get-DefaultConfig {
    [ordered]@{
        schemaVersion = 1
        bridge        = [ordered]@{ host = '127.0.0.1'; port = (Get-DefaultBridgePort) }
        schedule      = [ordered]@{
            daily  = [ordered]@{ enabled = $true; time = '19:00' }
            weekly = [ordered]@{ enabled = $true; day = 'Saturday'; time = '02:00'; shutdownTime = '05:00'; shutdownEnabled = $true }
        }
        safety        = [ordered]@{ safeMode = $true; autoKillBlacklisted = $true; automationPaused = $false; weeklyShutdown = $true }
        ai            = [ordered]@{ enabled = $false; model = 'gemini-2.5-flash'; maxRequestsPerRun = 15; maxProcessesPerRun = 10; dailyTokenBudget = 200000 }
        cleanup       = [ordered]@{ tempFiles = $true; crashDumps = $true; caches = $true; recycleBin = 'never'; tempMinAgeDays = 2 }
        storage       = [ordered]@{ drives = @('C:'); excludedDirs = @(); protectedDirs = @(); minLargeFileMB = 500; oldFileDays = 365; duplicateScan = $true; duplicateMinMB = 50 }
        thresholds    = [ordered]@{ cpuPct = 50; memoryMB = 1500; diskFreeWarnPct = 15; diskFreeCritPct = 8 }
        retention     = [ordered]@{ reportsDays = 0 }
        # Network Guard. Deep capture and DNS filtering are off by default and are switched on only through their own confirmed actions.
        network       = [ordered]@{
            snapshot      = [ordered]@{ auto = $true; everyMinutes = 60; retentionDays = 30; maxMB = 20 }
            deep          = [ordered]@{ enabled = $false; retentionDays = 7; maxMB = 100; sampleSec = 5 }
            dnsFiltering  = [ordered]@{ enabled = $false }
            thresholds    = [ordered]@{ burstConnections = 100; burstDestinations = 40; unknownDestinations = 8; persistentDestinations = 5; newConnectionsPerMinute = 50 }
        }
    }
}

function Merge-Defaults {
    param($Defaults, $Actual)
    # Returns ordered hashtable: defaults overlaid with actual (recursive for objects).
    $out = [ordered]@{}
    foreach ($k in $Defaults.Keys) {
        $d = $Defaults[$k]
        $has = $null -ne $Actual -and ((Get-PropNames $Actual) -contains $k)
        if ($has) {
            $a = $Actual.$k
            if ($d -is [System.Collections.IDictionary] -and $null -ne $a -and $a -isnot [string]) { $out[$k] = Merge-Defaults $d $a }
            elseif ($d -is [array]) { $out[$k] = @($a) }
            else { $out[$k] = $a }
        } else { $out[$k] = $d }
    }
    if ($null -ne $Actual) {
        foreach ($p in $Actual.PSObject.Properties) { if (-not $out.Contains($p.Name)) { $out[$p.Name] = $p.Value } }
    }
    return $out
}

function Get-GuardianConfig {
    $raw = Read-JsonFile -Path (Get-GuardianPath 'Config') -Default $null
    $merged = Merge-Defaults (Get-DefaultConfig) $raw
    # Fail closed: a null/non-boolean value in the safety block must never disable a protection
    if ($merged.safety['safeMode'] -isnot [bool]) { $merged.safety['safeMode'] = $true }
    foreach ($sk in 'autoKillBlacklisted', 'automationPaused', 'weeklyShutdown') { if ($merged.safety[$sk] -isnot [bool]) { $merged.safety[$sk] = $(if ($sk -eq 'automationPaused') { $true } else { $false }) } }
    # Normalise through JSON so callers get PSCustomObject with dot access
    return ($merged | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
}

function Save-GuardianConfig {
    param([Parameter(Mandatory)]$Config)
    Write-JsonFile -Path (Get-GuardianPath 'Config') -Object $Config
}

# ---------- Run context + events ----------
function Start-RunContext {
    param([string]$RunType)
    $script:RunType = $RunType
    $script:RunEvents = New-Object System.Collections.ArrayList
    $script:RunErrors = New-Object System.Collections.ArrayList
    $script:Timings = [ordered]@{}
}
function Get-RunEvents { , @($script:RunEvents) }
function Get-RunErrors { , @($script:RunErrors) }

function Write-GuardianEvent {
    param(
        [Parameter(Mandatory)][ValidateSet('scan', 'process', 'ai', 'file', 'cleanup', 'defender', 'windows', 'policy', 'shutdown', 'config', 'system', 'remediation', 'network')][string]$Category,
        [Parameter(Mandatory)][string]$Action,
        [ValidateSet('info', 'warning', 'error')][string]$Severity = 'info',
        [string]$Target,
        [ValidateSet('success', 'failure', 'skipped', 'timeout', 'started')][string]$Result = 'success',
        [ValidateSet('agent', 'user', 'policy', 'ai-validator')][string]$Actor = 'agent',
        [string]$Reason,
        [string]$Related,
        [string]$ErrorDetails,
        $Data = $null
    )
    $evt = [ordered]@{
        id = New-ShortId; ts = Get-IsoNow; category = $Category; severity = $Severity; action = $Action
        target = $(if ($Target) { $Target } else { $null }); result = $Result; actor = $Actor
        reason = $(if ($Reason) { $Reason } else { $null }); relatedRecommendation = $(if ($Related) { $Related } else { $null })
        error = $(if ($ErrorDetails) { $ErrorDetails } else { $null }); runType = $script:RunType
    }
    if ($null -ne $Data) { $evt['data'] = $Data }   # structured detail (verification, undo recipe); never secrets
    [void]$script:RunEvents.Add($evt)
    # An elevated run of an installed copy writes to the administrators-only folder, never into a folder an ordinary program can swap for a link.
    $auditPath = if ((Get-GuardianInstall) -and (Test-IsAdmin)) { Get-GuardianPath 'ElevatedAudit' } else { Get-GuardianPath 'Actions' }
    try { Add-JsonLine -Path $auditPath -Object $evt } catch { Write-Warning "Laptop Guardian could not write the audit trail: $($_.Exception.Message)" }
    try {
        $logFile = Join-Path (Get-GuardianPath 'Logs') ("guardian-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
        $line = "{0} [{1}] {2}/{3} {4} target={5} result={6}{7}" -f $evt.ts, $Severity.ToUpper(), $Category, $Action, $Actor, $Target, $Result, $(if ($ErrorDetails) { " error=$ErrorDetails" } else { '' })
        if (-not (Test-Path -LiteralPath (Split-Path $logFile))) { New-Item -ItemType Directory -Path (Split-Path $logFile) -Force | Out-Null }
        [System.IO.File]::AppendAllText($logFile, $line + "`r`n", $script:Utf8NoBom)
    } catch { }
    return [pscustomobject]$evt
}

function Add-RunError {
    param([string]$Source, [string]$Message)
    [void]$script:RunErrors.Add([ordered]@{ ts = Get-IsoNow; source = $Source; message = $Message })
    [void](Write-GuardianEvent -Category system -Action "error:$Source" -Severity error -Result failure -ErrorDetails $Message)
}

# Run a collector; on failure record error and return $Default so the run continues.
function Invoke-Safely {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$ScriptBlock, $Default = $null)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try { return (& $ScriptBlock) }
    catch { Add-RunError -Source $Name -Message $_.Exception.Message; return $Default }
    finally { $script:Timings[$Name] = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
}
function Get-RunTimings { $script:Timings }

# ---------- Run state ----------
function Get-RunState { Read-JsonFile -Path (Get-GuardianPath 'RunState') -Default ([pscustomobject]@{ lastDaily = $null; lastWeekly = $null; running = $null }) }
function Set-RunState {
    param([string]$Key, $Value)
    $path = Get-GuardianPath 'RunState'
    Invoke-WithFileLock -Path $path -ScriptBlock {
        $s = Get-RunState
        $h = [ordered]@{ lastDaily = $s.lastDaily; lastWeekly = $s.lastWeekly; running = $s.running }
        $h[$Key] = $Value
        Write-JsonFile -Path $path -Object $h
    }
}

# ---------- Safe external command execution ----------
# Executes an executable with an argument array (never via a shell string), enforces timeout, kills tree on timeout.
function Invoke-GuardianCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSec = 120
    )
    $res = [ordered]@{ ExitCode = $null; Output = ''; TimedOut = $false; Error = $null; DurationSec = 0 }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $so = [System.IO.Path]::GetTempFileName(); $se = [System.IO.Path]::GetTempFileName()
    try {
        $argLine = ($Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
        $sp = @{ FilePath = $FilePath; NoNewWindow = $true; PassThru = $true; RedirectStandardOutput = $so; RedirectStandardError = $se }
        if ($argLine) { $sp.ArgumentList = $argLine }
        $p = Start-Process @sp
        $null = $p.Handle   # keep handle so ExitCode is readable after exit
        if (-not $p.WaitForExit($TimeoutSec * 1000)) {
            $res.TimedOut = $true
            try { & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null } catch { }
        } else { $p.WaitForExit(); $res.ExitCode = $p.ExitCode }
        $res.Output = Read-ConsoleText $so
        $err = Read-ConsoleText $se
        if ($err) { $res.Output = ($res.Output + "`n" + $err).Trim() }
    } catch {
        $res.Error = $_.Exception.Message
    } finally {
        Remove-Item -LiteralPath $so, $se -Force -ErrorAction SilentlyContinue
        $sw.Stop(); $res.DurationSec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    }
    return [pscustomobject]$res
}

function Read-ConsoleText {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) { return '' }
    # sfc.exe emits UTF-16LE; detect NUL bytes
    $nul = 0; for ($i = 0; $i -lt [math]::Min($bytes.Length, 200); $i++) { if ($bytes[$i] -eq 0) { $nul++ } }
    $txt = if ($nul -gt 5) { [System.Text.Encoding]::Unicode.GetString($bytes) } else { [System.Text.Encoding]::UTF8.GetString($bytes) }
    return ($txt -replace "`0", '').Trim()
}

$script:Locks = @{}
function Enter-GuardianLock {
    # Single-instance guard per run type. Returns $true if acquired.
    param([Parameter(Mandatory)][string]$Name)
    try {
        # The user's SID is part of the name so another account cannot pre-create the mutex under a guessable name and block the run.
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $m = New-Object System.Threading.Mutex($false, "Global\LaptopGuardian-$sid-$Name")
        if ($m.WaitOne(0)) { $script:Locks[$Name] = $m; return $true }
        $m.Dispose(); return $false
    } catch [System.Threading.AbandonedMutexException] { $script:Locks[$Name] = $m; return $true } catch { return $false }
}
function Exit-GuardianLock {
    param([string]$Name)
    if ($script:Locks.ContainsKey($Name)) { try { $script:Locks[$Name].ReleaseMutex(); $script:Locks[$Name].Dispose() } catch { }; $script:Locks.Remove($Name) }
}

function Use-QueuedFullRun {
    <# True when the dashboard queued a full run for this kind ("scan.queue-next-run"). The marker is removed, so it applies to exactly one run.
       It can only turn the fast mode off and the Defender scan on; it never adds work from outside Guardian's fixed steps. #>
    param([Parameter(Mandatory)][ValidateSet('daily', 'weekly')][string]$Kind)
    $f = Get-GuardianPath 'QueuedRun'
    if (-not (Test-Path -LiteralPath $f)) { return $false }
    $q = Read-JsonFile -Path $f -Default $null
    if (-not $q -or [string]$q.kind -ne $Kind) { return $false }
    Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
    [void](Write-GuardianEvent -Category scan -Action "$Kind:queued-full-run" -Result success -Reason "A full run was queued from the dashboard ($($q.queuedAt)); fast mode is off and the Defender scan is included.")
    return $true
}

function Test-IsAdmin {
    try { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { $false }
}

function Get-IsoWeekId {
    param([datetime]$Date = (Get-Date))
    # ISO 8601: the week belongs to the year that holds its Thursday.
    $thursday = $Date.Date.AddDays(3 - (([int]$Date.DayOfWeek + 6) % 7))
    $w = [int][math]::Floor(($thursday.DayOfYear - 1) / 7) + 1
    return ('{0}-W{1:00}' -f $thursday.Year, $w)
}

Export-ModuleMember -Function *
