#requires -Version 5.1
# Windows Filtering Platform events from the Security log (needs "firewall connection logging", setup.enable-firewall-audit, and administrator
# rights to read). 5156 allowed connection, 5157 blocked connection, 5152 dropped packet, 5158 allowed bind. Read-only; no packet contents exist in these events.
Set-StrictMode -Version 2.0
$script:WfpMeaning = @{ 5156 = 'allowed'; 5157 = 'blocked'; 5152 = 'dropped'; 5158 = 'bind-allowed' }

function Convert-WfpEventXml {
    <# One event's XML text to a flat row. Locale independent: fields are read by their data names, direction by its message id. #>
    param([Parameter(Mandatory)][string]$Xml)
    $x = [xml]$Xml
    $ns = New-Object System.Xml.XmlNamespaceManager($x.NameTable); $ns.AddNamespace('e', 'http://schemas.microsoft.com/win/2004/08/events/event')
    $id = [int]$x.SelectSingleNode('//e:EventID', $ns).InnerText
    if (-not $script:WfpMeaning.ContainsKey($id)) { return $null }
    $d = @{}; foreach ($n in $x.SelectNodes('//e:EventData/e:Data', $ns)) { $d[[string]$n.GetAttribute('Name')] = [string]$n.InnerText }
    $t = $x.SelectSingleNode('//e:TimeCreated', $ns).GetAttribute('SystemTime')
    $dir = switch ([string]$d['Direction']) { '%%14593' { 'outbound' } '%%14592' { 'inbound' } default { '' } }
    $proto = switch ([string]$d['Protocol']) { '6' { 'TCP' } '17' { 'UDP' } '1' { 'ICMP' } default { [string]$d['Protocol'] } }
    [ordered]@{
        ts = ([datetime]::Parse($t, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)).ToLocalTime().ToString('yyyy-MM-ddTHH:mm:sszzz')
        eventId = $id; result = $script:WfpMeaning[$id]; direction = $dir; protocol = $proto
        pid = $(if ($d.ContainsKey('ProcessID')) { [int]$d['ProcessID'] } else { $(if ($d.ContainsKey('ProcessId')) { [int]$d['ProcessId'] } else { 0 }) })
        application = [string]$d['Application']
        localAddress = [string]$d['SourceAddress']; localPort = $(if ($d['SourcePort']) { [int]$d['SourcePort'] } else { 0 })
        remoteAddress = [string]$d['DestAddress']; remotePort = $(if ($d['DestPort']) { [int]$d['DestPort'] } else { 0 })
    }
}

function Read-WfpEventLog { param([int]$Max, [datetime]$Since) Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 5156, 5157, 5152, 5158; StartTime = $Since } -MaxEvents $Max -ErrorAction Stop }

function Get-WfpEvents {
    param([int]$Max = 500, [int]$Hours = 24)
    $Max = [math]::Max(1, [math]::Min(2000, $Max))
    try { $ev = @(Read-WfpEventLog -Max $Max -Since (Get-Date).AddHours(-[math]::Max(1, [math]::Min(168, $Hours)))) }
    catch {
        $m = $_.Exception.Message
        $why = if ($m -match 'No events were found') { $null } elseif ($m -match 'unauthorized|Attempted to perform an unauthorized|access') { 'Reading the Security log needs administrator rights.' } else { $m }
        if ($why) { return [pscustomobject]@{ available = $false; reason = $why; items = @() } }
        return [pscustomobject]@{ available = $true; reason = 'Logging is on but no connection events were recorded in this period (or logging is off: use "Turn on firewall connection logging").'; items = @() }
    }
    $rows = New-Object System.Collections.ArrayList
    foreach ($e in $ev) { try { $r = Convert-WfpEventXml -Xml $e.ToXml(); if ($r) { [void]$rows.Add($r) } } catch { } }
    [pscustomobject]@{ available = $true; reason = $null; items = @($rows) }
}
Export-ModuleMember -Function Convert-WfpEventXml, Get-WfpEvents
