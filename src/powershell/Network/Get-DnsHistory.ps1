#requires -Version 5.1
# Read-only: recent DNS lookups recorded by the Windows DNS Client operational log, with the process that asked.
# Only works when that log is enabled (Deep Network Guard offers a confirmed action for that). Names only, never packets.
[CmdletBinding()]
param([ValidateRange(1, 1000)][int]$Max = 300)
. "$PSScriptRoot\..\Common\Load.ps1"
Start-RunContext -RunType 'user'
try {
    $log = Get-WinEvent -ListLog 'Microsoft-Windows-DNS-Client/Operational' -ErrorAction Stop
    if (-not $log.IsEnabled) { @{ available = $false; enabled = $false; reason = 'The Windows DNS Client log is off. Turn it on from Deep Network Guard (needs administrator permission).'; items = @() } | ConvertTo-Json -Compress; exit 0 }
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-DNS-Client/Operational'; Id = 3008 } -MaxEvents $Max -ErrorAction Stop)
    $items = @($events | ForEach-Object { $x = [xml]$_.ToXml(); $d = @{}; foreach ($n in $x.Event.EventData.Data) { $d[$n.Name] = [string]$n.'#text' }; [ordered]@{ ts = $_.TimeCreated.ToString('o'); name = $d['QueryName']; type = $d['QueryType']; results = $d['QueryResults']; status = $d['QueryStatus']; pid = [int]$_.ProcessId } })
    @{ available = $true; enabled = $true; reason = $null; items = $items } | ConvertTo-Json -Depth 5 -Compress
} catch {
    @{ available = $false; enabled = $null; reason = "Could not read the DNS Client log: $($_.Exception.Message)"; items = @() } | ConvertTo-Json -Compress
}
