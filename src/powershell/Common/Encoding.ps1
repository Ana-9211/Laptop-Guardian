# Dot-sourced first thing by Common\Load.ps1 (so by every script the bridge starts).
# Everything the bridge reads from a script is UTF-8. Windows PowerShell 5.1 would otherwise write the console code page (for example
# 437 or 850) into the pipe, and the bridge would show any non-ASCII task name, process name or path as replacement characters.
# Best effort: a process without a console cannot change it, and then the output stays as it was.
try {
    $guardianUtf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $guardianUtf8
    [Console]::InputEncoding = $guardianUtf8
    $OutputEncoding = $guardianUtf8
} catch { }
