# service.disable / service.enable
# Dot-sourced by Actions\Remediation.psm1 (same module scope, so Pester mocks and exports are unchanged).
# ---------- service.disable / service.enable ----------
function Test-ServiceChange {
    param([hashtable]$P, [bool]$Enable)
    $n = [string]$P.name
    if ((Get-ProtectedServiceNames) -contains $n.ToLowerInvariant()) { return New-RemResult -Ok $false -Errors @("Protected: '$n' is a Windows or security service. Guardian will never change it.") }
    $s = Get-ServiceForAction -Name $n
    if (-not $s) { return New-RemResult -Ok $false -Errors @("The service '$n' does not exist.") }
    $pathName = [string]$s.PathName
    if ($pathName -match '(?i)svchost\.exe' -or ($env:SystemRoot -and $pathName.IndexOf($env:SystemRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0)) { return New-RemResult -Ok $false -Errors @('Protected: this service is part of Windows (it runs from the Windows directory or inside svchost).') }
    if ($s.ServiceType -and ([string]$s.ServiceType) -match 'Kernel|File System|Driver') { return New-RemResult -Ok $false -Errors @('Protected: Guardian never changes drivers.') }
    $mode = [string]$s.StartMode
    if (-not $Enable -and $mode -eq 'Disabled') { return New-RemResult -Ok $false -Errors @('This service is already disabled.') }
    if ($Enable -and $mode -ne 'Disabled') { return New-RemResult -Ok $false -Errors @('This service is not disabled.') }
    if (-not (Test-AdminNow)) { return New-RemResult -Ok $false -NeedsAdmin $true -NeedsElevation $true -Errors @('Changing a service needs administrator permission.') }
    return New-RemResult -Ok $true -NeedsAdmin $true -IdentityKey (Get-StringKey @($n, $mode, $pathName)) -Details ([ordered]@{ startMode = $mode; path = $pathName; state = [string]$s.State })
}
function Convert-StartMode { param([string]$Mode) switch ($Mode) { 'Auto' { 'Automatic' } 'Automatic' { 'Automatic' } 'Manual' { 'Manual' } default { 'Manual' } } }
function Invoke-ServiceChange {
    param([hashtable]$P, $Validated, [bool]$Enable)
    $n = [string]$P.name
    $prev = [string]$Validated.details.startMode
    $target = if ($Enable) { Convert-StartMode $(if ($P.ContainsKey('startMode') -and $P.startMode) { [string]$P.startMode } else { 'Manual' }) } else { 'Disabled' }
    try { Set-Service -Name $n -StartupType $target -ErrorAction Stop } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    $s = Get-ServiceForAction -Name $n
    $ok = $s -and (([string]$s.StartMode -eq 'Disabled') -eq (-not $Enable))
    if (-not $ok) { return New-RemResult -Ok $false -Errors @('Windows did not report the new start type.') }
    $undo = if ($Enable) { [ordered]@{ action = 'service.disable'; params = [ordered]@{ name = $n } } } else { [ordered]@{ action = 'service.enable'; params = [ordered]@{ name = $n; startMode = $(if ($prev -in 'Auto', 'Automatic', 'Manual', 'Boot', 'System') { $(if ($prev -eq 'Auto') { 'Automatic' } else { $prev }) } else { 'Manual' }) } } }
    return New-RemResult -Ok $true -Verified $true -Message "Service $n start type is now $target (was $prev)." -Undo $undo
}

# ---------- service.stop / service.start (the running state only; the start type is not changed) ----------
function Get-ServiceGuardError {
    <# The same protections as Test-ServiceChange: protected names, Windows-owned services, drivers. Returns an error text or $null. #>
    param([string]$Name, $Service)
    if ((Get-ProtectedServiceNames) -contains $Name.ToLowerInvariant()) { return "Protected: '$Name' is a Windows or security service. Guardian will never change it." }
    if (-not $Service) { return "The service '$Name' does not exist." }
    $pathName = [string]$Service.PathName
    if ($pathName -match '(?i)svchost\.exe' -or ($env:SystemRoot -and $pathName.IndexOf($env:SystemRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0)) { return 'Protected: this service is part of Windows (it runs from the Windows directory or inside svchost).' }
    if ($Service.ServiceType -and ([string]$Service.ServiceType) -match 'Kernel|File System|Driver') { return 'Protected: Guardian never changes drivers.' }
    return $null
}
function Set-ServiceRunStateForAction {
    param([string]$Name, [bool]$Running)
    if ($Running) { Start-Service -Name $Name -ErrorAction Stop } else { Stop-Service -Name $Name -ErrorAction Stop }
}
function Test-ServiceRun {
    param([hashtable]$P, [bool]$Start)
    $n = [string]$P.name
    $s = Get-ServiceForAction -Name $n
    $err = Get-ServiceGuardError -Name $n -Service $s
    if ($err) { return New-RemResult -Ok $false -Errors @($err) }
    $state = [string]$s.State
    if (-not $Start -and $state -ne 'Running') { return New-RemResult -Ok $false -Errors @("The service is not running (it is $state).") }
    if ($Start -and $state -eq 'Running') { return New-RemResult -Ok $false -Errors @('The service is already running.') }
    if ($Start -and [string]$s.StartMode -eq 'Disabled') { return New-RemResult -Ok $false -Errors @('The service is disabled; enable it first.') }
    if (-not (Test-AdminNow)) { return New-RemResult -Ok $false -Errors @('Changing a service needs administrator permission.') -NeedsAdmin $true -NeedsElevation $true }
    return New-RemResult -Ok $true -NeedsAdmin $true -IdentityKey (Get-StringKey @($n, $state, [string]$s.PathName)) -Details ([ordered]@{ state = $state; startMode = [string]$s.StartMode; path = [string]$s.PathName })
}
function Invoke-ServiceRun {
    param([hashtable]$P, $Validated, [bool]$Start)
    $n = [string]$P.name
    try { Set-ServiceRunStateForAction -Name $n -Running $Start } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    $s = Get-ServiceForAction -Name $n
    $running = $s -and [string]$s.State -eq 'Running'
    if ($running -ne $Start) { return New-RemResult -Ok $false -Errors @("Windows did not report the service as $(if ($Start) { 'running' } else { 'stopped' }).") }
    $undo = if ($Start) { [ordered]@{ action = 'service.stop'; params = [ordered]@{ name = $n } } } else { [ordered]@{ action = 'service.start'; params = [ordered]@{ name = $n } } }
    return New-RemResult -Ok $true -Verified $true -Message "Service $n is now $(if ($Start) { 'running' } else { 'stopped' }). Its start type was not changed, so it may start again with Windows." -Undo $undo
}
