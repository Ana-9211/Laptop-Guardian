# Shared test helpers (Pester 3.x compatible). Dot-source from each *.Tests.ps1.
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
function New-TestRoot {
    $t = Join-Path $env:TEMP ("guardian-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $t | Out-Null
    $env:GUARDIAN_ROOT = $t
    return $t
}
function Import-Guardian { . (Join-Path $script:RepoRoot 'src\powershell\Common\Load.ps1') }
function Remove-TestRoot { param($Root) Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue }

function Test-JsonSchema {
    <# Minimal JSON-schema (draft-07 subset): type, enum, required, properties, items, minimum, maximum, $ref(#/definitions/x). Returns list of error strings. #>
    param($Value, $Schema, $Root = $null, [string]$Path = '$')
    if ($null -eq $Root) { $Root = $Schema }
    $errs = New-Object System.Collections.ArrayList
    if ($Schema.PSObject.Properties.Name -contains '$ref') { $name = ($Schema.'$ref' -split '/')[-1]; $Schema = $Root.definitions.$name }
    $has = { param($o, $n) $null -ne $o -and $o.PSObject.Properties.Name -contains $n }
    if (& $has $Schema 'type') {
        $types = @($Schema.type); $ok = $false
        foreach ($t in $types) {
            switch ($t) {
                'null' { if ($null -eq $Value) { $ok = $true } }
                'string' { if ($Value -is [string]) { $ok = $true } }
                'boolean' { if ($Value -is [bool]) { $ok = $true } }
                'integer' { if ($Value -is [int] -or $Value -is [long] -or ($Value -is [double] -and $Value -eq [math]::Floor($Value))) { $ok = $true } }
                'number' { if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) { $ok = $true } }
                'array' { if ($Value -is [array]) { $ok = $true } }
                'object' { if ($Value -is [psobject] -and $Value -isnot [string] -and $Value -isnot [array] -and $null -ne $Value -and $Value -isnot [ValueType]) { $ok = $true } }
            }
        }
        if (-not $ok) { [void]$errs.Add("$Path : expected type $($types -join '|') but got $(if ($null -eq $Value) { 'null' } else { $Value.GetType().Name })"); return $errs }
    }
    if ($null -eq $Value) { return $errs }
    if (& $has $Schema 'enum') { if (@($Schema.enum) -cnotcontains $Value) { [void]$errs.Add("$Path : '$Value' not in enum ($(@($Schema.enum) -join ','))") } }
    if (& $has $Schema 'minimum') { if ($Value -lt $Schema.minimum) { [void]$errs.Add("$Path : below minimum") } }
    if (& $has $Schema 'maximum') { if ($Value -gt $Schema.maximum) { [void]$errs.Add("$Path : above maximum") } }
    if ((& $has $Schema 'required') -and $Value -is [psobject] -and $Value -isnot [array]) {
        foreach ($r in @($Schema.required)) { if ($Value.PSObject.Properties.Name -notcontains $r) { [void]$errs.Add("$Path : missing required '$r'") } }
    }
    if ((& $has $Schema 'properties') -and $Value -is [psobject] -and $Value -isnot [array]) {
        foreach ($p in $Schema.properties.PSObject.Properties) { if ($Value.PSObject.Properties.Name -contains $p.Name) { foreach ($e in (Test-JsonSchema -Value $Value.($p.Name) -Schema $p.Value -Root $Root -Path "$Path.$($p.Name)")) { [void]$errs.Add($e) } } }
    }
    if ((& $has $Schema 'items') -and $Value -is [array]) {
        $i = 0; foreach ($it in $Value) { foreach ($e in (Test-JsonSchema -Value $it -Schema $Schema.items -Root $Root -Path "$Path[$i]")) { [void]$errs.Add($e) }; $i++ }
    }
    return $errs
}
function Get-Schema { param([string]$Name) Get-Content (Join-Path $script:RepoRoot "src\shared\schemas\$Name.schema.json") -Raw | ConvertFrom-Json }

function New-FakeProcess {
    param([string]$Name = 'fakeapp', [int]$ProcId = 99999, [string]$Path = 'C:\Users\x\AppData\Local\Temp\fakeapp.exe', [double]$Cpu = 0, [double]$Mem = 50, [bool]$Signed = $false, $Publisher = $null, [string]$PathClass = 'temp',
        [string]$Classification = 'unknown', [string[]]$Flags = @(), [string]$Policy = 'none', [bool]$Persistent = $false, [string[]]$Services = @(), [string[]]$Tasks = @(), $Startup = @())
    [pscustomobject]@{ name = $Name; pid = $ProcId; path = $Path; commandLine = $null; parentPid = 1; parentName = 'explorer'; cpuPct = $Cpu; cpuSeconds = 1; memoryMB = $Mem; startTime = $null
        publisher = $Publisher; signature = $(if ($Signed) { 'Valid' } else { 'NotSigned' }); signed = $Signed; description = $null; services = $Services; startupEntries = @($Startup); scheduledTasks = $Tasks
        persistent = $Persistent; user = $null; pathClass = $PathClass; classification = $Classification; instances = 1; flags = $Flags; policy = $Policy; recommendationId = $null }
}

# --- Mock Gemini server (HttpListener in a background job). Behaviour is selected via a mode file. ---
function Start-MockGemini {
    param([int]$Port = 18999, [string]$ModeFile)
    Set-Content -Path $ModeFile -Value 'ok'
    $job = Start-Job -ArgumentList $Port, $ModeFile -ScriptBlock {
        param($port, $modeFile)
        $l = New-Object System.Net.HttpListener; $l.Prefixes.Add("http://127.0.0.1:$port/"); $l.Start()
        while ($l.IsListening) {
            $ctx = $l.GetContext(); $mode = (Get-Content $modeFile -Raw).Trim()
            $body = $null; $status = 200
            $good = '{"classification":"known-application","what_is_it":"Test app","why_flagged":"High memory","risk":"LOW","persistence":"none","suggested_action":"Review","temporary_stop_method":"Stop-Process -Id 123","persistence_removal_method":"","consequences":"App closes","confidence":0.8,"evidence":["mem 2GB"],"warnings":[]}'
            switch ($mode) {
                'ok' { $text = $good }
                'malformed' { $text = '{not json at all' }
                'badenum' { $text = $good -replace '"risk":"LOW"', '"risk":"CATASTROPHIC"' }
                'danger' { $text = $good -replace 'Stop-Process -Id 123', 'Stop-Process -Id 1; Remove-Item C:\\ -Recurse' }
                'missing' { $text = '{"classification":"unknown"}' }
                'http500' { $status = 500; $text = '{}' }
                'briefing' { $text = '{"briefing":"All fine.","patterns":[{"title":"Disk shrinking","detail":"d","evidence":["diskFreeGB 100->90"]},{"title":"No evidence pattern","detail":"x","evidence":[]}],"recommendations":["Clean downloads","Run Remove-Item C:\\ now"]}' }
                default { $text = $good }
            }
            $envelope = @{ candidates = @(@{ content = @{ parts = @(@{ text = $text }) } }); usageMetadata = @{ promptTokenCount = 10; candidatesTokenCount = 20 } } | ConvertTo-Json -Depth 8
            $bytes = [Text.Encoding]::UTF8.GetBytes($envelope)
            $ctx.Response.StatusCode = $status; $ctx.Response.ContentType = 'application/json'
            $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length); $ctx.Response.Close()
        }
    }
    Start-Sleep -Milliseconds 800
    return $job
}

function Get-RemediationSource {
    <# The whole remediation module as text: the .psm1 plus every family file it dot-sources. Source-scan tests must cover all of it. #>
    $dir = Join-Path $script:RepoRoot 'src\powershell\Actions'
    $files = @(Join-Path $dir 'Remediation.psm1') + @(Get-ChildItem (Join-Path $dir 'Remediation') -Filter *.ps1 | ForEach-Object FullName)
    ($files | ForEach-Object { Get-Content $_ -Raw }) -join "`n"
}

function Get-NetworkActionsSource {
    <# The whole network-actions module as text: the .psm1 plus every family file it dot-sources. #>
    $dir = Join-Path $script:RepoRoot 'src\powershell\Actions'
    $files = @(Join-Path $dir 'NetworkActions.psm1') + @(Get-ChildItem (Join-Path $dir 'NetworkActions') -Filter *.ps1 | ForEach-Object FullName)
    ($files | ForEach-Object { Get-Content $_ -Raw }) -join "`n"
}
