. "$PSScriptRoot\Helpers.ps1"
# Firewall, DNS and collector tests. EVERY Windows touchpoint is mocked or pointed at a temp file: no real firewall rule is
# created, changed or deleted, no hosts file is edited, no packets are captured, no event log is changed.
$root = New-TestRoot; Import-Guardian; Initialize-GuardianDirectories
Import-Module (Join-Path $script:RepoRoot 'src\powershell\Actions\Remediation.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:RepoRoot 'src\powershell\Actions\NetworkActions.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:RepoRoot 'src\powershell\Network\Guard.psm1') -Force -DisableNameChecking
$M = 'NetworkActions'
function Run($action, $params, $mode = 'Execute') { Invoke-GuardianRemediation -Action $action -Mode $mode -Params $params }
function First($r) { @($r.errors)[0] }
$prog = Join-Path $env:TEMP ('lg-net-' + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.exe'); Set-Content $prog 'x'
$script:Rules = @()

Describe 'Network catalog entries' {
    $cat = Get-ActionCatalog
    It 'contains the firewall, DNS and deep-log actions with fixed patterns and no command parameters' {
        foreach ($id in 'firewall.block-program', 'firewall.allow-program', 'firewall.block-port', 'firewall.block-remote', 'firewall.remove-rule', 'firewall.disable-rule', 'firewall.enable-rule', 'dns.block-domain', 'dns.unblock-domain', 'dns.rollback', 'deep.dnslog-enable', 'deep.dnslog-disable') { (Get-ActionSpec -Id $id) | Should Not BeNullOrEmpty }
        'LG-1759662400-abc123' | Should Match $cat.patterns.ruleName
        'Block-Everything' | Should Not Match $cat.patterns.ruleName
        '../x' | Should Not Match $cat.patterns.domain
    }
    It 'every network action with an undo points at an existing action' {
        foreach ($a in @($cat.actions | Where-Object { $_.id -match '^(firewall|dns|deep)\.' -and $_.PSObject.Properties.Name -contains 'undoId' })) { (Get-ActionSpec -Id $a.undoId) | Should Not BeNullOrEmpty }
    }
}

Describe 'Target validation' {
    It 'refuses protected, missing and non-exe programs' {
        (Test-ProgramTarget "$env:SystemRoot\System32\svchost.exe") | Should Match 'Protected'
        (Test-ProgramTarget "$env:SystemRoot\notepad.exe") | Should Match 'Protected'
        (Test-ProgramTarget 'C:\Program Files\Windows Defender\MsMpEng.exe') | Should Match 'Protected|does not exist'
        (Test-ProgramTarget 'C:\nowhere\missing.exe') | Should Match 'does not exist'
        (Test-ProgramTarget 'C:\Users\u\file.txt') | Should Match 'Only .exe'
        $env:GUARDIAN_ROOT = $root; $own = Join-Path $root 'tool.exe'; Set-Content $own 'x'
        (Test-ProgramTarget $own) | Should Match 'Guardian'
        (Test-ProgramTarget $prog) | Should BeNullOrEmpty
    }
    It 'refuses dangerous remote addresses and ranges' {
        Mock -ModuleName $M Get-NetworkIdentity { @('192.168.1.1', '1.1.1.1') }
        foreach ($bad in 'not-an-ip', '127.0.0.1', '0.0.0.0', '224.0.0.1', '169.254.1.1', '10.0.0.0/4', '0.0.0.0/0', '::1', 'fe80::1', '8.8.8.8/7', '192.168.1.0/24', '1.1.1.1', '192.168.1.1') { (Test-RemoteTarget $bad) | Should Not BeNullOrEmpty }
        foreach ($good in '203.0.113.7', '198.51.100.0/24', '2001:db8::1', '10.20.30.40') { (Test-RemoteTarget $good) | Should BeNullOrEmpty }
    }
    It 'refuses DNS, DHCP and out-of-range ports' {
        foreach ($p in 0, 53, 67, 68, 546, 547, 70000, -1) { (Test-PortTarget $p) | Should Not BeNullOrEmpty }
        (Test-PortTarget 3389) | Should BeNullOrEmpty
    }
    It 'refuses invalid, wildcard, IP and protected domains' {
        foreach ($d in '*.example.org', 'ads.example.org/path', '1.2.3.4', 'localhost', 'bad domain.com', 'a.b', 'www.microsoft.com', 'update.windowsupdate.com', 'login.live.com', 'x.digicert.com') { (Test-DomainTarget $d) | Should Not BeNullOrEmpty }
        (Test-DomainTarget 'tracker.adnetwork.net') | Should BeNullOrEmpty
    }
}

Describe 'Firewall rules: ownership and lifecycle (all mocked)' {
    function Set-Fw {
        $script:Rules = @()
        Mock -ModuleName $M Test-AdminNet { $true }
        Mock -ModuleName $M Get-NetworkIdentity { @() }
        Mock -ModuleName $M Get-GuardianFwRules { @($global:T_Rules | Where-Object { $_.DisplayGroup -eq 'Laptop Guardian' -and $_.Name -like 'LG-*' }) }
        Mock -ModuleName $M Get-FwRuleByName { param($Name) $global:T_Rules | Where-Object { $_.Name -eq $Name } | Select-Object -First 1 }
        Mock -ModuleName $M Get-FwRuleDetail { param($Rule) [pscustomobject]@{ program = [string]$Rule.Program; protocol = [string]$Rule.Protocol; localPort = [string]$Rule.LocalPort; remoteAddress = [string]$Rule.RemoteAddress } }
        Mock -ModuleName $M New-FwRule { param($Spec) $global:T_Created += , $Spec; $global:T_Rules += [pscustomobject]@{ Name = $Spec.Name; DisplayName = $Spec.DisplayName; DisplayGroup = $Spec.Group; Enabled = 'True'; Direction = $Spec.Direction; Action = $Spec.Action; Program = $Spec['Program']; Protocol = $Spec['Protocol']; LocalPort = $Spec['LocalPort']; RemoteAddress = $Spec['RemoteAddress']; Description = $Spec.Description } }
        Mock -ModuleName $M Remove-FwRule { param($Name) $global:T_Removed += $Name; $global:T_Rules = @($global:T_Rules | Where-Object { $_.Name -ne $Name }) }
        Mock -ModuleName $M Set-FwRuleEnabled { param($Name, $Enabled) foreach ($r in $global:T_Rules) { if ($r.Name -eq $Name) { $r.Enabled = $(if ($Enabled) { 'True' } else { 'False' }) } } }
        Mock -ModuleName $M Save-RuleRegistry { }; Mock -ModuleName $M Read-RuleRegistry { @() }
    }
    It 'block-program creates one Laptop Guardian rule, verifies it, records expiry and offers removal as undo' {
        $global:T_Rules = @(); $global:T_Created = @(); . Set-Fw
        $r = Run 'firewall.block-program' @{ path = $prog; direction = 'Outbound'; duration = '24h' }
        ($r.errors -join '; ') | Should BeNullOrEmpty
        $r.ok | Should Be $true; $r.verified | Should Be $true
        @($global:T_Created).Count | Should Be 1
        $s = $global:T_Created[0]
        $s.Group | Should Be 'Laptop Guardian'; $s.Name | Should Match '^LG-\d+-[0-9a-f]{6}$'; $s.Action | Should Be 'Block'; $s.Direction | Should Be 'Outbound'; $s.Program | Should Be $prog; $s.Description | Should Match 'Review or remove after'
        $r.undo.action | Should Be 'firewall.remove-rule'; $r.undo.params.name | Should Be $s.Name
    }
    It 'allow-program never applies to public networks, refuses temp/Downloads paths and warns about user-writable folders' {
        $global:T_Rules = @(); $global:T_Created = @(); . Set-Fw
        $dir = Join-Path $env:LOCALAPPDATA ('lg-allow-' + [guid]::NewGuid().ToString('N').Substring(0, 6)); New-Item -ItemType Directory -Path $dir | Out-Null
        $exe = Join-Path $dir 'tool.exe'; Set-Content $exe 'x'
        try {
            $v = Run 'firewall.allow-program' @{ path = $exe; direction = 'Inbound' } 'Validate'
            (@($v.warnings) -join ' ') | Should Match 'folder your account can change'
            $ok = Run 'firewall.allow-program' @{ path = $exe; direction = 'Inbound' }
            ($ok.errors -join '; ') | Should BeNullOrEmpty
            (@($global:T_Created[0].Profile) -join ',') | Should Be 'Private,Domain'
            (First (Run 'firewall.allow-program' @{ path = $prog; direction = 'Inbound' })) | Should Match 'temporary or Downloads'
        } finally { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It 'refuses an identical rule, a protected program and rules beyond the cap' {
        $global:T_Rules = @(); $global:T_Created = @(); . Set-Fw
        $r0 = Run 'firewall.block-program' @{ path = $prog; direction = 'Outbound' }; ($r0.errors -join '; ') | Should BeNullOrEmpty
        (First (Run 'firewall.block-program' @{ path = $prog; direction = 'Outbound' })) | Should Match 'identical'
        (First (Run 'firewall.block-program' @{ path = "$env:SystemRoot\System32\svchost.exe"; direction = 'Outbound' })) | Should Match 'Protected'
        $global:T_Rules = @(1..200 | ForEach-Object { [pscustomobject]@{ Name = "LG-1000000-$('{0:x6}' -f $_)"; DisplayGroup = 'Laptop Guardian'; Enabled = 'True'; Direction = 'Outbound'; Action = 'Block'; Program = "C:\x\$_.exe"; Protocol = ''; LocalPort = ''; RemoteAddress = '' } })
        (First (Run 'firewall.block-port' @{ port = 4444; protocol = 'TCP' })) | Should Match 'limit'
    }
    It 'port and remote rules are inbound-port / outbound-address only and verify after creation' {
        $global:T_Rules = @(); $global:T_Created = @(); . Set-Fw
        $r1 = Run 'firewall.block-port' @{ port = 4444; protocol = 'TCP' }; ($r1.errors -join '; ') | Should BeNullOrEmpty
        $global:T_Created[0].Direction | Should Be 'Inbound'; $global:T_Created[0].LocalPort | Should Be '4444'
        (Run 'firewall.block-remote' @{ remote = '203.0.113.9' }).ok | Should Be $true
        $global:T_Created[1].Direction | Should Be 'Outbound'; $global:T_Created[1].RemoteAddress | Should Be '203.0.113.9'
        (First (Run 'firewall.block-port' @{ port = 53; protocol = 'UDP' })) | Should Match 'DNS or DHCP'
        (First (Run 'firewall.block-remote' @{ remote = '0.0.0.0/0' })) | Should Match 'too broad|unspecified'
    }
    It 'needs elevation instead of creating a rule when not administrator' {
        $global:T_Rules = @(); $global:T_Created = @(); . Set-Fw; Mock -ModuleName $M Test-AdminNet { $false }
        $r = Run 'firewall.block-program' @{ path = $prog; direction = 'Outbound' }; $r.ok | Should Be $false; $r.needsElevation | Should Be $true
        @($global:T_Created).Count | Should Be 0
    }
    It 'fails honestly when the rule is not present after creation' {
        $global:T_Rules = @(); $global:T_Created = @(); . Set-Fw; Mock -ModuleName $M New-FwRule { }
        $r = Run 'firewall.block-program' @{ path = $prog; direction = 'Outbound' }; $r.ok | Should Be $false; (First $r) | Should Match 'not found in Windows Firewall'
    }
    It 'NEVER removes, disables or enables a rule that Laptop Guardian did not create' {
        $global:T_Removed = @(); . Set-Fw
        $global:T_Rules = @(
            [pscustomobject]@{ Name = 'LG-1000000-abcdef'; DisplayGroup = 'Laptop Guardian'; Enabled = 'True'; DisplayName = 'ours' },
            [pscustomobject]@{ Name = 'LG-1000001-abcdef'; DisplayGroup = 'Windows Defender Firewall'; Enabled = 'True'; DisplayName = 'impostor: right name, wrong group' },
            [pscustomobject]@{ Name = 'LG-1000002-abcdef'; DisplayGroup = ''; Enabled = 'True'; DisplayName = 'no group' },
            [pscustomobject]@{ Name = 'CoreNet-DNS-Out-UDP'; DisplayGroup = 'Core Networking'; Enabled = 'True'; DisplayName = 'Windows' })
        foreach ($n in 'LG-1000001-abcdef', 'LG-1000002-abcdef') { foreach ($a in 'firewall.remove-rule', 'firewall.disable-rule') { (First (Run $a @{ name = $n })) | Should Match 'not created by Laptop Guardian' } }
        (Run 'firewall.remove-rule' @{ name = 'CoreNet-DNS-Out-UDP' }).ok | Should Be $false
        (First (Run 'firewall.remove-rule' @{ name = 'CoreNet-DNS-Out-UDP' })) | Should Match 'invalid format'
        (First (Run 'firewall.remove-rule' @{ name = 'LG-9999999-abcdef' })) | Should Match 'no firewall rule'
        @($global:T_Removed).Count | Should Be 0
        (Run 'firewall.disable-rule' @{ name = 'LG-1000000-abcdef' }).verified | Should Be $true
        (First (Run 'firewall.disable-rule' @{ name = 'LG-1000000-abcdef' })) | Should Match 'already disabled'
        $e = Run 'firewall.enable-rule' @{ name = 'LG-1000000-abcdef' }; $e.ok | Should Be $true; $e.undo.action | Should Be 'firewall.disable-rule'
        (Run 'firewall.remove-rule' @{ name = 'LG-1000000-abcdef' }).verified | Should Be $true
        @($global:T_Removed) | Should Be 'LG-1000000-abcdef'
    }
    It 'cmdlets that create or delete rules appear only inside the guarded wrappers' {
        $src = Get-Content (Join-Path $script:RepoRoot 'src\powershell\Actions\NetworkActions.psm1') -Raw
        ([regex]::Matches($src, 'New-NetFirewallRule')).Count | Should Be 1
        ([regex]::Matches($src, 'Remove-NetFirewallRule')).Count | Should Be 1
        $src | Should Not Match 'Set-NetFirewallProfile|netsh|Disable-NetFirewallRule -All|Remove-NetFirewallRule -All|-Enabled False|Set-MpPreference|Add-MpPreference'
        $src | Should Not Match 'pktmon|netsh trace|New-NetEventSession|Add-NetEventPacketCaptureProvider'
    }
}

Describe 'DNS hosts-file blocking (temp files only)' {
    $dir = Join-Path $env:TEMP ('lg-hosts-' + [guid]::NewGuid().ToString('N').Substring(0, 6)); New-Item -ItemType Directory -Path $dir | Out-Null
    function New-Hosts($text) { $f = Join-Path $dir ([guid]::NewGuid().ToString('N').Substring(0, 6) + '.hosts'); [IO.File]::WriteAllText($f, $text); return $f }
    $original = "# Copyright (c) Microsoft`r`n127.0.0.1 localhost`r`n::1 localhost`r`n# custom entry`r`n10.0.0.5 nas.home`r`n"
    It 'adds a block without touching anything else, keeping the original line endings, and backs the file up' {
        $f = New-Hosts $original; $bk = Join-Path $dir 'bk'
        $r = Update-GuardianHostsBlockFile -Path $f -Add @('Tracker.Adnetwork.net') -BackupDir $bk
        @($r) | Should Be 'tracker.adnetwork.net'
        $t = [IO.File]::ReadAllText($f)
        $t.StartsWith($original) | Should Be $true
        $t | Should Match '0\.0\.0\.0 tracker\.adnetwork\.net'; $t | Should Match 'BEGIN LAPTOP GUARDIAN DNS BLOCKS'; $t | Should Match 'END LAPTOP GUARDIAN DNS BLOCKS'
        ($t -split "`r`n").Count | Should BeGreaterThan 5; $t | Should Not Match "(?<!`r)`n"
        [IO.File]::ReadAllText((Join-Path $bk 'hosts.original')) | Should Be $original
    }
    It 'keeps user entries outside the block byte-for-byte when blocks change, and is idempotent' {
        $f = New-Hosts "127.0.0.1 localhost`n10.0.0.5 nas.home`n"
        [void](Update-GuardianHostsBlockFile -Path $f -Add @('a.example.org', 'b.example.org'))
        [void](Update-GuardianHostsBlockFile -Path $f -Add @('a.example.org'))
        @(Get-HostsDomains -Path $f) | Should Be @('a.example.org', 'b.example.org')
        [void](Update-GuardianHostsBlockFile -Path $f -Remove @('a.example.org'))
        @(Get-HostsDomains -Path $f) | Should Be @('b.example.org')
        $t = [IO.File]::ReadAllText($f); $t.StartsWith("127.0.0.1 localhost`n10.0.0.5 nas.home`n") | Should Be $true
    }
    It 'rollback removes the whole block and restores the original text exactly' {
        $f = New-Hosts $original
        [void](Update-GuardianHostsBlockFile -Path $f -Add @('a.example.org', 'b.example.org'))
        [void](Update-GuardianHostsBlockFile -Path $f -RemoveAll)
        [IO.File]::ReadAllText($f) | Should Be $original
        @(Get-HostsDomains -Path $f).Count | Should Be 0
    }
    It 'refuses to edit a file whose markers are unbalanced, and never edits outside the managed block' {
        $f = New-Hosts "127.0.0.1 localhost`n# BEGIN LAPTOP GUARDIAN DNS BLOCKS (managed by Laptop Guardian; remove them from the dashboard)`n0.0.0.0 x.example.org`n"
        { Update-GuardianHostsBlockFile -Path $f -Add @('y.example.org') } | Should Throw
        [IO.File]::ReadAllText($f) | Should Match 'x\.example\.org'
        $f2 = New-Hosts "0.0.0.0 user-blocked.example.org`n"
        [void](Update-GuardianHostsBlockFile -Path $f2 -RemoveAll); [IO.File]::ReadAllText($f2) | Should Be "0.0.0.0 user-blocked.example.org`n"
    }
    It 'actions: filtering must be enabled first, then block/verify/undo and rollback work through the hosts wrapper' {
        $f = New-Hosts $original
        Mock -ModuleName $M Get-HostsFilePath { $global:T_Hosts }; $global:T_Hosts = $f
        $global:T_Bk = Join-Path $dir 'bk2'; Mock -ModuleName $M Get-HostsBackupDir { $global:T_Bk }; Mock -ModuleName $M Test-AdminNet { $true }
        Mock -ModuleName $M Test-DnsFilteringEnabled { $false }
        (First (Run 'dns.block-domain' @{ domain = 'tracker.adnetwork.net' })) | Should Match 'filtering is off'
        Mock -ModuleName $M Test-DnsFilteringEnabled { $true }
        (First (Run 'dns.block-domain' @{ domain = 'www.microsoft.com' })) | Should Match 'Protected'
        $r = Run 'dns.block-domain' @{ domain = 'tracker.adnetwork.net' }; ($r.errors -join '; ') | Should BeNullOrEmpty; $r.ok | Should Be $true; $r.verified | Should Be $true; $r.undo.action | Should Be 'dns.unblock-domain'
        $r.message | Should Match 'DoH'
        (First (Run 'dns.block-domain' @{ domain = 'tracker.adnetwork.net' })) | Should Match 'already blocked'
        (Run 'dns.unblock-domain' @{ domain = 'tracker.adnetwork.net' }).verified | Should Be $true
        (First (Run 'dns.rollback' @{})) | Should Match 'no DNS blocks'
        (Run 'dns.block-domain' @{ domain = 'a.example.org' }).ok | Should Be $true
        (Run 'dns.rollback' @{}).verified | Should Be $true
        [IO.File]::ReadAllText($f) | Should Be $original
    }
    It 'needs elevation to edit the real hosts file' { $global:T_Hosts = New-Hosts $original; Mock -ModuleName $M Test-AdminNet { $false }; Mock -ModuleName $M Test-DnsFilteringEnabled { $true }; Mock -ModuleName $M Get-HostsFilePath { $global:T_Hosts }; (Run 'dns.block-domain' @{ domain = 'a.example.org' }).needsElevation | Should Be $true }
    It 'the real hosts path is only ever used through Get-HostsFilePath' {
        $src = Get-Content (Join-Path $script:RepoRoot 'src\powershell\Actions\NetworkActions.psm1') -Raw
        ([regex]::Matches($src, 'drivers\\etc\\hosts')).Count | Should Be 1
    }
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'DNS opt-in flag is read from the saved config file' {
    It 'is off by default and on only when the file says so (Get-GuardianConfig would drop the key)' {
        $f = Join-Path $env:TEMP ('lg-flag-' + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.hosts'); [IO.File]::WriteAllText($f, "127.0.0.1 localhost`n"); $global:T_Hosts2 = $f
        Mock -ModuleName $M Test-AdminNet { $true }; Mock -ModuleName $M Get-HostsFilePath { $global:T_Hosts2 }; Mock -ModuleName $M Get-HostsBackupDir { $env:TEMP }
        Write-JsonFile -Path (Get-GuardianPath 'Config') -Object @{ schedule = @{ } }
        (First (Run 'dns.block-domain' @{ domain = 'tracker.adnetwork.net' })) | Should Match 'filtering is off'
        Write-JsonFile -Path (Get-GuardianPath 'Config') -Object @{ network = @{ dnsFiltering = @{ enabled = $false } } }
        (First (Run 'dns.block-domain' @{ domain = 'tracker.adnetwork.net' })) | Should Match 'filtering is off'
        Write-JsonFile -Path (Get-GuardianPath 'Config') -Object @{ network = @{ dnsFiltering = @{ enabled = $true } } }
        $r = Run 'dns.block-domain' @{ domain = 'tracker.adnetwork.net' }; ($r.errors -join '; ') | Should BeNullOrEmpty; $r.verified | Should Be $true
        Remove-Item $f -Force -ErrorAction SilentlyContinue
    }
}

Describe 'Windows DNS Client log (deep mode helper)' {
    It 'enables and disables the log only through the wrapper, verifies, and offers the opposite as undo' {
        $global:T_Log = $false
        Mock -ModuleName $M Test-AdminNet { $true }; Mock -ModuleName $M Get-DnsLogState { $global:T_Log }; Mock -ModuleName $M Set-DnsLogState { param($Enabled) $global:T_Log = $Enabled }
        $e = Run 'deep.dnslog-enable' @{}; $e.ok | Should Be $true; $e.verified | Should Be $true; $e.undo.action | Should Be 'deep.dnslog-disable'
        (First (Run 'deep.dnslog-enable' @{})) | Should Match 'already on'
        (Run 'deep.dnslog-disable' @{}).verified | Should Be $true
        Mock -ModuleName $M Test-AdminNet { $false }; (Run 'deep.dnslog-enable' @{}).needsElevation | Should Be $true
    }
}

Describe 'Collector (mocked): standard visibility only' {
    It 'builds a bounded snapshot from the connection tables, with process identity and signatures' {
        Mock -ModuleName Guard Get-TcpTable { @([pscustomobject]@{ State = 'Established'; LocalAddress = '192.168.1.5'; LocalPort = 50000; RemoteAddress = '203.0.113.5'; RemotePort = 443; OwningProcess = 42; CreationTime = (Get-Date) }, [pscustomobject]@{ State = 'Listen'; LocalAddress = '0.0.0.0'; LocalPort = 3389; RemoteAddress = '0.0.0.0'; RemotePort = 0; OwningProcess = 42; CreationTime = $null }) }
        Mock -ModuleName Guard Get-UdpTable { @([pscustomobject]@{ LocalAddress = '0.0.0.0'; LocalPort = 5353; OwningProcess = 42 }) }
        Mock -ModuleName Guard Get-ProcessTable { @([pscustomobject]@{ ProcessId = 42; Name = 'thing.exe'; ExecutablePath = 'C:\Tools\thing.exe' }) }
        Mock -ModuleName Guard Get-FileSignatureInfo { [pscustomobject]@{ status = 'NotSigned'; publisher = $null } }
        Mock -ModuleName Guard Get-ProcessOwnerName { 'LAPTOP\someone' }
        Mock -ModuleName Guard Get-DnsCacheTable { @([pscustomobject]@{ Entry = 'example.org'; Type = 1; Data = '203.0.113.5'; TimeToLive = 60 }) }
        Mock -ModuleName Guard Get-FirewallProfileTable { @([pscustomobject]@{ Name = 'Public'; Enabled = 'True'; DefaultInboundAction = 'Block'; DefaultOutboundAction = 'Allow' }) }
        Mock -ModuleName Guard Get-GuardianRuleTable { @() }
        Mock -ModuleName Guard Get-NetworkIdentityTable { [pscustomobject]@{ gateway = @('192.168.1.1'); dns = @('1.1.1.1'); dhcp = @() } }
        $s = Get-NetworkSnapshot
        @($s.connections).Count | Should Be 2; @($s.udp).Count | Should Be 1
        $s.processes['42'].name | Should Be 'thing'; $s.processes['42'].signed | Should Be $false; $s.processes['42'].owner | Should Be 'LAPTOP\someone'
        $s.connections[0].remoteAddress | Should Be '203.0.113.5'; $s.connections[1].remoteAddress | Should Be ''
        $s.firewall.profiles[0].enabled | Should Be $true; $s.identity.gateway | Should Be '192.168.1.1'; $s.mode | Should Be 'standard'
    }
    It 'contains no packet capture, tracing, setting changes or network access' {
        $src = (Get-Content (Join-Path $script:RepoRoot 'src\powershell\Network\Guard.psm1') -Raw) + (Get-Content (Join-Path $script:RepoRoot 'src\powershell\Network\Get-NetworkSnapshot.ps1') -Raw)
        $src | Should Not Match 'pktmon|netsh|New-NetEventSession|Start-NetEventSession|wevtutil|Invoke-WebRequest|Invoke-RestMethod|Test-NetConnection|Resolve-DnsName|New-NetFirewall|Remove-NetFirewall|Set-NetFirewall|Enable-NetFirewall|Disable-NetFirewall|Start-Process|\bping\b'
    }
}
Remove-Item $prog -Force -ErrorAction SilentlyContinue
Remove-TestRoot $root
