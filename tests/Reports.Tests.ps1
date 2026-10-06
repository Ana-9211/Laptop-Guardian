. "$PSScriptRoot\Helpers.ps1"
$root = New-TestRoot; Import-Guardian; Initialize-GuardianDirectories
$cfg = Get-GuardianConfig

function New-FakeCtx {
    $disk = [pscustomobject]@{ drive = 'C:'; fs = 'NTFS'; type = 'SSD'; totalGB = 500; freeGB = 120; usedPct = 76; freePct = 24; health = 'Healthy' }
    $sections = [pscustomobject][ordered]@{
        system = [pscustomobject]@{ os = 'Windows 11'; build = '26200'; uptimeHours = 5; bootTime = $null; cpu = [pscustomobject]@{ name = 'cpu'; cores = 4; logical = 8; usagePct = 12 }; ram = [pscustomobject]@{ totalGB = 16; usedGB = 8; freeGB = 8; usedPct = 50 }; pagefile = $null; disks = @($disk); battery = $null; temperature = $null; load = $null }
        storage = [pscustomobject]@{ tempMB = 10; crashDumpMB = 0; cacheMB = 5; installersMB = 0; downloads = [pscustomobject]@{ count = 3; sizeGB = 1.5; oldCount = 1 }; largeFiles = @(); duplicateCandidates = 0 }
        processes = [pscustomobject]@{ total = 100; flagged = 2; persistent = 10; highResource = 1; topCpu = @(); topMemory = @() }
        services = [pscustomobject]@{ running = 80; stopped = 100; autoStartStopped = @(); failed = @(); thirdParty = @() }
        startup = [pscustomobject]@{ count = 3; items = @() }
        defender = [pscustomobject]@{ available = $true; enabled = $true; realTimeProtection = $true; sigVersion = '1'; sigAgeDays = 1; lastQuickScan = $null; threats = 0; scan = [pscustomobject]@{ ran = $false; result = 'not-run'; durationSec = 0; threats = @() } }
        firewall = [pscustomobject]@{ profiles = @([pscustomobject]@{ name = 'Public'; enabled = $true; defaultInbound = 'Block'; defaultOutbound = 'Allow' }); problems = @() }
        windowsHealth = [pscustomobject]@{ pendingReboot = $false; windowsUpdate = [pscustomobject]@{ pendingCount = 0; lastInstalled = $null; status = 'ok' }; eventErrors = [pscustomobject]@{ system = 1; application = 2; top = @() }; sfc = [pscustomobject]@{ ran = $false; result = 'not-run' }; dism = [pscustomobject]@{ ran = $false; result = 'not-run'; detail = '' }; componentStore = $null }
        network = [pscustomobject]@{ adapters = @(); gateway = '1.1.1.1'; dnsServers = @(); internet = $true; dnsOk = $true; gatewayOk = $true; latencyMs = 10 }
        cleanup = [pscustomobject]@{ performed = $false; safeMode = $true; items = @(); totalFreedMB = 0 }
        files = [pscustomobject]@{ candidateCount = 0; reclaimableGB = 0 }
    }
    [pscustomobject]@{ Sections = $sections; Processes = @((New-FakeProcess -Name 'a' -Flags @('high-cpu'))); Recs = @(); Incomplete = @(); AiStat = $null }
}

Describe 'Report generation' {
    It 'builds a schema-valid report' {
        Start-RunContext -RunType 'daily'
        $ctx = New-FakeCtx
        $rep = New-RunReport -Config $cfg -Ctx $ctx -Type 'daily' -Id '2026-10-03' -Started (Get-Date).AddSeconds(-5) -Events (Get-RunEvents) -Errors (Get-RunErrors)
        $json = $rep | ConvertTo-Json -Depth 14 | ConvertFrom-Json
        $errs = @(Test-JsonSchema -Value $json -Schema (Get-Schema 'report'))
        if ($errs.Count) { $errs | Out-Host }
        $errs.Count | Should Be 0
        $rep.healthScore | Should BeGreaterThan 80
    }
    It 'saves JSON + HTML, updates latest, and survives a re-read (reboot persistence)' {
        Start-RunContext -RunType 'daily'
        $ctx = New-FakeCtx
        $rep = New-RunReport -Config $cfg -Ctx $ctx -Type 'daily' -Id '2026-10-04' -Started (Get-Date) -Events (Get-RunEvents) -Errors (Get-RunErrors)
        $dir = Save-Report -Report $rep
        (Test-Path "$dir\report.json") | Should Be $true
        (Test-Path "$dir\report.html") | Should Be $true
        (Read-JsonFile "$dir\report.json").id | Should Be '2026-10-04'
        (Read-JsonFile (Get-GuardianPath 'LatestDaily')).id | Should Be '2026-10-04'
    }
    It 'HTML-escapes hostile content (no script injection from process names or AI text)' {
        Start-RunContext -RunType 'daily'
        $ctx = New-FakeCtx
        $evil = New-FakeProcess -Name '<script>alert(1)</script>' -Flags @('high-cpu'); $ctx.Sections.processes.topCpu = @($evil)
        $rep = New-RunReport -Config $cfg -Ctx $ctx -Type 'daily' -Id '2026-10-05' -Started (Get-Date) -Events @() -Errors @()
        $rep.ai.briefing = '<img src=x onerror=alert(1)>'
        $html = ConvertTo-ReportHtml -Report $rep
        $html | Should Not Match '<script>alert'
        $html | Should Not Match '<img src=x'
        $html | Should Match 'Content-Security-Policy'
    }
    It 'writes metrics that match the metric schema' {
        Start-RunContext -RunType 'daily'
        $ctx = New-FakeCtx
        $rep = New-RunReport -Config $cfg -Ctx $ctx -Type 'daily' -Id '2026-10-06' -Started (Get-Date) -Events @() -Errors @()
        Write-RunMetric -Report $rep -Ctx $ctx -Events @() -Errors @()
        $m = Read-JsonLines -Path (Get-GuardianPath 'Metrics') | Select-Object -Last 1
        @(Test-JsonSchema -Value $m -Schema (Get-Schema 'metric')).Count | Should Be 0
    }
    It 'stores the health score reasons with each metric row, and an empty list when nothing was deducted' {
        Start-RunContext -RunType 'daily'
        $ctx = New-FakeCtx
        $rep = New-RunReport -Config $cfg -Ctx $ctx -Type 'daily' -Id '2026-10-07' -Started (Get-Date) -Events @() -Errors @()
        $rep.healthReasons = @('-10 RAM above 90%', '-5 Defender signatures older than 7 days')
        Write-RunMetric -Report $rep -Ctx $ctx -Events @() -Errors @()
        $m = Read-JsonLines -Path (Get-GuardianPath 'Metrics') | Select-Object -Last 1
        @($m.healthReasons).Count | Should Be 2
        $m.healthReasons[0] | Should Be '-10 RAM above 90%'
        @(Test-JsonSchema -Value $m -Schema (Get-Schema 'metric')).Count | Should Be 0
        $rep.healthReasons = @()
        Write-RunMetric -Report $rep -Ctx $ctx -Events @() -Errors @()
        $m2 = Read-JsonLines -Path (Get-GuardianPath 'Metrics') | Select-Object -Last 1
        @($m2.healthReasons).Count | Should Be 0
        @(Test-JsonSchema -Value $m2 -Schema (Get-Schema 'metric')).Count | Should Be 0
    }
    It 'retention=0 never deletes reports; retention>0 deletes only old ones' {
        Invoke-Retention -Config $cfg
        (Test-Path (Join-Path (Get-GuardianPath 'Reports') 'daily\2026-10-04')) | Should Be $true
        $dir = Join-Path (Get-GuardianPath 'Reports') 'daily\2020-01-01'; New-Item -ItemType Directory $dir | Out-Null; (Get-Item $dir).LastWriteTime = (Get-Date).AddDays(-900)
        $c2 = [pscustomobject]@{ retention = [pscustomobject]@{ reportsDays = 365 } }
        Invoke-Retention -Config $c2
        (Test-Path $dir) | Should Be $false
        (Test-Path (Join-Path (Get-GuardianPath 'Reports') 'daily\2026-10-04')) | Should Be $true
    }
}

Describe 'Health score and trends' {
    It 'penalises low disk, Defender off and threats' {
        $ctx = New-FakeCtx; $ctx.Sections.system.disks[0].freePct = 3; $ctx.Sections.defender.realTimeProtection = $false; $ctx.Sections.defender.threats = 2
        (Get-HealthScore -Sections $ctx.Sections -Config $cfg).score | Should BeLessThan 60
    }
    It 'never goes outside 0..100' { $ctx = New-FakeCtx; $ctx.Sections.system.ram.usedPct = 99; $s = (Get-HealthScore -Sections $ctx.Sections -Config $cfg).score; ($s -ge 0 -and $s -le 100) | Should Be $true }
    It 'detects a shrinking-disk trend from stored metrics and nothing when flat' {
        Remove-Item (Get-GuardianPath 'Metrics') -Force -ErrorAction SilentlyContinue
        0..6 | ForEach-Object { Add-JsonLine -Path (Get-GuardianPath 'Metrics') -Object ([ordered]@{ ts = (Get-Date).AddDays(-6 + $_).ToString('yyyy-MM-ddTHH:mm:sszzz'); runType = 'daily'; diskFreeGB = 200 - 5 * $_; ramPct = 40; serviceFailures = 0; errorCount = 0; defenderThreats = 0 }) }
        @(Get-RecurringPatterns -Days 10 -Recommendations @() | Where-Object { $_.title -like '*disk*' }).Count | Should Be 1
        Remove-Item (Get-GuardianPath 'Metrics') -Force
        0..6 | ForEach-Object { Add-JsonLine -Path (Get-GuardianPath 'Metrics') -Object ([ordered]@{ ts = (Get-Date).AddDays(-6 + $_).ToString('yyyy-MM-ddTHH:mm:sszzz'); runType = 'daily'; diskFreeGB = 200; ramPct = 40; serviceFailures = 0; errorCount = 0; defenderThreats = 0 }) }
        @(Get-RecurringPatterns -Days 10 -Recommendations @() | Where-Object { $_.title -like '*disk*' }).Count | Should Be 0
    }
    It 'reports recurring recommendations from real counters (not invented)' {
        $r = Add-RecommendationItem -Kind 'system' -Key 'rr' -Title 'Recurring thing' -WhatIsIt 'w' -Why @('x'); $r.consecutiveDays = 6; $r.occurrences = 6
        $p = @(Get-RecurringPatterns -Days 7 -Recommendations @($r))
        ($p | Where-Object { $_.detail -match '6 consecutive days' }) | Should Not BeNullOrEmpty
    }
}

Describe 'System recommendations' {
    It 'flags low disk space as a storage recommendation' {
        $ctx = New-FakeCtx; $ctx.Sections.system.disks[0].freePct = 5; $ctx.Sections.system.disks[0].freeGB = 25
        $r = @(New-SystemRecommendations -Sections $ctx.Sections -Config $cfg)
        ($r | Where-Object { $_.kind -eq 'storage' -and $_.risk -eq 'HIGH' }) | Should Not BeNullOrEmpty
    }
    It 'flags Defender real-time protection off as HIGH security' {
        $ctx = New-FakeCtx; $ctx.Sections.defender.realTimeProtection = $false
        (@(New-SystemRecommendations -Sections $ctx.Sections -Config $cfg) | Where-Object { $_.kind -eq 'security' }).risk | Should Be 'HIGH'
    }
    It 'produces nothing for a healthy system' { @(New-SystemRecommendations -Sections (New-FakeCtx).Sections -Config $cfg).Count | Should Be 0 }
}
Describe 'Metric errorCount' {
    It 'counts collector errors plus timed-out or failed phases, without counting one problem twice' {
        $rep = [pscustomobject]@{ incomplete = @('Defender full scan: timeout', 'Storage scan truncated by time/entry limit'); weekly = [pscustomobject]@{ phases = @([pscustomobject]@{ status = 'timeout' }, [pscustomobject]@{ status = 'failed' }, [pscustomobject]@{ status = 'complete' }, [pscustomobject]@{ status = 'incomplete' }) } }
        Get-RunProblemCount -Report $rep -Errors @('boom') | Should Be 3          # 1 error + max(2 phases, 1 note)
        Get-RunProblemCount -Report ([pscustomobject]@{ incomplete = @(); weekly = $null }) -Errors @() | Should Be 0
        Get-RunProblemCount -Report ([pscustomobject]@{ incomplete = @('Run aborted: x', 'Defender quick scan: failed') }) -Errors @() | Should Be 2
    }
}
Remove-TestRoot $root
