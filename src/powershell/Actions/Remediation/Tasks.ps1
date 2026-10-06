# task.disable / task.enable
# Dot-sourced by Actions\Remediation.psm1 (same module scope, so Pester mocks and exports are unchanged).
# ---------- task.disable / task.enable ----------
function Test-TaskChange {
    param([hashtable]$P, [bool]$Enable)
    $tp = [string]$P.taskPath; $tn = [string]$P.taskName
    if ($tp -match $script:ProtectedTaskPathRx) { return New-RemResult -Ok $false -Errors @('Protected: Windows and Laptop Guardian scheduled tasks are never changed by Guardian.') }
    $t = Get-TaskForAction -TaskPath $tp -TaskName $tn
    if (-not $t) { return New-RemResult -Ok $false -Errors @("The scheduled task $tp$tn no longer exists.") }
    $disabled = ([string]$t.State -eq 'Disabled')
    if ($Enable -and -not $disabled) { return New-RemResult -Ok $false -Errors @('This task is already enabled.') }
    if (-not $Enable -and $disabled) { return New-RemResult -Ok $false -Errors @('This task is already disabled.') }
    $needsAdmin = ([string]$t.Principal.RunLevel -eq 'Highest') -or ([string]$t.Principal.UserId -match 'SYSTEM|LOCAL SERVICE|NETWORK SERVICE')
    if ($needsAdmin -and -not (Test-AdminNow)) { return New-RemResult -Ok $false -NeedsAdmin $true -NeedsElevation $true -Errors @('This task runs with elevated or system rights, so changing it needs administrator permission.') }
    return New-RemResult -Ok $true -NeedsAdmin $needsAdmin -IdentityKey (Get-StringKey @($tp, $tn, [string]$t.State)) -Details ([ordered]@{ state = [string]$t.State; runLevel = [string]$t.Principal.RunLevel })
}
function Invoke-TaskChange {
    param([hashtable]$P, $Validated, [bool]$Enable)
    $tp = [string]$P.taskPath; $tn = [string]$P.taskName
    try { if ($Enable) { Enable-ScheduledTask -TaskPath $tp -TaskName $tn -ErrorAction Stop | Out-Null } else { Disable-ScheduledTask -TaskPath $tp -TaskName $tn -ErrorAction Stop | Out-Null } }
    catch { return New-RemResult -Ok $false -NeedsElevation ($_.Exception.Message -match 'denied') -Errors @($_.Exception.Message) }
    $t = Get-TaskForAction -TaskPath $tp -TaskName $tn
    $ok = $t -and ((([string]$t.State) -eq 'Disabled') -ne $Enable)
    if (-not $ok) { return New-RemResult -Ok $false -Errors @('Task Scheduler did not report the new state.') }
    $undoId = if ($Enable) { 'task.disable' } else { 'task.enable' }
    return New-RemResult -Ok $true -Verified $true -Message "Task $tp$tn is now $(if ($Enable) { 'enabled' } else { 'disabled' })." -Undo ([ordered]@{ action = $undoId; params = [ordered]@{ taskPath = $tp; taskName = $tn } })
}
