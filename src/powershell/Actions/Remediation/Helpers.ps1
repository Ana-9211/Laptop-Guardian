# Thin wrappers over the system (mocked in tests) and shared lookups.
# Dot-sourced by Actions\Remediation.psm1 (same module scope, so Pester mocks and exports are unchanged).
# ---------- thin wrappers over the system (mocked in tests) ----------
function Get-LiveProcessInfo {
    param([int]$ProcessId)
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { return $null }
    $path = $null; $cmd = $null
    try { $w = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop; $path = $w.ExecutablePath; $cmd = $w.CommandLine } catch { }
    if (-not $path) { try { $path = $p.Path } catch { } }
    $start = $null; try { $start = $p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss') } catch { }
    [pscustomobject]@{ Name = $p.ProcessName; Path = $path; StartTime = $start; CommandLine = $cmd }
}
function Test-AdminNow { Test-IsAdmin }

function Get-RunLocationInfo {
    <# Maps a startup entry location to the StartupApproved key that Windows itself uses to enable/disable it. #>
    param([string]$Kind, [string]$Location)
    $loc = $Location.TrimEnd('\')
    if ($Kind -eq 'registry') {
        $map = @{
            'HKCU:\software\microsoft\windows\currentversion\run'              = @{ Approved = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'; Hive = 'HKCU' }
            'HKLM:\software\microsoft\windows\currentversion\run'              = @{ Approved = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'; Hive = 'HKLM' }
            'HKLM:\software\wow6432node\microsoft\windows\currentversion\run'  = @{ Approved = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32'; Hive = 'HKLM' }
        }
        $k = $loc.ToLowerInvariant()
        if ($map.ContainsKey($k)) { return [pscustomobject]@{ Source = $Location; Approved = $map[$k].Approved; Hive = $map[$k].Hive } }
        return $null
    }
    $user = [Environment]::GetFolderPath('Startup'); $common = [Environment]::GetFolderPath('CommonStartup')
    if ($user -and ($loc -ieq $user.TrimEnd('\'))) { return [pscustomobject]@{ Source = $Location; Approved = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'; Hive = 'HKCU' } }
    if ($common -and ($loc -ieq $common.TrimEnd('\'))) { return [pscustomobject]@{ Source = $Location; Approved = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'; Hive = 'HKLM' } }
    return $null
}
function Test-StartupEntryExists {
    param([string]$Kind, [string]$Name, [string]$Location)
    if ($Kind -eq 'registry') {
        if (-not (Test-Path -LiteralPath $Location)) { return $null }
        $props = Get-ItemProperty -LiteralPath $Location -ErrorAction SilentlyContinue
        if ($props -and ($props.PSObject.Properties.Name -contains $Name)) { return $Name }
        return $null
    }
    $f = @(Get-ChildItem -LiteralPath $Location -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -ieq $Name -or $_.Name -ieq $Name })
    if ($f.Count -eq 1) { return $f[0].Name }
    return $null
}
function Get-StartupApprovedByte {
    param([string]$ApprovedKey, [string]$ValueName)
    try { $v = (Get-ItemProperty -LiteralPath $ApprovedKey -Name $ValueName -ErrorAction Stop).$ValueName; if ($v -is [byte[]] -and $v.Length -ge 1) { return [int]$v[0] } } catch { }
    return 2 # no flag recorded means enabled
}
function Set-StartupApprovedByte {
    param([string]$ApprovedKey, [string]$ValueName, [bool]$Enabled)
    if (-not (Test-Path -LiteralPath $ApprovedKey)) { New-Item -Path $ApprovedKey -Force | Out-Null }
    $bytes = New-Object byte[] 12
    if ($Enabled) { $bytes[0] = 2 } else { $bytes[0] = 3; $ft = [BitConverter]::GetBytes([DateTime]::UtcNow.ToFileTimeUtc()); [Array]::Copy($ft, 0, $bytes, 4, 8) }
    Set-ItemProperty -LiteralPath $ApprovedKey -Name $ValueName -Value $bytes -Type Binary -ErrorAction Stop
}

function Get-TaskForAction { param([string]$TaskPath, [string]$TaskName) Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue }
function Get-ServiceForAction { param([string]$Name) Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue }
function Move-FileToRecycle { param([string]$Path, [string[]]$ProtectedDirs) Move-ToRecycleBin -Path $Path -ProtectedDirs $ProtectedDirs }
