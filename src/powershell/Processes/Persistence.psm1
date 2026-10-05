#requires -Version 5.1
# Persistence: startup entries (registry/folders), scheduled tasks, services. Used by Startup/Services reports and process recommendations.
Set-StrictMode -Version 2.0

function Get-StartupEntries {
    $items = New-Object System.Collections.ArrayList
    $regKeys = @(
        @{ P = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'; S = 'HKCU' },
        @{ P = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'; S = 'HKLM' },
        @{ P = 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'; S = 'HKLM-32' },
        @{ P = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'; S = 'HKCU' }
    )
    foreach ($k in $regKeys) {
        try {
            if (-not (Test-Path -LiteralPath $k.P)) { continue }
            $props = Get-ItemProperty -LiteralPath $k.P -ErrorAction Stop
            foreach ($pr in $props.PSObject.Properties) {
                if ($pr.Name -like 'PS*') { continue }
                [void]$items.Add([pscustomobject]@{ kind = 'registry'; name = $pr.Name; location = $k.P; command = [string]$pr.Value; publisher = $null })
            }
        } catch { }
    }
    $folders = @(
        [Environment]::GetFolderPath('Startup'),
        [Environment]::GetFolderPath('CommonStartup')
    ) | Where-Object { $_ }
    foreach ($f in $folders) {
        try {
            if (-not (Test-Path -LiteralPath $f)) { continue }
            foreach ($file in Get-ChildItem -LiteralPath $f -File -Force -ErrorAction SilentlyContinue) {
                if ($file.Name -ieq 'desktop.ini') { continue }
                $target = $file.FullName
                if ($file.Extension -ieq '.lnk') {
                    try { $sh = New-Object -ComObject WScript.Shell; $target = $sh.CreateShortcut($file.FullName).TargetPath } catch { }
                }
                [void]$items.Add([pscustomobject]@{ kind = 'folder'; name = $file.BaseName; location = $f; command = $target; publisher = $null })
            }
        } catch { }
    }
    return @($items)
}

function Get-ScheduledTaskEntries {
    # Third-party/user-relevant tasks that run at logon/boot or are enabled with an exec action. Microsoft tasks are summarised only.
    $items = New-Object System.Collections.ArrayList
    try {
        $tasks = Get-ScheduledTask -ErrorAction Stop
        foreach ($t in $tasks) {
            if ($t.TaskPath -like '\Microsoft\Windows\*') { continue }
            if ($t.TaskPath -like '\LaptopGuardian*') { continue }
            $exec = @($t.Actions | Where-Object { (Get-PropNames $_) -contains 'Execute' -and $_.Execute })
            $trig = @($t.Triggers | ForEach-Object { $_.CimClass.CimClassName -replace '^MSFT_Task', '' -replace 'Trigger$', '' })
            foreach ($a in $exec) {
                [void]$items.Add([pscustomobject]@{
                        name = $t.TaskName; path = $t.TaskPath; state = [string]$t.State; enabled = ($t.State -ne 'Disabled')
                        execute = [string]$a.Execute; arguments = [string]$a.Arguments; triggers = @($trig); atLogonOrBoot = [bool](@($trig) -match 'Logon|Boot')
                    })
            }
        }
    } catch { }
    return @($items)
}

function Get-ServiceEntries {
    $items = New-Object System.Collections.ArrayList
    try {
        foreach ($s in (Get-CimInstance Win32_Service -ErrorAction Stop)) {
            $exe = $null
            if ($s.PathName) {
                if ($s.PathName -match '^\s*"([^"]+)"') { $exe = $Matches[1] }
                elseif ($s.PathName -match '^\s*(\S+\.exe)') { $exe = $Matches[1] }
                else { $exe = ($s.PathName -split ' ')[0] }
            }
            [void]$items.Add([pscustomobject]@{
                    name = $s.Name; display = $s.DisplayName; state = $s.State; startMode = $s.StartMode; processId = [int]$s.ProcessId
                    path = $exe; pathName = $s.PathName; account = $s.StartName; exitCode = $s.ExitCode
                })
        }
    } catch { }
    return @($items)
}

function Resolve-CommandExecutable {
    param([string]$Command)
    if ([string]::IsNullOrWhiteSpace($Command)) { return $null }
    $c = [Environment]::ExpandEnvironmentVariables($Command.Trim())
    if ($c -match '^"([^"]+)"') { return $Matches[1] }
    if ($c -match '^(.+?\.(exe|bat|cmd|lnk|com))(\s|$)') { return $Matches[1] }
    return ($c -split '\s+')[0]
}

Export-ModuleMember -Function *
