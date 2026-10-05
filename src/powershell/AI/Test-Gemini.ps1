#requires -Version 5.1
param([string]$Model = '')
. "$PSScriptRoot\..\Common\Load.ps1"
Start-RunContext -RunType 'user'
$cfg = Get-GuardianConfig
if (-not $Model) { $Model = $cfg.ai.model }
$r = Test-GeminiConnection -Model $Model
[void](Write-GuardianEvent -Category ai -Action 'ai:connection-test' -Actor user -Result $(if ($r.ok) { 'success' } else { 'failure' }) -Reason $r.message)
$r | Add-Member -NotePropertyName success -NotePropertyValue $r.ok -PassThru | ConvertTo-Json -Compress
