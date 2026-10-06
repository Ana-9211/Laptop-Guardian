# scan.schedule-once / scan.cancel-once: a one-time Daily or Weekly scan at a time you choose.
# Dot-sourced by Actions\Remediation.psm1 (same module scope, so Pester mocks and exports are unchanged).
# The task runs with standard rights from this copy of Guardian, a weekly one-time scan never shuts the laptop down, and the task removes itself after it ran.
$script:OnceTaskFolder = '\LaptopGuardian\'
$script:OnceTaskPattern = '^Guardian one-time (daily|weekly) scan [0-9]{8}-[0-9]{4}$'

function Get-OnceTaskName { param([string]$Kind, [datetime]$At) "Guardian one-time $Kind scan $($At.ToString('yyyyMMdd-HHmm'))" }
function Get-OnceTaskForAction { param([string]$Name) Get-ScheduledTask -TaskPath $script:OnceTaskFolder -TaskName $Name -ErrorAction SilentlyContinue }
function Register-OnceTaskForAction {
    param([string]$Name, [string]$Kind, [datetime]$At)
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $codeRoot = Get-GuardianCodeRoot
    $script = Join-Path $codeRoot ('src\powershell\{0}.ps1' -f $(if ($Kind -eq 'weekly') { 'Weekly' } else { 'Daily' }))
    $taskArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" + $(if ($Kind -eq 'weekly') { ' -NoShutdown' } else { '' })
    $action = New-ScheduledTaskAction -Execute $psExe -Argument $taskArgs -WorkingDirectory $codeRoot
    $trigger = New-ScheduledTaskTrigger -Once -At $At
    $trigger.EndBoundary = $At.AddHours(12).ToString('s')
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -DeleteExpiredTaskAfter (New-TimeSpan -Days 1)
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskPath $script:OnceTaskFolder -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'One-time Laptop Guardian scan requested from the dashboard.' -Force | Out-Null
}
function Unregister-OnceTaskForAction { param([string]$Name) Unregister-ScheduledTask -TaskPath $script:OnceTaskFolder -TaskName $Name -Confirm:$false -ErrorAction Stop }

function Test-ScanScheduleOnce {
    param([hashtable]$P)
    $at = [datetime]::MinValue
    if (-not [datetime]::TryParseExact([string]$P.at, 'yyyy-MM-ddTHH:mm', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$at)) { return New-RemResult -Ok $false -Errors @('The time must look like 2026-10-07T19:30 (your local time).') }
    if ($at -lt (Get-Date).AddMinutes(1)) { return New-RemResult -Ok $false -Errors @('Pick a time in the future.') }
    if ($at -gt (Get-Date).AddDays(60)) { return New-RemResult -Ok $false -Errors @('Pick a time within the next 60 days.') }
    $name = Get-OnceTaskName -Kind ([string]$P.kind) -At $at
    if (Get-OnceTaskForAction -Name $name) { return New-RemResult -Ok $false -Errors @('A one-time scan is already planned for that minute.') }
    return New-RemResult -Ok $true -IdentityKey (Get-StringKey @($name)) -Details ([ordered]@{ taskName = $name; at = $at.ToString('s'); kind = [string]$P.kind })
}
function Invoke-ScanScheduleOnce {
    param([hashtable]$P, $Validated)
    $name = [string]$Validated.details.taskName; $at = [datetime]::ParseExact([string]$P.at, 'yyyy-MM-ddTHH:mm', [Globalization.CultureInfo]::InvariantCulture)
    try { Register-OnceTaskForAction -Name $name -Kind ([string]$P.kind) -At $at } catch { return New-RemResult -Ok $false -Errors @("Task Scheduler refused: $($_.Exception.Message)") }
    if (-not (Get-OnceTaskForAction -Name $name)) { return New-RemResult -Ok $false -Errors @('Task Scheduler did not show the new task afterwards.') }
    return New-RemResult -Ok $true -Verified $true -Message "A one-time $($P.kind) scan is planned for $($at.ToString('f')). The laptop must be on (or wake) then; the task removes itself afterwards." -Undo ([ordered]@{ action = 'scan.cancel-once'; params = [ordered]@{ taskName = $name } }) -Details ([ordered]@{ taskName = $name })
}
function Test-ScanCancelOnce {
    param([hashtable]$P)
    if ([string]$P.taskName -notmatch $script:OnceTaskPattern) { return New-RemResult -Ok $false -Errors @('Only Guardian''s own one-time scan tasks can be cancelled here.') }
    if (-not (Get-OnceTaskForAction -Name ([string]$P.taskName))) { return New-RemResult -Ok $false -Errors @('That one-time scan is not planned (any more).') }
    return New-RemResult -Ok $true -IdentityKey ([string]$P.taskName)
}
function Invoke-ScanCancelOnce {
    param([hashtable]$P)
    try { Unregister-OnceTaskForAction -Name ([string]$P.taskName) } catch { return New-RemResult -Ok $false -Errors @($_.Exception.Message) }
    if (Get-OnceTaskForAction -Name ([string]$P.taskName)) { return New-RemResult -Ok $false -Errors @('The task is still registered.') }
    return New-RemResult -Ok $true -Verified $true -Message 'The one-time scan was cancelled.'
}
