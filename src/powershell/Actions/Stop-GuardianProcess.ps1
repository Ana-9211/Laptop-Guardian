#requires -Version 5.1
# Called by the dashboard bridge after explicit user confirmation. Prints one JSON object.
param([Parameter(Mandatory)][int]$ProcessId, [Parameter(Mandatory)][string]$Name, [string]$Path = '')
. "$PSScriptRoot\..\Common\Load.ps1"
Start-RunContext -RunType 'user'
function Out-Result($ok, $msg) { (@{ ok = $ok; success = $ok; message = $msg; error = $(if ($ok) { $null } else { $msg }) } | ConvertTo-Json -Compress); exit $(if ($ok) { 0 } else { 1 }) }
try {
    $cfg = Get-GuardianConfig
    $live = Get-Process -Id $ProcessId -ErrorAction Stop
    if (($live.ProcessName -replace '\.exe$', '') -ine ($Name -replace '\.exe$', '')) { Out-Result $false 'PID now belongs to a different process; refresh and retry' }
    # Use the LIVE executable path (never the caller-supplied one). Fail closed when it cannot be read.
    $livePath = $null
    try { $livePath = (Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop).ExecutablePath } catch { }
    if (-not $livePath) { try { $livePath = $live.Path } catch { } }
    if (-not $livePath) { [void](Write-GuardianEvent -Category process -Action 'process:terminate-blocked' -Target "$Name#$ProcessId" -Result skipped -Actor user -Reason 'Executable path unreadable (needs elevation); refusing to verify'); Out-Result $false 'Cannot verify the executable path of this process (it may need elevation). Refusing for safety.' }
    $chk = Test-ProcessKillAllowed -Name $Name -Path $livePath -ProcessId $ProcessId
    if (-not $chk.Allowed) { [void](Write-GuardianEvent -Category process -Action 'process:terminate-blocked' -Target "$Name#$ProcessId" -Result skipped -Actor user -Reason $chk.Reason); Out-Result $false $chk.Reason }
    if ($Path -and ($livePath -ine $Path)) { Out-Result $false 'Executable path differs from the one analysed; refresh and retry' }
    Stop-Process -Id $ProcessId -ErrorAction Stop
    [void](Write-GuardianEvent -Category process -Action 'process:terminated' -Target "$Name#$ProcessId" -Actor user -Reason 'Kill once (user confirmed in dashboard)')
    Out-Result $true "Terminated $Name (PID $ProcessId). It may restart if a service/task/startup entry relaunches it."
} catch {
    [void](Write-GuardianEvent -Category process -Action 'process:terminate' -Target "$Name#$ProcessId" -Result failure -Severity warning -Actor user -ErrorDetails $_.Exception.Message)
    Out-Result $false $_.Exception.Message
}
