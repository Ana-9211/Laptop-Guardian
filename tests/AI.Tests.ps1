. "$PSScriptRoot\Helpers.ps1"
$root = New-TestRoot; Import-Guardian; Initialize-GuardianDirectories
$port = 18999
$modeFile = Join-Path $root 'mode.txt'
$env:GUARDIAN_TEST = '1'
$env:GUARDIAN_GEMINI_BASE = "http://127.0.0.1:$port/v1beta"
$job = Start-MockGemini -Port $port -ModeFile $modeFile
$cfg = Get-GuardianConfig; $cfg.ai.enabled = $true
$fakeKey = 'FAKE-TEST-VALUE-ONLY'

function New-Rec {
    $p = New-FakeProcess -Name 'bigapp' -Mem 4000 -Flags @('high-memory') -PathClass 'other' -Path 'D:\Apps\bigapp.exe'
    $r = @(New-ProcessRecommendations -Processes @($p) -Config (Get-GuardianConfig))[0]
    $r.title = 'bigapp'; return @{ Rec = $r; Proc = $p }
}

Describe 'Gemini key storage' {
    It 'is not configured initially' { Test-GeminiKeyConfigured | Should Be $false; Get-GeminiKey | Should BeNullOrEmpty }
    It 'rejects malformed keys' { { Save-GeminiKey -Key 'short' } | Should Throw; { Save-GeminiKey -Key "abc def ghi jkl mno pqr stu vwx" } | Should Throw }
    It 'stores the key DPAPI-encrypted, never in plain text, and round-trips' {
        Save-GeminiKey -Key $fakeKey
        Test-GeminiKeyConfigured | Should Be $true
        (Get-Content (Get-GuardianPath 'GeminiKey') -Raw) | Should Not Match 'FAKEKEY'
        Get-GeminiKey | Should Be $fakeKey
    }
    It 'never writes the key into logs or the action log' {
        $all = (Get-Content (Get-GuardianPath 'Actions') -Raw -ErrorAction SilentlyContinue) + (Get-ChildItem (Get-GuardianPath 'Logs') -File -ErrorAction SilentlyContinue | Get-Content -Raw)
        $all | Should Not Match 'FAKEKEY'
    }
}

Describe 'Privacy scrubbing' {
    It 'removes user profile, user name, secrets and long tokens' {
        $t = Protect-Text "$env:USERPROFILE\app.exe --token=abcd1234 --password hunter2 sk-0123456789abcdef0123456789abcdef0123456789"
        $t | Should Not Match ([regex]::Escape($env:USERNAME))
        $t | Should Not Match 'hunter2'
        $t | Should Not Match '0123456789abcdef0123456789abcdef'
    }
    It 'evidence sent to AI contains no command-line arguments or file contents' {
        $x = New-Rec; $x.Proc.commandLine = 'app.exe --mode=diagnostic C:\Users\TestUser\secret.docx'
        $e = New-ProcessEvidence -Rec $x.Rec -Proc $x.Proc | ConvertTo-Json -Depth 5
        $e | Should Not Match 'diagnostic'
        $e | Should Not Match 'secret\.docx'
    }
}

Describe 'AI analysis against a mock Gemini' {
    It 'connection test succeeds' { Set-Content $modeFile 'ok'; (Test-GeminiConnection).ok | Should Be $true }
    It 'returns a validated analysis' {
        Set-Content $modeFile 'ok'; $x = New-Rec
        $a = Invoke-AiProcessAnalysis -Rec $x.Rec -Proc $x.Proc -Config $cfg
        $a | Should Not BeNullOrEmpty
        $a.validated | Should Be $true
        $a.risk | Should Be 'LOW'
        $a.confidence | Should Be 0.8
        @(Test-JsonSchema -Value ($a | ConvertTo-Json | ConvertFrom-Json) -Schema (Get-Schema 'ai-analysis')).Count | Should Be 0
    }
    It 'rejects malformed JSON, logs the failure, and returns null' {
        Set-Content $modeFile 'malformed'; $x = New-Rec
        (Invoke-AiProcessAnalysis -Rec $x.Rec -Proc $x.Proc -Config $cfg) | Should BeNullOrEmpty
        (Read-JsonLines (Get-GuardianPath 'Actions') | Where-Object { $_.action -eq 'ai:analysis-failed' }) | Should Not BeNullOrEmpty
    }
    It 'rejects an invalid enum value from the model' { Set-Content $modeFile 'badenum'; $x = New-Rec; (Invoke-AiProcessAnalysis -Rec $x.Rec -Proc $x.Proc -Config $cfg) | Should BeNullOrEmpty }
    It 'rejects a response with missing fields' { Set-Content $modeFile 'missing'; $x = New-Rec; (Invoke-AiProcessAnalysis -Rec $x.Rec -Proc $x.Proc -Config $cfg) | Should BeNullOrEmpty }
    It 'strips a dangerous command the model tries to smuggle in' {
        Set-Content $modeFile 'danger'; $x = New-Rec
        $a = Invoke-AiProcessAnalysis -Rec $x.Rec -Proc $x.Proc -Config $cfg
        $a.temporary_stop_method | Should Be ''
        ($a | ConvertTo-Json) | Should Not Match 'Remove-Item'
    }
    It 'degrades gracefully on HTTP 500 (returns null, no throw)' { Set-Content $modeFile 'http500'; $x = New-Rec; { Invoke-AiProcessAnalysis -Rec $x.Rec -Proc $x.Proc -Config $cfg } | Should Not Throw; (Invoke-AiProcessAnalysis -Rec $x.Rec -Proc $x.Proc -Config $cfg) | Should BeNullOrEmpty }
    It 'records usage rows' { @(Read-JsonLines (Get-GuardianPath 'AiUsage')).Count | Should BeGreaterThan 3 }
    It 'does nothing when AI is disabled' { $off = Get-GuardianConfig; $off.ai.enabled = $false; $x = New-Rec; (Invoke-AiProcessAnalysis -Rec $x.Rec -Proc $x.Proc -Config $off) | Should BeNullOrEmpty }
    It 'enrichment respects maxProcessesPerRun and stores analysis only on recs' {
        Set-Content $modeFile 'ok'
        $recs = 1..5 | ForEach-Object { $x = New-Rec; $x.Rec.id = "rec$_".PadRight(12, '0'); $x.Rec }
        $c = Get-GuardianConfig; $c.ai.enabled = $true; $c.ai.maxProcessesPerRun = 2
        $stat = Invoke-AiRecommendationEnrichment -Recommendations $recs -Processes @() -Config $c
        $stat.requests | Should Be 2
        @($recs | Where-Object { $_.ai }).Count | Should Be 2
    }
    It 'respects the daily token budget' {
        $c = Get-GuardianConfig; $c.ai.enabled = $true; $c.ai.dailyTokenBudget = 1
        $x = New-Rec; (Invoke-AiRecommendationEnrichment -Recommendations @($x.Rec) -Processes @() -Config $c).requests | Should Be 0
    }
}

Describe 'Weekly AI briefing' {
    It 'keeps only evidence-backed patterns and strips dangerous recommendations' {
        Set-Content $modeFile 'briefing'
        $c = Get-GuardianConfig; $c.ai.enabled = $true
        $r = Invoke-AiWeeklyBriefing -Facts ([ordered]@{ a = 1 }) -Config $c
        $r.used | Should Be $true
        $r.briefing | Should Be 'All fine.'
        @($r.patterns).Count | Should Be 1
        @($r.recommendations).Count | Should Be 1
        $r.recommendations[0] | Should Not Match 'Remove-Item'
    }
}

Describe 'Gemini unavailable' {
    It 'no network / closed port: returns null quickly without throwing' {
        Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
        $x = New-Rec
        $sw = [Diagnostics.Stopwatch]::StartNew()
        { Invoke-AiProcessAnalysis -Rec $x.Rec -Proc $x.Proc -Config $cfg } | Should Not Throw
        (Invoke-AiProcessAnalysis -Rec $x.Rec -Proc $x.Proc -Config $cfg) | Should BeNullOrEmpty
        (Test-GeminiConnection).ok | Should Be $false
    }
    It 'no API key: analysis skipped, enrichment reports reason' {
        Remove-GeminiKey
        $x = New-Rec
        $stat = Invoke-AiRecommendationEnrichment -Recommendations @($x.Rec) -Processes @() -Config $cfg
        $stat.used | Should Be $false
        $stat.skipped | Should Be 'No API key'
        (Test-GeminiConnection).message | Should Match 'No API key'
    }
}
Remove-Item Env:\GUARDIAN_GEMINI_BASE -ErrorAction SilentlyContinue
Get-Job | Stop-Job -PassThru | Remove-Job -Force -ErrorAction SilentlyContinue
Remove-TestRoot $root
