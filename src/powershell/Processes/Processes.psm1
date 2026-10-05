#requires -Version 5.1
# Processes: snapshot, signature/publisher, classification, persistence mapping, flagging.
Set-StrictMode -Version 2.0

$script:SigCache = @{}
$script:SigLoaded = $false
$script:SigDirty = $false
$script:KnownPublishers = @('Microsoft', 'Google', 'Mozilla', 'Intel', 'NVIDIA', 'Advanced Micro Devices', 'AMD', 'Realtek', 'Adobe', 'Dell', 'HP Inc', 'Hewlett', 'Lenovo', 'ASUS', 'Acer',
    'Zoom', 'Slack', 'Discord', 'Spotify', 'JetBrains', 'Docker', 'Oracle', 'Apple', 'Brave', 'Opera', 'Valve', 'Cisco', 'VMware', 'GitHub', 'Dropbox', 'Logitech', 'Qualcomm', 'Python Software', 'OpenJS', 'Node.js', 'Notion', 'Figma', 'Ollama', 'Anthropic', 'Epic Games', 'Mozilla Corporation', 'Autodesk', 'Canonical', 'Samsung', 'Synaptics', 'Waves', 'Bluetooth', 'Cloudflare', 'Tailscale', 'Proton', 'Mullvad', 'Malwarebytes')
$script:MultiProcessApps = @('chrome', 'msedge', 'firefox', 'brave', 'opera', 'code', 'slack', 'discord', 'teams', 'ms-teams', 'svchost', 'conhost', 'dllhost', 'runtimebroker', 'msedgewebview2', 'node', 'electron', 'cursor', 'windsurf', 'antigravity', 'python', 'java', 'claude', 'spotify', 'notion', 'figma', 'zoom', 'docker desktop', 'com.docker.backend', 'powershell', 'cmd', 'wmiprvse', 'backgroundtaskhost', 'searchprotocolhost', 'searchfilterhost', 'adb')

$script:Descriptions = @{
    'chrome' = 'Google Chrome web browser (one process per tab/extension/utility).'
    'msedge' = 'Microsoft Edge web browser (multi-process).'
    'firefox' = 'Mozilla Firefox web browser.'
    'onedrive' = 'Microsoft OneDrive file sync client.'
    'teams' = 'Microsoft Teams collaboration client.'
    'ms-teams' = 'Microsoft Teams collaboration client.'
    'spotify' = 'Spotify music player.'
    'discord' = 'Discord chat client (Electron).'
    'code' = 'Visual Studio Code editor (Electron, multi-process).'
    'node' = 'Node.js JavaScript runtime; the real purpose depends on the script on its command line.'
    'python' = 'Python interpreter; purpose depends on the script on its command line.'
    'java' = 'Java runtime; purpose depends on the application it hosts.'
    'ollama' = 'Ollama local LLM runtime/server.'
    'docker desktop' = 'Docker Desktop container manager.'
    'searchindexer' = 'Windows Search indexer (builds the file search index).'
    'msmpeng' = 'Microsoft Defender Antivirus engine.'
    'steam' = 'Steam game launcher.'
    'dropbox' = 'Dropbox file sync client.'
    'slack' = 'Slack chat client (Electron).'
    'zoom' = 'Zoom meetings client.'
    'vmmem' = 'Virtual machine memory for WSL2 / Hyper-V; memory is held by the VM.'
    'vmmemwsl' = 'Virtual machine memory for WSL2; memory is held by the Linux VM.'
    'claude' = 'Claude desktop / Claude Code related process.'
}

function Get-FileSignatureInfo {
    param([string]$Path)
    $r = [pscustomobject]@{ signature = 'Unknown'; signed = $false; publisher = $null; description = $null }
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $r }
    Initialize-SigCache
    $key = $Path.ToLowerInvariant()
    $stamp = $null
    try { $fi = Get-Item -LiteralPath $Path -ErrorAction Stop; $stamp = "$($fi.Length)|$($fi.LastWriteTimeUtc.Ticks)" } catch { }
    if ($script:SigCache.ContainsKey($key) -and $script:SigCache[$key].stamp -eq $stamp) { return $script:SigCache[$key].info }
    try {
        $vi = (Get-Item -LiteralPath $Path -ErrorAction Stop).VersionInfo
        $r.description = $vi.FileDescription
        if ($vi.CompanyName) { $r.publisher = $vi.CompanyName }
    } catch { }
    try {
        $sig = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
        switch ([string]$sig.Status) {
            'Valid' { $r.signature = 'Valid'; $r.signed = $true }
            'NotSigned' { $r.signature = 'NotSigned' }
            'UnknownError' { $r.signature = 'Unknown' }
            default { $r.signature = 'Invalid' }
        }
        if ($sig.SignerCertificate -and $sig.SignerCertificate.Subject -match 'CN=("([^"]+)"|([^,]+))') {
            $cn = if ($Matches[2]) { $Matches[2] } else { $Matches[3] }
            $r.publisher = $cn
        }
    } catch { }
    $script:SigCache[$key] = @{ stamp = $stamp; info = $r }
    $script:SigDirty = $true
    return $r
}

function Initialize-SigCache {
    if ($script:SigLoaded) { return }
    $script:SigLoaded = $true
    $p = Join-Path (Get-GuardianPath 'Root') 'data\state\sig-cache.json'
    $raw = Read-JsonFile -Path $p -Default $null
    if ($raw) { foreach ($e in $raw.PSObject.Properties) { try { $script:SigCache[$e.Name] = @{ stamp = $e.Value.stamp; info = $e.Value.info } } catch { } } }
}

function Save-SigCache {
    if (-not $script:SigDirty) { return }
    $p = Join-Path (Get-GuardianPath 'Root') 'data\state\sig-cache.json'
    $o = [ordered]@{}; foreach ($k in $script:SigCache.Keys) { $o[$k] = $script:SigCache[$k] }
    if ($o.Count -gt 6000) { return }
    try { Write-JsonFile -Path $p -Object $o -Depth 4; $script:SigDirty = $false } catch { }
}

function Get-PathClass {
    param([string]$Path)
    if (-not $Path) { return 'unknown' }
    $p = $Path.ToLowerInvariant()
    $win = if ($env:SystemRoot) { $env:SystemRoot.ToLowerInvariant() } else { 'c:\windows' }
    # User-writable locations inside "system" trees must be checked first (Windows\Temp, Tasks, spool, ProgramData)
    foreach ($w in @("$win\temp", "$win\tasks", "$win\system32\tasks", "$win\system32\spool", "$win\debug", "$win\tracing", "$win\registration\crmlog")) { if ($p.StartsWith($w + '\')) { return 'temp' } }
    if ($p.StartsWith($win + '\')) { return 'system' }
    if ($env:ProgramData -and $p.StartsWith($env:ProgramData.ToLowerInvariant() + '\')) { return 'other' }
    foreach ($pf in @(${env:ProgramFiles}, ${env:ProgramFiles(x86)})) { if ($pf -and $p.StartsWith($pf.ToLowerInvariant() + '\')) { return 'program-files' } }
    $tmp = @($env:TEMP, $env:TMP, (Join-Path $env:SystemRoot 'Temp')) | Where-Object { $_ }
    foreach ($t in $tmp) { if ($p.StartsWith($t.ToLowerInvariant() + '\')) { return 'temp' } }
    if ($env:USERPROFILE) {
        $up = $env:USERPROFILE.ToLowerInvariant()
        if ($p.StartsWith($up + '\downloads\')) { return 'downloads' }
        if ($p.StartsWith($up + '\appdata\local\temp\')) { return 'temp' }
        if ($p.StartsWith($up + '\appdata\')) { return 'user-appdata' }
    }
    return 'other'
}

function Get-ProcessClassification {
    param([string]$PathClass, [string]$Publisher, [bool]$Signed, [string]$Name)
    if ($PathClass -eq 'system') { return 'windows' }
    # Path unreadable without elevation (service/system processes): fall back to well-known Windows process names
    if ((-not $PathClass -or $PathClass -eq 'unknown') -and $Name -and ((Get-ProtectedProcessNames) -contains $Name.ToLowerInvariant())) { return 'windows' }
    if ($Publisher) {
        foreach ($k in $script:KnownPublishers) { if ($Publisher -like "*$k*" -and $Signed) { return 'known-app' } }
        if ($Signed) { return 'third-party' }
        return 'third-party'
    }
    return 'unknown'
}

function Get-ProcessSnapshot {
    <# Returns list of Process objects (see DATA-CONTRACT). Samples CPU over $SampleMs. Tolerates processes vanishing mid-inspection. #>
    param([int]$SampleMs = 1500, $Persistence = $null)
    $logical = [Environment]::ProcessorCount
    $first = @{}
    try { foreach ($p in Get-Process -ErrorAction SilentlyContinue) { try { $first[$p.Id] = [double]$p.CPU } catch { } } } catch { }
    $cim = @{}
    try { foreach ($c in Get-CimInstance Win32_Process -ErrorAction Stop) { $cim[[int]$c.ProcessId] = $c } } catch { }
    Start-Sleep -Milliseconds $SampleMs
    $now = @{}
    $procs = @()
    try { $procs = @(Get-Process -ErrorAction SilentlyContinue) } catch { }
    foreach ($p in $procs) { try { $now[$p.Id] = [double]$p.CPU } catch { } }

    $names = @{}
    foreach ($p in $procs) { $names[$p.Id] = $p.ProcessName }
    $svcByPid = @{}; $svcByPath = @{}; $taskByPath = @{}; $startByPath = @{}
    if ($Persistence) {
        foreach ($s in @($Persistence.Services)) {
            if ($s.processId -gt 0) { if (-not $svcByPid.ContainsKey($s.processId)) { $svcByPid[$s.processId] = New-Object System.Collections.ArrayList }; [void]$svcByPid[$s.processId].Add($s) }
            if ($s.path) { $k = $s.path.ToLowerInvariant(); if (-not $svcByPath.ContainsKey($k)) { $svcByPath[$k] = New-Object System.Collections.ArrayList }; [void]$svcByPath[$k].Add($s) }
        }
        foreach ($t in @($Persistence.Tasks)) {
            $ex = Resolve-CommandExecutable $t.execute
            if ($ex) { $k = $ex.ToLowerInvariant(); if (-not $taskByPath.ContainsKey($k)) { $taskByPath[$k] = New-Object System.Collections.ArrayList }; [void]$taskByPath[$k].Add($t) }
        }
        foreach ($e in @($Persistence.Startup)) {
            $ex = Resolve-CommandExecutable $e.command
            if ($ex) { $k = [Environment]::ExpandEnvironmentVariables($ex).ToLowerInvariant(); if (-not $startByPath.ContainsKey($k)) { $startByPath[$k] = New-Object System.Collections.ArrayList }; [void]$startByPath[$k].Add($e) }
        }
    }

    $out = New-Object System.Collections.ArrayList
    foreach ($p in $procs) {
        try {
            $procId = [int]$p.Id
            $c = if ($cim.ContainsKey($procId)) { $cim[$procId] } else { $null }
            $path = $null; $cmd = $null; $ppid = 0
            if ($c) { $path = $c.ExecutablePath; $cmd = $c.CommandLine; $ppid = [int]$c.ParentProcessId }
            if (-not $path) { try { $path = $p.Path } catch { } }
            $cpuPct = 0.0
            if ($first.ContainsKey($procId) -and $now.ContainsKey($procId)) {
                $cpuPct = [math]::Round(([math]::Max(0, $now[$procId] - $first[$procId]) / ($SampleMs / 1000.0)) / $logical * 100, 1)
            }
            $cpuSec = 0.0; try { $cpuSec = [math]::Round([double]$p.CPU, 1) } catch { }
            $start = $null; try { $start = ConvertTo-IsoTime $p.StartTime } catch { }
            $pathClass = Get-PathClass $path
            # Skip expensive signature checks for Windows directory binaries (classified by location, publisher from file metadata)
            if ($pathClass -eq 'system') {
                $vi = $null; try { $vi = (Get-Item -LiteralPath $path -ErrorAction Stop).VersionInfo } catch { }
                $sig = [pscustomobject]@{ signature = 'Unknown'; signed = $false; publisher = $(if ($vi) { $vi.CompanyName } else { $null }); description = $(if ($vi) { $vi.FileDescription } else { $null }) }
            } else { $sig = Get-FileSignatureInfo $path }
            $svcs = @(); $tasks = @(); $starts = @()
            $pk = if ($path) { $path.ToLowerInvariant() } else { $null }
            if ($svcByPid.ContainsKey($procId)) { $svcs += @($svcByPid[$procId] | ForEach-Object { $_.name }) }
            if ($pk -and $svcByPath.ContainsKey($pk)) { $svcs += @($svcByPath[$pk] | ForEach-Object { $_.name }) }
            if ($pk -and $taskByPath.ContainsKey($pk)) { $tasks += @($taskByPath[$pk] | ForEach-Object { $_.path + $_.name }) }
            if ($pk -and $startByPath.ContainsKey($pk)) { $starts += @($startByPath[$pk] | ForEach-Object { [pscustomobject]@{ kind = $_.kind; name = $_.name; location = $_.location; command = $_.command } }) }
            $svcs = @($svcs | Select-Object -Unique); $tasks = @($tasks | Select-Object -Unique)
            $name = $p.ProcessName
            [void]$out.Add([pscustomobject][ordered]@{
                    name = $name; pid = $procId; path = $path; commandLine = $cmd; parentPid = $ppid
                    parentName = $(if ($names.ContainsKey($ppid)) { $names[$ppid] } else { $null })
                    cpuPct = $cpuPct; cpuSeconds = $cpuSec; memoryMB = [math]::Round($p.WorkingSet64 / 1MB, 1); startTime = $start
                    publisher = $sig.publisher; signature = $sig.signature; signed = [bool]$sig.signed; description = $sig.description
                    services = $svcs; startupEntries = @($starts); scheduledTasks = $tasks
                    persistent = [bool]($svcs.Count -or $tasks.Count -or $starts.Count)
                    user = $null; pathClass = $pathClass
                    classification = (Get-ProcessClassification -PathClass $pathClass -Publisher $sig.publisher -Signed ([bool]$sig.signed) -Name $name)
                    instances = 1; flags = @(); policy = 'none'; recommendationId = $null
                })
        } catch { continue }   # process vanished or access denied: skip, never abort the scan
    }
    Save-SigCache
    # instance counts by name+path
    $grp = $out | Group-Object { ($_.name + '|' + $_.path).ToLowerInvariant() }
    foreach ($g in $grp) { foreach ($i in $g.Group) { $i.instances = $g.Count } }
    return @($out)
}

function Add-ProcessFlags {
    <# Annotates processes with deterministic flags. $Policy = result of Get-ProcessPolicy. Returns same list. #>
    param($Processes, $Config, $Policy)
    $cpuT = [double]$Config.thresholds.cpuPct; $memT = [double]$Config.thresholds.memoryMB
    $byName = $Processes | Group-Object { $_.name.ToLowerInvariant() }
    $aggMem = @{}; foreach ($g in $byName) { $aggMem[$g.Name] = ($g.Group | Measure-Object memoryMB -Sum).Sum }
    foreach ($p in $Processes) {
        $f = New-Object System.Collections.ArrayList
        $n = $p.name.ToLowerInvariant()
        $match = Find-PolicyMatch -Policy $Policy -Name $p.name -Path $p.path
        $p.policy = $match.list
        if ($match.list -eq 'blacklist') { [void]$f.Add('blacklisted') }
        if ($match.list -eq 'whitelist') { [void]$f.Add('whitelisted') }
        if ($p.cpuPct -ge $cpuT) { [void]$f.Add('high-cpu') }
        if ($p.memoryMB -ge $memT -or $aggMem[$n] -ge ($memT * 2)) { [void]$f.Add('high-memory') }
        if ($p.persistent) { [void]$f.Add('persistent') }
        if ($p.pathClass -in @('temp', 'downloads') -or ($p.pathClass -eq 'user-appdata' -and -not $p.signed -and $p.classification -ne 'known-app')) { [void]$f.Add('unusual-location') }
        if ($p.path -and $p.pathClass -ne 'system' -and -not $p.signed -and $p.signature -ne 'Unknown') { [void]$f.Add('unsigned') }
        if ($p.path -and -not $p.publisher -and $p.pathClass -ne 'system') { [void]$f.Add('no-publisher') }
        if ($p.instances -ge 3 -and $p.classification -ne 'windows' -and ($script:MultiProcessApps -notcontains $n)) { [void]$f.Add('duplicate') }
        $p.flags = @($f)
    }
    return $Processes
}

function Get-ProcessDescription {
    param($Proc)
    $n = $Proc.name.ToLowerInvariant()
    if ($script:Descriptions.ContainsKey($n)) { return $script:Descriptions[$n] }
    if ($Proc.pathClass -eq 'system' -and $Proc.description) { return "Windows component: $($Proc.description)." }
    if ($Proc.description -and $Proc.publisher) { return "$($Proc.description) (publisher: $($Proc.publisher)). Description taken from the file's metadata; Guardian has no curated entry for it." }
    if ($Proc.publisher) { return "Executable published by $($Proc.publisher). Guardian has no curated description for it." }
    return 'Unrecognised executable with no publisher metadata. Unfamiliar does not mean malicious; check the path and signature before acting.'
}

Export-ModuleMember -Function *
