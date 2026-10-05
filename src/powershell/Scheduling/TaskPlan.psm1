#requires -Version 5.1
# Pure planning logic for Scheduler.ps1: decides what to do with each Guardian scheduled task. No Task Scheduler calls
# here, so every branch is unit-testable. The key rule: a non-elevated caller must never replace an elevated
# (RunLevel Highest) Daily/Weekly task, because the replacement would silently run without administrator rights.
Set-StrictMode -Version 2.0

function Get-TaskDrift {
    <# Lists how an existing task differs from what the config asks for. Empty list = nothing to change. #>
    param([Parameter(Mandatory)]$Existing, [Parameter(Mandatory)]$Desired, [bool]$IsAdmin)
    $drift = New-Object System.Collections.Generic.List[string]
    if (-not $Existing.scriptCurrent) { $drift.Add('task runs a different script path than this installation') }
    if ($Desired.needsScheduledFlag -and -not $Existing.scheduledFlag) { $drift.Add('task is missing the -Scheduled marker') }
    if ($Desired.time -and $Existing.time -ne $Desired.time) { $drift.Add("start time is $($Existing.time) but Settings say $($Desired.time)") }
    if ($Desired.day -and @($Existing.days) -notcontains $Desired.day) { $drift.Add("day is $(@($Existing.days) -join ',') but Settings say $($Desired.day)") }
    # Raising to Highest is only possible (and only wanted) when this process is elevated.
    if ($IsAdmin -and $Desired.wantsHighest -and $Existing.runLevel -ne 'Highest') { $drift.Add('task is not running with administrator rights') }
    return , @($drift)
}

function Get-TaskRegistrationPlan {
    <#
    .SYNOPSIS  Decides create / update / remove / unchanged / elevation-required for each task.
    .PARAMETER Desired   One object per kind: kind, enabled, time, day, needsScheduledFlag, wantsHighest
    .PARAMETER Existing  One object per kind: kind, exists, runLevel, scheduledFlag, scriptCurrent, time, days
    .OUTPUTS   Array of { kind; outcome; reasons; runLevel }.  runLevel is the level to register with (never lower than an existing Highest).
    #>
    param([Parameter(Mandatory)][object[]]$Desired, [Parameter(Mandatory)][object[]]$Existing, [Parameter(Mandatory)][bool]$IsAdmin)
    $plan = @()
    foreach ($d in $Desired) {
        $e = @($Existing | Where-Object { $_.kind -eq $d.kind })[0]
        $exists = [bool]($e -and $e.exists)
        $existingHighest = $exists -and $e.runLevel -eq 'Highest'
        $registerLevel = if ($IsAdmin -and $d.wantsHighest) { 'Highest' } else { 'Limited' }
        if (-not $d.enabled) {
            if (-not $exists) { $plan += [pscustomobject]@{ kind = $d.kind; outcome = 'unchanged'; reasons = @('already off'); runLevel = $null } }
            elseif ($existingHighest -and -not $IsAdmin) { $plan += [pscustomobject]@{ kind = $d.kind; outcome = 'elevation-required'; reasons = @('removing an elevated task needs administrator permission'); runLevel = $null } }
            else { $plan += [pscustomobject]@{ kind = $d.kind; outcome = 'remove'; reasons = @('turned off in Settings'); runLevel = $null } }
            continue
        }
        if (-not $exists) { $plan += [pscustomobject]@{ kind = $d.kind; outcome = 'create'; reasons = @('not registered'); runLevel = $registerLevel }; continue }
        $drift = Get-TaskDrift -Existing $e -Desired $d -IsAdmin $IsAdmin
        if ($drift.Count -eq 0) { $plan += [pscustomobject]@{ kind = $d.kind; outcome = 'unchanged'; reasons = @(); runLevel = $e.runLevel }; continue }
        if ($existingHighest -and -not $IsAdmin) { $plan += [pscustomobject]@{ kind = $d.kind; outcome = 'elevation-required'; reasons = $drift; runLevel = 'Highest' }; continue }
        $plan += [pscustomobject]@{ kind = $d.kind; outcome = 'update'; reasons = $drift; runLevel = $registerLevel }
    }
    return , $plan
}

Export-ModuleMember -Function Get-TaskDrift, Get-TaskRegistrationPlan
