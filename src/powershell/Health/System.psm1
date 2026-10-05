#requires -Version 5.1
# System health: OS, CPU, RAM, pagefile, disks (SSD/HDD), battery, temperature, load.
Set-StrictMode -Version 2.0

function Get-SystemHealth {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $cpu = @(Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue)
    $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
    $displayVer = $null; try { $displayVer = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop).DisplayVersion } catch { }

    $cpuUse = $null
    try {
        $perf = Get-CimInstance -Query "SELECT PercentProcessorTime FROM Win32_PerfFormattedData_PerfOS_Processor WHERE Name='_Total'" -ErrorAction Stop
        $cpuUse = [double]$perf.PercentProcessorTime
    } catch { try { $cpuUse = [double](($cpu | Measure-Object LoadPercentage -Average).Average) } catch { } }

    $totalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
    $freeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
    $usedGB = [math]::Round($totalGB - $freeGB, 2)

    $pf = @(); try { $pf = @(Get-CimInstance Win32_PageFileUsage -ErrorAction Stop) } catch { }
    $pagefile = [pscustomobject]@{
        sizeMB = [int](($pf | Measure-Object AllocatedBaseSize -Sum).Sum); usedMB = [int](($pf | Measure-Object CurrentUsage -Sum).Sum)
    }

    $queue = $null; try { $queue = [int](Get-CimInstance Win32_PerfFormattedData_PerfOS_System -ErrorAction Stop).ProcessorQueueLength } catch { }
    $uptime = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)

    $name = ''; $cores = 0; $logical = 0
    if ($cpu.Count -gt 0) { $name = ($cpu[0].Name -replace '\s+', ' ').Trim(); $cores = [int](($cpu | Measure-Object NumberOfCores -Sum).Sum); $logical = [int](($cpu | Measure-Object NumberOfLogicalProcessors -Sum).Sum) }

    [pscustomobject][ordered]@{
        os = $os.Caption; build = $os.BuildNumber; displayVersion = $displayVer; uptimeHours = $uptime; bootTime = (ConvertTo-IsoTime $os.LastBootUpTime)
        manufacturer = $(if ($cs) { $cs.Manufacturer } else { $null }); model = $(if ($cs) { $cs.Model } else { $null })
        cpu = [pscustomobject]@{ name = $name; cores = $cores; logical = $logical; usagePct = $(if ($null -ne $cpuUse) { [math]::Round($cpuUse, 1) } else { $null }) }
        ram = [pscustomobject]@{ totalGB = $totalGB; usedGB = $usedGB; freeGB = $freeGB; usedPct = $(if ($totalGB -gt 0) { [math]::Round($usedGB / $totalGB * 100, 1) } else { 0 }) }
        pagefile = $pagefile
        disks = @(Get-DiskHealth)
        battery = (Get-BatteryHealth)
        temperature = (Get-TemperatureHealth)
        load = [pscustomobject]@{ processorQueue = $queue }
    }
}

function Get-DiskHealth {
    $result = New-Object System.Collections.ArrayList
    $typeMap = @{}; $healthMap = @{}
    try {
        $pds = @(Get-PhysicalDisk -ErrorAction Stop)
        $parts = @(Get-Partition -ErrorAction Stop | Where-Object { $_.DriveLetter })
        foreach ($part in $parts) {
            $pd = $pds | Where-Object { $_.DeviceId -eq [string]$part.DiskNumber } | Select-Object -First 1
            if (-not $pd) { continue }
            $mt = [string]$pd.MediaType
            $typeMap["$($part.DriveLetter):"] = $(if ($mt -in @('SSD', 'HDD')) { $mt } elseif ($pd.BusType -eq 'NVMe') { 'SSD' } else { 'Unknown' })
            $healthMap["$($part.DriveLetter):"] = [string]$pd.HealthStatus
        }
    } catch { }
    foreach ($d in @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue)) {
        $total = [math]::Round($d.Size / 1GB, 1); $free = [math]::Round($d.FreeSpace / 1GB, 1)
        [void]$result.Add([pscustomobject][ordered]@{
                drive = $d.DeviceID; fs = $d.FileSystem; type = $(if ($typeMap.ContainsKey($d.DeviceID)) { $typeMap[$d.DeviceID] } else { 'Unknown' })
                totalGB = $total; freeGB = $free; usedPct = $(if ($total -gt 0) { [math]::Round(($total - $free) / $total * 100, 1) } else { 0 })
                freePct = $(if ($total -gt 0) { [math]::Round($free / $total * 100, 1) } else { 0 }); health = $(if ($healthMap.ContainsKey($d.DeviceID)) { $healthMap[$d.DeviceID] } else { $null })
            })
    }
    return @($result)
}

function Get-BatteryHealth {
    try {
        $b = @(Get-CimInstance Win32_Battery -ErrorAction Stop)
        if ($b.Count -eq 0) { return $null }
        $st = [int]$b[0].BatteryStatus
        return [pscustomobject]@{ present = $true; pct = [int]$b[0].EstimatedChargeRemaining; charging = ($st -in 6, 7, 8, 9); onAC = ($st -notin 1, 4, 5); status = $st }
    } catch { return $null }
}

function Test-OnAcPower {
    # $true if on AC or no battery; $false if discharging; $null if unknown
    $b = Get-BatteryHealth
    if ($null -eq $b) { return $true }
    return [bool]$b.onAC
}

function Get-TemperatureHealth {
    try {
        $t = @(Get-CimInstance -Namespace 'root/wmi' -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop)
        if ($t.Count -gt 0) {
            $c = [math]::Round((($t | Measure-Object CurrentTemperature -Maximum).Maximum / 10) - 273.15, 1)
            if ($c -gt 0 -and $c -lt 150) { return [pscustomobject]@{ available = $true; celsius = $c } }
        }
    } catch { }
    return [pscustomobject]@{ available = $false; celsius = $null }
}

function Get-HealthScore {
    <# 0-100. Deductions are transparent and capped per category. #>
    param($Sections, $Config)
    $score = 100.0
    $why = New-Object System.Collections.ArrayList
    $deduct = { param($n, $r) $script:__d += $n; [void]$why.Add("-$n $r") }
    $script:__d = 0
    $s = $Sections
    try {
        $sys = $s.system
        if ($sys.ram.usedPct -gt 90) { & $deduct 10 'RAM above 90%' } elseif ($sys.ram.usedPct -gt 80) { & $deduct 5 'RAM above 80%' }
        if ($null -ne $sys.cpu.usagePct -and $sys.cpu.usagePct -gt 85) { & $deduct 5 'CPU above 85%' }
        foreach ($d in @($sys.disks)) {
            if ($d.freePct -lt $Config.thresholds.diskFreeCritPct) { & $deduct 15 "Disk $($d.drive) critically low" }
            elseif ($d.freePct -lt $Config.thresholds.diskFreeWarnPct) { & $deduct 7 "Disk $($d.drive) low on space" }
            if ($d.health -and $d.health -ne 'Healthy') { & $deduct 15 "Disk $($d.drive) health $($d.health)" }
        }
        $def = $s.defender
        if ($def) {
            if ($def.enabled -eq $false -or $def.realTimeProtection -eq $false) { & $deduct 20 'Defender real-time protection off' }
            if ($def.threats -gt 0) { & $deduct 15 'Defender reports threats' }
            if ($null -ne $def.sigAgeDays -and $def.sigAgeDays -gt 7) { & $deduct 5 'Defender signatures older than 7 days' }
        }
        $fw = $s.firewall
        if ($fw -and @($fw.profiles | Where-Object { $_.enabled -eq $false }).Count -gt 0) { & $deduct 10 'Firewall profile disabled' }
        $wh = $s.windowsHealth
        if ($wh) {
            if ($wh.pendingReboot) { & $deduct 3 'Reboot pending' }
            if ($wh.sfc -and $wh.sfc.result -eq 'violations-unrepaired') { & $deduct 10 'SFC found unrepaired corruption' }
            if ($wh.dism -and $wh.dism.result -eq 'repairable') { & $deduct 8 'Component store repairable' }
            if ($wh.eventErrors -and ($wh.eventErrors.system + $wh.eventErrors.application) -gt 100) { & $deduct 5 'Many event-log errors' }
        }
        if ($s.services -and @($s.services.failed).Count -gt 0) { & $deduct ([math]::Min(8, 2 * @($s.services.failed).Count)) 'Failed services' }
        if ($s.network -and $s.network.internet -eq $false) { & $deduct 3 'No internet connectivity' }
        if ($s.processes -and $s.processes.flagged -gt 10) { & $deduct 4 'Many flagged processes' }
    } catch { }
    $score = [math]::Max(0, [math]::Min(100, 100 - $script:__d))
    return [pscustomobject]@{ score = [int]$score; reasons = @($why) }
}

Export-ModuleMember -Function *
