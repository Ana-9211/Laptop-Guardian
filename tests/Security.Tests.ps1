. "$PSScriptRoot\Helpers.ps1"
$root = New-TestRoot; Import-Guardian

Describe 'Process kill protection' {
    It 'refuses a genuine Windows process by name (even with an unreadable path)' { (Test-ProcessKillAllowed -Name 'lsass.exe' -Path "$env:SystemRoot\System32\lsass.exe" -ProcessId 1000).Allowed | Should Be $false }
    It 'treats a Windows-named copy outside the Windows folder and without a Microsoft signature as a suspicious lookalike' {
        Mock -ModuleName Security Get-ImageTrust { [pscustomobject]@{ valid = $false; microsoft = $false } }
        $r = Test-ProcessKillAllowed -Name 'lsass.exe' -Path 'C:\x\lsass.exe' -ProcessId 1000
        $r.Allowed | Should Be $true; $r.Suspicious | Should Be $true; $r.Reason | Should Match 'not signed by Microsoft'
    }
    It 'still protects a Windows-named binary outside the Windows folder when it IS Microsoft-signed' {
        Mock -ModuleName Security Get-ImageTrust { [pscustomobject]@{ valid = $true; microsoft = $true } }
        (Test-ProcessKillAllowed -Name 'svchost.exe' -Path 'C:\x\svchost.exe' -ProcessId 1000).Allowed | Should Be $false
    }
    It 'does not treat C:\WindowsFake as the Windows directory' {
        (Test-UnderSystemRoot "$($env:SystemRoot)Fake\thing.exe") | Should Be $false
        (Test-UnderSystemRoot "$env:SystemRoot\thing.exe") | Should Be $true
    }
    It 'expands 8.3 short names so a protected folder cannot be spelled around' {
        $short = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:ProgramFiles).ShortPath
        if ($short -and $short -ne $env:ProgramFiles) { (Test-ProtectedPath -Path "$short\Vendor\x.dll") | Should Be $true } else { (Test-ProtectedPath -Path "$env:ProgramFiles\Vendor\x.dll") | Should Be $true }
    }
    It 'protects other users profiles and the Users folder, but not the current profile' {
        (Test-ProtectedPath -Path "$env:SystemDrive\Users\SomeoneElse\Documents\a.txt") | Should Be $true
        (Test-ProtectedPath -Path "$env:SystemDrive\Users") | Should Be $true
        (Test-ProtectedPath -Path "$env:USERPROFILE\Documents\a.txt") | Should Be $false
    }
    It 'keeps development tools on the name-based list' { (Test-ProcessKillAllowed -Name 'node.exe' -Path 'C:\Users\x\node.exe' -ProcessId 1000).Allowed | Should Be $false }
    It 'refuses explorer' { (Test-ProcessKillAllowed -Name 'explorer' -Path '' -ProcessId 1000).Allowed | Should Be $false }
    It 'refuses svchost' { (Test-ProcessKillAllowed -Name 'svchost' -Path '' -ProcessId 1000).Allowed | Should Be $false }
    It 'refuses anything under the Windows dir' { (Test-ProcessKillAllowed -Name 'whatever' -Path "$env:SystemRoot\System32\whatever.exe" -ProcessId 1000).Allowed | Should Be $false }
    It 'refuses reserved PIDs' { (Test-ProcessKillAllowed -Name 'x' -Path '' -ProcessId 4).Allowed | Should Be $false }
    It 'refuses its own PID' { (Test-ProcessKillAllowed -Name 'x' -Path '' -ProcessId $PID).Allowed | Should Be $false }
    It 'allows an ordinary third-party app' { (Test-ProcessKillAllowed -Name 'sometool' -Path 'C:\Users\x\AppData\Local\sometool\sometool.exe' -ProcessId 4242).Allowed | Should Be $true }
}

Describe 'Path protection' {
    It 'protects Windows dir' { Test-ProtectedPath "$env:SystemRoot\System32\drivers\etc\hosts" | Should Be $true }
    It 'protects Program Files' { Test-ProtectedPath "${env:ProgramFiles}\App\a.dll" | Should Be $true }
    It 'protects drive root, profile root and empty path' {
        Test-ProtectedPath 'C:\' | Should Be $true
        Test-ProtectedPath $env:USERPROFILE | Should Be $true
        Test-ProtectedPath '' | Should Be $true
    }
    It 'does not protect an ordinary user file' { Test-ProtectedPath "$env:USERPROFILE\Downloads\old.zip" | Should Be $false }
    It 'honours user-protected directories' { Test-ProtectedPath "$env:USERPROFILE\Documents\Thesis\a.docx" -ExtraProtected @("$env:USERPROFILE\Documents\Thesis") | Should Be $true }
    It 'refuses to recycle a protected file' { { Move-ToRecycleBin -Path "$env:SystemRoot\notepad.exe" } | Should Throw }
    It 'refuses to recycle a directory' {
        $d = Join-Path $root 'adir'; New-Item -ItemType Directory $d | Out-Null
        { Move-ToRecycleBin -Path $d } | Should Throw
    }
}

Describe 'Command allowlist' {
    $good = @('Stop-Process -Id 1234', 'Stop-Service -Name VendorSvc', 'Set-Service -Name Foo -StartupType Disabled', "Disable-ScheduledTask -TaskName 'My Task' -TaskPath '\Vendor\'", 'Start-Process ms-settings:startupapps', 'taskkill /PID 99 /F')
    foreach ($c in $good) { It "accepts: $c" { Test-CommandAllowed $c | Should Be $true } }
    $bad = @('Stop-Process -Id 1; calc', 'Remove-Item C:\ -Recurse -Force', 'Stop-Process -Name x | Out-Null', 'Invoke-Expression "x"', 'Stop-Process -Id $(whoami)', "Stop-Process -Id 1`nRemove-Item x", 'powershell -enc AAAA', 'Stop-Process -Id 12 && del *', 'cmd /c format c:', ('Stop-Process -Name ' + 'cs' + 'rss -Force'), 'taskkill /PID 4 /F', ('Stop-Service -Name ' + 'Win' + 'Defend'), "Remove-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\Foo' -Name 'Start'", '')
    foreach ($c in $bad) { It "rejects: $($c -replace "`n",'\n')" { Test-CommandAllowed $c | Should Be $false } }
}

Describe 'AI response validation' {
    $goodJson = '{"classification":"known-application","what_is_it":"x","why_flagged":"y","risk":"low","persistence":"none","suggested_action":"review","temporary_stop_method":"Stop-Process -Id 5","persistence_removal_method":"","consequences":"c","confidence":0.7,"evidence":["a"],"warnings":[]}'
    It 'accepts a valid response and normalises enums' {
        $v = Test-AiAnalysis ($goodJson | ConvertFrom-Json)
        $v.Valid | Should Be $true
        $v.Value.risk | Should Be 'LOW'
        $v.Value.suggested_action | Should Be 'Review'
        $v.Value.temporary_stop_method | Should Be 'Stop-Process -Id 5'
    }
    It 'validated output conforms to the schema' {
        $v = Test-AiAnalysis ($goodJson | ConvertFrom-Json)
        @(Test-JsonSchema -Value $v.Value -Schema (Get-Schema 'ai-analysis')).Count | Should Be 0
    }
    It 'rejects a response missing required fields' { (Test-AiAnalysis ('{"classification":"x"}' | ConvertFrom-Json)).Valid | Should Be $false }
    It 'rejects an invalid risk value' { $b = $goodJson | ConvertFrom-Json; $b.risk = 'CATASTROPHIC'; (Test-AiAnalysis $b).Valid | Should Be $false }
    It 'rejects an unknown suggested_action' { $b = $goodJson | ConvertFrom-Json; $b.suggested_action = 'Format disk'; (Test-AiAnalysis $b).Valid | Should Be $false }
    It 'rejects out-of-range confidence' { $b = $goodJson | ConvertFrom-Json; $b.confidence = 7000; (Test-AiAnalysis $b).Valid | Should Be $false }
    It 'rejects non-object input' { (Test-AiAnalysis 'hello').Valid | Should Be $false; (Test-AiAnalysis $null).Valid | Should Be $false }
    It 'strips a dangerous command suggested by the AI and warns' {
        $b = $goodJson | ConvertFrom-Json; $b.temporary_stop_method = 'Stop-Process -Id 1; Remove-Item C:\ -Recurse'
        $v = Test-AiAnalysis $b
        $v.Valid | Should Be $true
        $v.Value.temporary_stop_method | Should Be ''
        @($v.Value.warnings).Count | Should BeGreaterThan 0
    }
    It 'strips markup from text fields' { $b = $goodJson | ConvertFrom-Json; $b.what_is_it = 'ok <script>alert(1)</script>'; (Test-AiAnalysis $b).Value.what_is_it | Should Not Match '<script>' }
}
Remove-TestRoot $root
