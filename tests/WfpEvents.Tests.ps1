. "$PSScriptRoot\Helpers.ps1"
Import-Module (Join-Path $script:RepoRoot 'src\powershell\Network\WfpEvents.psm1') -Force -DisableNameChecking
function New-WfpXml($id, $dir, $proto, $app, $procId) {
    "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><EventID>$id</EventID><TimeCreated SystemTime='2026-10-07T08:15:30.1234567Z'/></System><EventData><Data Name='ProcessID'>$procId</Data><Data Name='Application'>$app</Data><Data Name='Direction'>$dir</Data><Data Name='SourceAddress'>192.168.1.20</Data><Data Name='SourcePort'>50123</Data><Data Name='DestAddress'>203.0.113.9</Data><Data Name='DestPort'>443</Data><Data Name='Protocol'>$proto</Data></EventData></Event>"
}
Describe 'WFP events (5156 5157 5152 5158)' {
    It 'parses an allowed outbound TCP connection by field name' {
        $r = Convert-WfpEventXml -Xml (New-WfpXml 5156 '%%14593' 6 '\device\harddiskvolume3\tools\app.exe' 4321)
        $r.result | Should Be 'allowed'; $r.direction | Should Be 'outbound'; $r.protocol | Should Be 'TCP'; $r.pid | Should Be 4321
        $r.remoteAddress | Should Be '203.0.113.9'; $r.remotePort | Should Be 443; $r.localPort | Should Be 50123
        $r.application | Should Match 'app.exe'
    }
    It 'maps blocked, dropped and bind events, inbound direction and UDP' {
        (Convert-WfpEventXml -Xml (New-WfpXml 5157 '%%14592' 17 'System' 4)).result | Should Be 'blocked'
        $d = Convert-WfpEventXml -Xml (New-WfpXml 5152 '%%14592' 17 'System' 4); $d.result | Should Be 'dropped'; $d.direction | Should Be 'inbound'; $d.protocol | Should Be 'UDP'
        (Convert-WfpEventXml -Xml (New-WfpXml 5158 '%%14593' 6 'x' 1)).result | Should Be 'bind-allowed'
    }
    It 'ignores other event ids' { Convert-WfpEventXml -Xml (New-WfpXml 4624 '' 6 'x' 1) | Should BeNullOrEmpty }
    It 'reports a clear reason when the Security log cannot be read, and an empty list when there are no events' {
        Mock -ModuleName WfpEvents Read-WfpEventLog { throw 'Attempted to perform an unauthorized operation.' }
        $r = Get-WfpEvents; $r.available | Should Be $false; $r.reason | Should Match 'administrator'
        Mock -ModuleName WfpEvents Read-WfpEventLog { throw 'No events were found that match the specified selection criteria.' }
        $r2 = Get-WfpEvents; $r2.available | Should Be $true; @($r2.items).Count | Should Be 0
    }
    It 'turns log entries into rows' {
        $global:T_Xml = New-WfpXml 5157 '%%14593' 6 'a' 9
        Mock -ModuleName WfpEvents Read-WfpEventLog { $o = New-Object psobject; $o | Add-Member ScriptMethod ToXml { $global:T_Xml }; @($o) }
        $r = Get-WfpEvents; @($r.items).Count | Should Be 1; $r.items[0].result | Should Be 'blocked'
    }
}
