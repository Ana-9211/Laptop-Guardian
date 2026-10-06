. "$PSScriptRoot\Helpers.ps1"
$root = New-TestRoot; Import-Guardian; Initialize-GuardianDirectories
$cfgOn = [pscustomobject]@{ safety = [pscustomobject]@{ safeMode = $false; automationPaused = $false; autoKillBlacklisted = $true } }

$victimExe = Join-Path $root 'guardianvictim.exe'; Copy-Item "$env:SystemRoot\System32\PING.EXE" $victimExe
function New-Victim { Start-Process -FilePath $victimExe -ArgumentList '-n 120 127.0.0.1' -WindowStyle Hidden -PassThru }
function New-Snapshot($proc, $policy) { $p = New-FakeProcess -Name 'guardianvictim' -ProcId $proc.Id -Path $victimExe -PathClass 'other' -Policy $policy; $p }

Describe 'Blacklist / whitelist / ignored policy' {
    It 'starts empty' { $p = Get-ProcessPolicy; @($p.blacklist).Count | Should Be 0; @($p.whitelist).Count | Should Be 0 }
    It 'adds a blacklist entry that terminates by default' {
        $e = Add-PolicyEntry -List blacklist -Name 'BadApp.exe' -Reason 'eats RAM'
        $e.name | Should Be 'badapp'
        $e.action | Should Be 'terminate'
        $e.enabled | Should Be $true
        @((Get-ProcessPolicy).blacklist).Count | Should Be 1
    }
    It 'is idempotent' { Add-PolicyEntry -List blacklist -Name 'badapp' | Out-Null; @((Get-ProcessPolicy).blacklist).Count | Should Be 1 }
    It 'rejects dangerous names' { { Add-PolicyEntry -List blacklist -Name 'a;b' } | Should Throw; { Add-PolicyEntry -List blacklist -Name '..\x' } | Should Throw }
    It 'matches case-insensitively and ignores .exe' { (Find-PolicyMatch -Policy (Get-ProcessPolicy) -Name 'BADAPP.EXE' -Path 'C:\x').list | Should Be 'blacklist' }
    It 'does not match other names' { (Find-PolicyMatch -Policy (Get-ProcessPolicy) -Name 'goodapp' -Path 'C:\x').list | Should Be 'none' }
    It 'whitelist wins over blacklist' {
        Add-PolicyEntry -List whitelist -Name 'badapp' | Out-Null
        (Find-PolicyMatch -Policy (Get-ProcessPolicy) -Name 'badapp' -Path 'C:\x').list | Should Be 'whitelist'
    }
    It 'path-scoped entries only match that path' {
        Add-PolicyEntry -List blacklist -Name 'scoped' -Path 'C:\a\scoped.exe' | Out-Null
        (Find-PolicyMatch -Policy (Get-ProcessPolicy) -Name 'scoped' -Path 'C:\a\scoped.exe').list | Should Be 'blacklist'
        (Find-PolicyMatch -Policy (Get-ProcessPolicy) -Name 'scoped' -Path 'C:\b\scoped.exe').list | Should Be 'none'
    }
    It 'a temporarily disabled blacklist entry does not match' {
        $pol = Get-ProcessPolicy; ($pol.blacklist | Where-Object name -eq 'scoped').disabledUntil = (Get-Date).AddDays(2).ToString('o'); Save-ProcessPolicy $pol
        (Find-PolicyMatch -Policy (Get-ProcessPolicy) -Name 'scoped' -Path 'C:\a\scoped.exe').list | Should Be 'none'
    }
    It 'removes entries' { $id = (Get-ProcessPolicy).whitelist[0].id; Remove-PolicyEntry -List whitelist -Id $id; @((Get-ProcessPolicy).whitelist).Count | Should Be 0 }
    It 'persists policy schema-valid JSON' { @(Test-JsonSchema -Value (Read-JsonFile (Get-GuardianPath 'ProcessPolicy')) -Schema (Get-Schema 'process-policy')).Count | Should Be 0 }
}

Describe 'Blacklist enforcement' {
    It 'terminates a blacklisted process when automation is enabled and records it' {
        Write-JsonFile -Path (Get-GuardianPath 'ProcessPolicy') -Object @{ blacklist = @(); whitelist = @(); ignored = @() }
        Add-PolicyEntry -List blacklist -Name 'guardianvictim' -Reason 'test' | Out-Null
        $v = New-Victim; Start-Sleep -Milliseconds 500
        try {
            $res = @(Invoke-BlacklistEnforcement -Processes @(New-Snapshot $v 'blacklist') -Config $cfgOn)
            $res.Count | Should Be 1
            $res[0].result | Should Be 'terminated'
            Start-Sleep -Milliseconds 500
            (Get-Process -Id $v.Id -ErrorAction SilentlyContinue) | Should BeNullOrEmpty
            (Get-ProcessPolicy).blacklist[0].terminatedCount | Should Be 1
        } finally { Stop-Process -Id $v.Id -Force -ErrorAction SilentlyContinue }
    }
    It 'running as administrator, a name-only blacklist entry is not enforced (the policy file is user-editable); one scoped to the exact executable is' {
        Write-JsonFile -Path (Get-GuardianPath 'ProcessPolicy') -Object @{ blacklist = @(); whitelist = @(); ignored = @() }
        Add-PolicyEntry -List blacklist -Name 'guardianvictim' -Reason 'name only' | Out-Null
        $v = New-Victim; Start-Sleep -Milliseconds 500
        try {
            Mock -ModuleName Policy Test-IsAdmin { $true }
            @(Invoke-BlacklistEnforcement -Processes @(New-Snapshot $v 'blacklist') -Config $cfgOn).Count | Should Be 0
            (Get-Process -Id $v.Id -ErrorAction SilentlyContinue) | Should Not BeNullOrEmpty
            (Read-JsonLines (Get-GuardianPath 'Actions') | Where-Object { $_.action -eq 'process:terminate-blocked' -and $_.reason -match 'exact executable' }) | Should Not BeNullOrEmpty
            Write-JsonFile -Path (Get-GuardianPath 'ProcessPolicy') -Object @{ blacklist = @(); whitelist = @(); ignored = @() }
            Add-PolicyEntry -List blacklist -Name 'guardianvictim' -Path $victimExe -Reason 'scoped' | Out-Null
            $res = @(Invoke-BlacklistEnforcement -Processes @(New-Snapshot $v 'blacklist') -Config $cfgOn)
            $res.Count | Should Be 1; $res[0].result | Should Be 'terminated'
        } finally {
            Mock -ModuleName Policy Test-IsAdmin { $false }; Stop-Process -Id $v.Id -Force -ErrorAction SilentlyContinue
            # put the policy back the way the following tests expect it (a name-only entry)
            Write-JsonFile -Path (Get-GuardianPath 'ProcessPolicy') -Object @{ blacklist = @(); whitelist = @(); ignored = @() }
            Add-PolicyEntry -List blacklist -Name 'guardianvictim' -Reason 'test' | Out-Null
        }
    }
    It 'does NOTHING in safe mode' {
        $cfg = [pscustomobject]@{ safety = [pscustomobject]@{ safeMode = $true; automationPaused = $false; autoKillBlacklisted = $true } }
        $v = New-Victim; Start-Sleep -Milliseconds 500
        try { @(Invoke-BlacklistEnforcement -Processes @(New-Snapshot $v 'blacklist') -Config $cfg).Count | Should Be 0; (Get-Process -Id $v.Id -ErrorAction SilentlyContinue) | Should Not BeNullOrEmpty }
        finally { Stop-Process -Id $v.Id -Force -ErrorAction SilentlyContinue }
    }
    It 'does NOTHING when automation is paused or auto-kill is off' {
        $v = New-Victim; Start-Sleep -Milliseconds 500
        try {
            $paused = [pscustomobject]@{ safety = [pscustomobject]@{ safeMode = $false; automationPaused = $true; autoKillBlacklisted = $true } }
            $off = [pscustomobject]@{ safety = [pscustomobject]@{ safeMode = $false; automationPaused = $false; autoKillBlacklisted = $false } }
            @(Invoke-BlacklistEnforcement -Processes @(New-Snapshot $v 'blacklist') -Config $paused).Count | Should Be 0
            @(Invoke-BlacklistEnforcement -Processes @(New-Snapshot $v 'blacklist') -Config $off).Count | Should Be 0
            (Get-Process -Id $v.Id -ErrorAction SilentlyContinue) | Should Not BeNullOrEmpty
        } finally { Stop-Process -Id $v.Id -Force -ErrorAction SilentlyContinue }
    }
    It 'never terminates an UNKNOWN (non-blacklisted) process' {
        $v = New-Victim; Start-Sleep -Milliseconds 500
        try { @(Invoke-BlacklistEnforcement -Processes @(New-Snapshot $v 'none') -Config $cfgOn).Count | Should Be 0; (Get-Process -Id $v.Id -ErrorAction SilentlyContinue) | Should Not BeNullOrEmpty }
        finally { Stop-Process -Id $v.Id -Force -ErrorAction SilentlyContinue }
    }
    It 'never terminates a protected process even if blacklisted' {
        Add-PolicyEntry -List blacklist -Name 'lsass' | Out-Null
        $p = New-FakeProcess -Name 'lsass' -ProcId 700 -Path "$env:SystemRoot\System32\lsass.exe" -Policy 'blacklist'
        @(Invoke-BlacklistEnforcement -Processes @($p) -Config $cfgOn).Count | Should Be 0
    }
    It 'handles a process that vanished before termination' {
        $v = New-Victim; Start-Sleep -Milliseconds 400; $snap = New-Snapshot $v 'blacklist'; Stop-Process -Id $v.Id -Force; Start-Sleep -Milliseconds 400
        $res = @(Invoke-BlacklistEnforcement -Processes @($snap) -Config $cfgOn)
        $res[0].result | Should Be 'failed'     # logged, no throw
    }
    It 'refuses when the PID was reused by a different executable' {
        $v = New-Victim; Start-Sleep -Milliseconds 400
        try {
            $snap = New-Snapshot $v 'blacklist'; $snap.path = 'C:\Some\Other\ping.exe'
            $res = @(Invoke-BlacklistEnforcement -Processes @($snap) -Config $cfgOn)
            $res[0].result | Should Be 'failed'
            (Get-Process -Id $v.Id -ErrorAction SilentlyContinue) | Should Not BeNullOrEmpty
        } finally { Stop-Process -Id $v.Id -Force -ErrorAction SilentlyContinue }
    }
}
Remove-TestRoot $root
