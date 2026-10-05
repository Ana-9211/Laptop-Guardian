#requires -Version 5.1
# Services + startup summaries for the report.
Set-StrictMode -Version 2.0

function Get-ServicesHealth {
    param($Services, [int]$Days = 1)
    $r = [ordered]@{ running = 0; stopped = 0; autoStartStopped = @(); failed = @(); thirdParty = @() }
    $svc = @($Services)
    $r.running = @($svc | Where-Object { $_.state -eq 'Running' }).Count
    $r.stopped = @($svc | Where-Object { $_.state -eq 'Stopped' }).Count
    # Auto-start services that are stopped: many are trigger-start / delayed legit ones; only list non-Microsoft-looking or non-system ones to reduce noise.
    $r.autoStartStopped = @($svc | Where-Object { $_.startMode -eq 'Auto' -and $_.state -eq 'Stopped' -and $_.exitCode -ne 0 -and $_.exitCode -ne 1077 } | Select-Object -First 25 | ForEach-Object { $_.name })
    $failedEv = @(Get-FailedServiceEvents -Days $Days)
    $r.failed = @($failedEv | Select-Object -First 25)
    $win = if ($env:SystemRoot) { $env:SystemRoot.ToLowerInvariant() } else { 'c:\windows' }
    $r.thirdParty = @($svc | Where-Object { $_.path -and -not $_.path.ToLowerInvariant().StartsWith($win) -and -not ($_.path -like "*\Windows Defender\*") -and -not ($_.path -like "*\WindowsApps\*") } |
            Select-Object -First 60 | ForEach-Object { [pscustomobject]@{ name = $_.name; display = $_.display; path = $_.path; state = $_.state; startMode = $_.startMode } })
    [pscustomobject]$r
}

function Get-StartupHealth {
    param($Startup)
    $items = @($Startup | ForEach-Object {
            $pub = $null
            $exe = Resolve-CommandExecutable $_.command
            if ($exe) { try { $exe = [Environment]::ExpandEnvironmentVariables($exe); $pub = (Get-FileSignatureInfo $exe).publisher } catch { } }
            [pscustomobject]@{ kind = $_.kind; name = $_.name; location = $_.location; command = $_.command; publisher = $pub }
        })
    [pscustomobject]@{ count = $items.Count; items = $items }
}

Export-ModuleMember -Function *
