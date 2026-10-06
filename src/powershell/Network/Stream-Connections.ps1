#requires -Version 5.1
# Long-lived sampler for Deep Network Guard. Every IntervalSec it prints ONE JSON line with the TCP table (Get-NetTCPConnection), the UDP
# endpoints (Get-NetUDPEndpoint) and the names of the owning processes. Locale independent, read-only, no packet capture.
# The bridge starts it once, reads the lines, restarts it if it dies and kills it on stop. It also ends by itself when the bridge is gone.
[CmdletBinding()]
param([ValidateRange(2, 120)][int]$IntervalSec = 5, [int]$ParentPid = 0)
$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\..\Common\Load.ps1"

function Get-SampleLine {
    $rows = New-Object System.Collections.ArrayList
    foreach ($c in @(Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
        [void]$rows.Add([ordered]@{ proto = 'TCP'; localAddress = [string]$c.LocalAddress; localPort = [int]$c.LocalPort; remoteAddress = [string]$c.RemoteAddress; remotePort = [int]$c.RemotePort; state = [string]$c.State; pid = [int]$c.OwningProcess })
    }
    foreach ($u in @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue)) {
        [void]$rows.Add([ordered]@{ proto = 'UDP'; localAddress = [string]$u.LocalAddress; localPort = [int]$u.LocalPort; remoteAddress = ''; remotePort = 0; state = 'Endpoint'; pid = [int]$u.OwningProcess })
    }
    $names = [ordered]@{}
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) { $names[[string]$p.Id] = ([string]$p.ProcessName) + '.exe' }
    [ordered]@{ t = (Get-Date).ToUniversalTime().ToString('o'); rows = @($rows); names = $names } | ConvertTo-Json -Depth 5 -Compress
}

while ($true) {
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    try { [Console]::Out.WriteLine((Get-SampleLine)); [Console]::Out.Flush() } catch { [Console]::Error.WriteLine($_.Exception.Message) }
    Start-Sleep -Seconds $IntervalSec
}
