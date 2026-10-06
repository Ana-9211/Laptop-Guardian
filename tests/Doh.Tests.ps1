. "$PSScriptRoot\Helpers.ps1"
# DoH actions: every Windows call is mocked, so no DNS setting on this laptop is read or changed.
$root = New-TestRoot; Import-Guardian; Initialize-GuardianDirectories
Import-Module (Join-Path $script:RepoRoot 'src\powershell\Actions\Remediation.psm1') -Force -DisableNameChecking
$M = 'NetworkActions'
function Run($action, $params, $mode = 'Execute') { Invoke-GuardianRemediation -Action $action -Mode $mode -Params $params }
function First($r) { @($r.errors)[0] }

Describe 'DNS over HTTPS per interface' {
    BeforeEach {
        $global:T_Dns = @('192.168.1.1'); $global:T_Doh = @(); $global:T_Reset = 0
        $global:T_Bk = Join-Path $env:TEMP ('lg-doh-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
        Mock -ModuleName $M Test-AdminNet { $true }
        Mock -ModuleName $M Get-DohInterface { [pscustomobject]@{ InterfaceIndex = 7; ConnectionState = 'Connected' } }
        Mock -ModuleName $M Get-InterfaceDnsServers { $global:T_Dns }
        Mock -ModuleName $M Set-InterfaceDnsServers { param($Index, $Servers) $global:T_Dns = @($Servers) }
        Mock -ModuleName $M Reset-InterfaceDnsServers { $global:T_Dns = @(); $global:T_Reset++ }
        Mock -ModuleName $M Get-DohEntries { @($global:T_Doh | ForEach-Object { [pscustomobject]@{ server = $_; template = 't' } }) }
        Mock -ModuleName $M Add-DohEntry { param($Server, $Template) $global:T_Doh += $Server }
        Mock -ModuleName $M Remove-DohEntry { param($Server) $global:T_Doh = @($global:T_Doh | Where-Object { $_ -ne $Server }) }
        Mock -ModuleName $M Get-DohBackupPath { $global:T_Bk }
    }
    AfterEach { Remove-Item $global:T_Bk -ErrorAction SilentlyContinue }
    It 'needs administrator permission and a connected interface; refuses unknown providers' {
        Mock -ModuleName $M Test-AdminNet { $false }
        (Run 'dns.doh-enable' @{ provider = 'cloudflare'; interfaceIndex = '7' }).needsElevation | Should Be $true
        Mock -ModuleName $M Test-AdminNet { $true }
        Mock -ModuleName $M Get-DohInterface { [pscustomobject]@{ InterfaceIndex = 7; ConnectionState = 'Disconnected' } }
        (First (Run 'dns.doh-enable' @{ provider = 'cloudflare'; interfaceIndex = '7' })) | Should Match 'not connected'
        Mock -ModuleName $M Get-DohInterface { $null }
        (First (Run 'dns.doh-enable' @{ provider = 'cloudflare'; interfaceIndex = '7' })) | Should Match 'not found'
        (First (Run 'dns.doh-enable' @{ provider = 'evil.example'; interfaceIndex = '7' })) | Should Match 'must be one of'
        (First (Run 'dns.doh-enable' @{ provider = 'google'; interfaceIndex = '7; calc' })) | Should Match 'invalid format'
    }
    It 'enables a fixed provider: saves the old servers, registers DoH, verifies, and the undo restores exactly the old servers' {
        $r = Run 'dns.doh-enable' @{ provider = 'cloudflare'; interfaceIndex = '7' }
        $r.ok | Should Be $true; $r.verified | Should Be $true; $r.undo.action | Should Be 'dns.doh-restore'; $r.message | Should Match 'own DoH bypasses'
        ($global:T_Dns -join ',') | Should Be '1.1.1.1,1.0.1.1'.Replace('1.0.1.1', '1.0.0.1')
        ($global:T_Doh -join ',') | Should Be '1.1.1.1,1.0.0.1'
        (Get-Content $global:T_Bk -Raw | ConvertFrom-Json).servers | Should Be '192.168.1.1'
        $u = Run $r.undo.action $r.undo.params; $u.ok | Should Be $true; $u.verified | Should Be $true
        ($global:T_Dns -join ',') | Should Be '192.168.1.1'
        @($global:T_Doh).Count | Should Be 0
        Test-Path $global:T_Bk | Should Be $false
    }
    It 'does not remove DoH entries that existed before, and refuses a second enable' {
        $global:T_Doh = @('1.1.1.1')
        (Run 'dns.doh-enable' @{ provider = 'cloudflare'; interfaceIndex = '7' }).ok | Should Be $true
        (First (Run 'dns.doh-enable' @{ provider = 'cloudflare'; interfaceIndex = '7' } 'Validate')) | Should Match 'already uses'
        (Run 'dns.doh-restore' @{ interfaceIndex = '7' }).ok | Should Be $true
        ($global:T_Doh -join ',') | Should Be '1.1.1.1'
    }
    It 'restore with no saved state resets to automatic DNS; a failed change rolls the DoH entries back' {
        $global:T_Dns = @('203.0.113.9')
        $r = Run 'dns.doh-restore' @{ interfaceIndex = '7' }; $r.ok | Should Be $true; $global:T_Reset | Should Be 1; $r.message | Should Match 'automatic'
        $global:T_Dns = @('192.168.1.1'); $global:T_Doh = @()
        Mock -ModuleName $M Set-InterfaceDnsServers { throw 'Access denied' }
        (First (Run 'dns.doh-enable' @{ provider = 'quad9'; interfaceIndex = '7' })) | Should Match 'Windows refused'
        @($global:T_Doh).Count | Should Be 0
    }
    It 'reports a change Windows did not apply' {
        Mock -ModuleName $M Set-InterfaceDnsServers { }
        (First (Run 'dns.doh-enable' @{ provider = 'google'; interfaceIndex = '7' })) | Should Match 'did not report'
    }
}
Remove-TestRoot $root
