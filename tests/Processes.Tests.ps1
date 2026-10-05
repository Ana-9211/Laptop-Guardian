. "$PSScriptRoot\Helpers.ps1"
$root = New-TestRoot; Import-Guardian; Initialize-GuardianDirectories
$cfg = Get-GuardianConfig
$emptyPolicy = Get-ProcessPolicy

Describe 'Process snapshot (real system)' {
    $snap = @(Get-ProcessSnapshot -SampleMs 300)
    It 'returns many processes with required fields' {
        $snap.Count | Should BeGreaterThan 20
        $me = $snap | Where-Object { $_.pid -eq $PID } | Select-Object -First 1
        $me | Should Not BeNullOrEmpty
        $me.name | Should Match 'powershell'
        $me.memoryMB | Should BeGreaterThan 1
        $me.parentPid | Should BeGreaterThan 0
        $me.pathClass | Should Not BeNullOrEmpty
    }
    It 'classifies Windows binaries as windows' { ($snap | Where-Object { $_.name -eq 'svchost' } | Select-Object -First 1).classification | Should Be 'windows' }
    It 'survives processes appearing and disappearing during inspection' {
        $j = Start-Job { 1..40 | ForEach-Object { $p = Start-Process "$env:SystemRoot\System32\ping.exe" -ArgumentList '-n 2 127.0.0.1' -WindowStyle Hidden -PassThru; Start-Sleep -Milliseconds 30 } }
        { $null = Get-ProcessSnapshot -SampleMs 200 } | Should Not Throw
        Receive-Job $j -Wait | Out-Null; Remove-Job $j
    }
    It 'maps persistence (service / task / startup) onto matching processes' {
        $me = (Get-Process -Id $PID).Path
        $persist = [pscustomobject]@{ Services = @(); Tasks = @([pscustomobject]@{ name = 'T'; path = '\V\'; execute = $me; arguments = '' }); Startup = @([pscustomobject]@{ kind = 'registry'; name = 'S'; location = 'HKCU:\Run'; command = "`"$me`" -x" }) }
        $s = @(Get-ProcessSnapshot -SampleMs 200 -Persistence $persist) | Where-Object { $_.pid -eq $PID } | Select-Object -First 1
        $s.persistent | Should Be $true
        @($s.scheduledTasks).Count | Should Be 1
        @($s.startupEntries).Count | Should Be 1
    }
}

Describe 'Flagging' {
    It 'flags high cpu/memory, unusual location, unsigned' {
        $p = New-FakeProcess -Name 'hog' -Cpu 90 -Mem 3000 -PathClass 'temp'
        $r = Add-ProcessFlags -Processes @($p) -Config $cfg -Policy $emptyPolicy
        $f = @($r[0].flags)
        $f -contains 'high-cpu' | Should Be $true
        $f -contains 'high-memory' | Should Be $true
        $f -contains 'unusual-location' | Should Be $true
        $f -contains 'unsigned' | Should Be $true
    }
    It 'flags duplicates only for non-multiprocess apps' {
        $a = 1..4 | ForEach-Object { $x = New-FakeProcess -Name 'weirdtool' -ProcId (100 + $_) -Path 'C:\P\weird.exe' -PathClass 'program-files' -Signed $true -Publisher 'Foo'; $x.instances = 4; $x }
        $c = 1..4 | ForEach-Object { $x = New-FakeProcess -Name 'chrome' -ProcId (200 + $_) -Path 'C:\P\chrome.exe' -PathClass 'program-files' -Signed $true -Publisher 'Google'; $x.instances = 4; $x }
        (Add-ProcessFlags -Processes @($a) -Config $cfg -Policy $emptyPolicy)[0].flags -contains 'duplicate' | Should Be $true
        (Add-ProcessFlags -Processes @($c) -Config $cfg -Policy $emptyPolicy)[0].flags -contains 'duplicate' | Should Be $false
    }
}

Describe 'Recommendation engine' {
    It 'creates NO recommendation for a quiet signed known app' {
        $p = New-FakeProcess -Name 'quiet' -Path 'C:\Program Files\Q\q.exe' -PathClass 'program-files' -Signed $true -Publisher 'Microsoft Corporation' -Classification 'known-app' -Persistent $true -Flags @('persistent')
        @(New-ProcessRecommendations -Processes @($p) -Config $cfg).Count | Should Be 0
    }
    It 'never recommends for Windows components or whitelisted processes' {
        $w = New-FakeProcess -Name 'wintool' -Classification 'windows' -Cpu 99 -Flags @('high-cpu')
        $l = New-FakeProcess -Name 'mine' -Cpu 99 -Flags @('high-cpu', 'whitelisted') -Policy 'whitelist'
        @(New-ProcessRecommendations -Processes @($w, $l) -Config $cfg).Count | Should Be 0
    }
    It 'does not call an unfamiliar process malicious; unknown + one weak signal stays UNKNOWN/LOW' {
        $p = New-FakeProcess -Name 'mystery' -Path 'D:\Stuff\mystery.exe' -PathClass 'other' -Cpu 70 -Classification 'unknown' -Flags @('high-cpu')
        $r = @(New-ProcessRecommendations -Processes @($p) -Config $cfg)
        $r.Count | Should Be 1
        $r[0].risk | Should Not Be 'HIGH'
        $r[0].confidence | Should BeLessThan 0.95
        $r[0].whatIsIt | Should Match 'Unfamiliar does not mean malicious|no curated|Unrecognised'
    }
    It 'unsigned persistent binary in Temp: MEDIUM risk, severity high, investigate' {
        $p = New-FakeProcess -Name 'dropper' -Path 'C:\Users\x\AppData\Local\Temp\d.exe' -PathClass 'temp' -Flags @('unusual-location', 'unsigned', 'persistent') -Persistent $true -Startup @([pscustomobject]@{ kind = 'registry'; name = 'd'; location = 'HKCU:\Run'; command = 'x' })
        $r = @(New-ProcessRecommendations -Processes @($p) -Config $cfg)[0]
        $r.risk | Should Be 'MEDIUM'
        $r.severity | Should Be 'high'
        $r.suggestedAction | Should Be 'Investigate further'
        @($r.persistence.mechanisms).Count | Should Be 1
    }
    It 'blacklisted process produces a Stop temporarily recommendation with LOW risk' {
        $p = New-FakeProcess -Name 'bad' -Flags @('blacklisted') -Policy 'blacklist' -Classification 'third-party' -Signed $true -Publisher 'X' -PathClass 'program-files'
        $r = @(New-ProcessRecommendations -Processes @($p) -Config $cfg)[0]
        $r.suggestedAction | Should Be 'Stop temporarily'
        $r.risk | Should Be 'LOW'
    }
    It 'persistent service gets a verified prevent-restart command; all displayed commands pass the allowlist' {
        $p = New-FakeProcess -Name 'svcapp' -PathClass 'program-files' -Signed $true -Publisher 'V' -Classification 'third-party' -Mem 3000 -Flags @('high-memory', 'persistent') -Persistent $true -Services @('VendorSvc')
        $r = @(New-ProcessRecommendations -Processes @($p) -Config $cfg)[0]
        $r.preventRestart.command | Should Be 'Set-Service -Name VendorSvc -StartupType Disabled'
        $r.preventRestart.requiresAdmin | Should Be $true
        $r.preventRestart.reversible | Should Be $true
        Test-CommandAllowed $r.stopCommand.command | Should Be $true
        Test-CommandAllowed $r.preventRestart.command | Should Be $true
    }
    It 'recommendations validate against the schema' {
        $p = New-FakeProcess -Name 'hog' -Cpu 90 -Mem 3000 -PathClass 'other' -Flags @('high-cpu', 'high-memory')
        $r = @(New-ProcessRecommendations -Processes @($p) -Config $cfg)[0]
        @(Test-JsonSchema -Value ($r | ConvertTo-Json -Depth 8 | ConvertFrom-Json) -Schema (Get-Schema 'recommendation')).Count | Should Be 0
    }
    It 'groups instances into one recommendation' {
        $ps = 1..5 | ForEach-Object { $x = New-FakeProcess -Name 'multi' -ProcId (300 + $_) -Path 'C:\P\m.exe' -PathClass 'program-files' -Signed $true -Publisher 'V' -Classification 'third-party' -Mem 900 -Flags @('high-memory'); $x }
        @(New-ProcessRecommendations -Processes $ps -Config $cfg).Count | Should Be 1
    }
}

Describe 'Recommendation store' {
    It 'tracks recurrence and preserves user decisions' {
        $r = Add-RecommendationItem -Kind 'system' -Key 'k1' -Title 'T' -WhatIsIt 'w' -Why @('x')
        [void](Update-RecommendationStore -Fresh @($r))
        $store = Get-RecommendationStore; $store[0].status = 'dismissed'; $store[0].lastSeen = (Get-Date).AddDays(-1).ToString('o'); $store[0].occurrences = 1; Save-RecommendationStore $store
        $again = Add-RecommendationItem -Kind 'system' -Key 'k1' -Title 'T' -WhatIsIt 'w' -Why @('x')
        $merged = @(Update-RecommendationStore -Fresh @($again))
        $merged[0].status | Should Be 'dismissed'
        $merged[0].occurrences | Should Be 2
        $merged[0].consecutiveDays | Should Be 2
    }
    It 'auto-resolves open recommendations not seen for 3+ days' {
        $store = @(Get-RecommendationStore); $store += (Add-RecommendationItem -Kind 'system' -Key 'stale' -Title 'S' -WhatIsIt 'w' -Why @('x'))
        $store[-1].lastSeen = (Get-Date).AddDays(-5).ToString('o'); Save-RecommendationStore $store
        $m = @(Update-RecommendationStore -Fresh @() -SweepKinds @('system'))
        ($m | Where-Object { $_.title -eq 'S' }).status | Should Be 'resolved'
    }
}
Remove-TestRoot $root
