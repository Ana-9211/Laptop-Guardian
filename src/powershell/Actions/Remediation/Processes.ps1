# process.stop
# Dot-sourced by Actions\Remediation.psm1 (same module scope, so Pester mocks and exports are unchanged).
# ---------- process.stop ----------
function Test-ProcessStop {
    param([hashtable]$P)
    $pid0 = [int]$P.pid; $name = [string]$P.name
    $live = Get-LiveProcessInfo -ProcessId $pid0
    if (-not $live) { return New-RemResult -Ok $false -Errors @('That process is no longer running.') }
    if (($live.Name -replace '\.exe$', '') -ine ($name -replace '\.exe$', '')) { return New-RemResult -Ok $false -Errors @("PID $pid0 now belongs to '$($live.Name)', not '$name'. The PID was reused; refresh and review again.") }
    if (-not $live.Path) { return New-RemResult -Ok $false -Errors @('Guardian cannot read this process''s executable path (it may need elevation), so it refuses to stop it.') }
    if ($P.ContainsKey('path') -and $P.path -and ($live.Path -ine [string]$P.path)) { return New-RemResult -Ok $false -Errors @('The running executable differs from the one you reviewed; refresh and review again.') }
    if ($P.ContainsKey('startTime') -and $P.startTime -and $live.StartTime -and ($live.StartTime -ne [string]$P.startTime)) { return New-RemResult -Ok $false -Errors @('This PID was started at a different time than the process you reviewed (PID reuse); refresh and review again.') }
    $chk = Test-ProcessKillAllowed -Name $name -Path $live.Path -ProcessId $pid0
    if (-not $chk.Allowed) { return New-RemResult -Ok $false -Errors @("Protected: $($chk.Reason). Guardian will never stop this process, even with confirmation.") }
    foreach ($root in @(Get-GuardianRoots)) {
        if (($live.Path -and $live.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) -or ($live.CommandLine -and $live.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0)) {
            return New-RemResult -Ok $false -Errors @('Protected: this process belongs to Laptop Guardian itself.')
        }
    }
    $key = Get-StringKey @($pid0, $live.Name, $live.Path, $live.StartTime)
    $susp = [bool]$chk.Suspicious
    $warn = if ($susp) { @("Suspicious: $($chk.Reason). Stopping it is allowed, but only after you acknowledge that.") } else { @() }
    return New-RemResult -Ok $true -IdentityKey $key -Warnings $warn -Details ([ordered]@{ pid = $pid0; name = $live.Name; path = $live.Path; startedUtc = $live.StartTime; suspicious = $susp })
}
function Invoke-ProcessStop {
    param([hashtable]$P, $Validated)
    $pid0 = [int]$P.pid
    $before = Get-LiveProcessInfo -ProcessId $pid0
    try { Stop-Process -Id $pid0 -ErrorAction Stop } catch {
        if ($_.Exception.Message -match 'Access is denied') { return New-RemResult -Ok $false -NeedsElevation $true -Errors @('Windows denied access to stop this process. It may be running with higher rights.') }
        return New-RemResult -Ok $false -Errors @($_.Exception.Message)
    }
    $deadline = (Get-Date).AddSeconds(4); $gone = $false
    while ((Get-Date) -lt $deadline) { $now = Get-LiveProcessInfo -ProcessId $pid0; if (-not $now -or $now.StartTime -ne $before.StartTime) { $gone = $true; break }; Start-Sleep -Milliseconds 200 }
    if (-not $gone) { return New-RemResult -Ok $false -Errors @("Windows accepted the request but PID $pid0 is still running.") }
    Start-Sleep -Milliseconds 1500
    $again = @(Get-Process -Name ($before.Name) -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -ieq $before.Path } catch { $false } })
    $relaunched = $again.Count -gt 0 -and -not (@($again | Where-Object { $_.Id -eq $pid0 }).Count)
    $msg = "Stopped $($before.Name) (PID $pid0)."
    if ($relaunched) { $msg += ' A new copy has already started: something relaunches it. Use Disable restart to stop that.' }
    return New-RemResult -Ok $true -Verified $true -Message $msg -Details ([ordered]@{ relaunched = $relaunched; name = $before.Name; pid = $pid0 })
}
