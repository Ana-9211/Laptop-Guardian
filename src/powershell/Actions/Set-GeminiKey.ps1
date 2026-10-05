#requires -Version 5.1
# Stores/removes/reports the Gemini API key. Key is read from STDIN (never from the command line, so it cannot appear in process listings).
param([switch]$Remove, [switch]$Status)
. "$PSScriptRoot\..\Common\Load.ps1"
Start-RunContext -RunType 'user'
try {
    if ($Status) { (@{ ok = $true; success = $true; configured = [bool](Test-GeminiKeyConfigured) } | ConvertTo-Json -Compress); exit 0 }
    if ($Remove) { Remove-GeminiKey; (@{ ok = $true; success = $true; configured = $false } | ConvertTo-Json -Compress); exit 0 }
    $key = [Console]::In.ReadToEnd().Trim()
    Save-GeminiKey -Key $key
    (@{ ok = $true; success = $true; configured = $true } | ConvertTo-Json -Compress)
} catch { (@{ ok = $false; success = $false; message = $_.Exception.Message; error = $_.Exception.Message } | ConvertTo-Json -Compress); exit 1 }
