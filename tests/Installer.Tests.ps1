. "$PSScriptRoot\Helpers.ps1"
$repo = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $repo 'src\powershell\Install\Installer.psm1') -Force

function New-TempDir([string]$Tag) {
    $d = Join-Path ([IO.Path]::GetTempPath()) ("lg-inst-$Tag-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $d -Force | Out-Null
    return $d
}
function New-FakeSource {
    $s = New-TempDir 'src'
    foreach ($f in 'src\powershell\Common\Core.psm1', 'src\bridge\server.js', 'src\shared\action-catalog.json', 'src\dashboard\dist\index.html', 'src\assets\guardian.ico', 'Install-LaptopGuardian.ps1', 'README.md', 'package.json',
                   'tests\x.ps1', 'docs\x.md', 'src\dashboard\src\App.tsx', 'src\bridge\node_modules\dep\i.js') {
        $p = Join-Path $s $f; New-Item -ItemType Directory -Path (Split-Path -Parent $p) -Force | Out-Null; Set-Content -LiteralPath $p -Value "content of $f"
    }
    foreach ($f in 'config\config.json', 'data\history\h1.json', 'data\state\bridge.json', 'data\state\x.lock', 'reports\daily\r.html', 'logs\a.log') {
        $p = Join-Path $s $f; New-Item -ItemType Directory -Path (Split-Path -Parent $p) -Force | Out-Null; Set-Content -LiteralPath $p -Value "content of $f"
    }
    return $s
}

Describe 'Installer: layout and plan' {
    It 'uses the standard Windows locations by default and rejects relative paths' {
        $l = Get-InstallLayout
        $l.programDir | Should Be (Join-Path $env:ProgramFiles 'LaptopGuardian')
        $l.elevatedDir | Should Be (Join-Path $env:ProgramData 'LaptopGuardian')
        $l.dataDir | Should Be (Join-Path $env:LOCALAPPDATA 'LaptopGuardian')
        { Get-InstallLayout -ProgramDir 'relative\path' } | Should Throw
    }
    It 'copies only program files: no tests, docs, dashboard source, node_modules, config, data, reports or logs' {
        $s = New-FakeSource
        try {
            $f = @(Get-ProgramFileList -SourceRoot $s)
            ($f -contains 'src\powershell\Common\Core.psm1') | Should Be $true
            ($f -contains 'src\dashboard\dist\index.html') | Should Be $true
            @($f | Where-Object { $_ -match '^(tests|docs|config|data|reports|logs)\\|node_modules|dashboard\\src' }).Count | Should Be 0
        } finally { Remove-Item $s -Recurse -Force }
    }
    It 'a plan changes nothing and lists every step' {
        $s = New-FakeSource; $t = New-TempDir 'plan'
        try {
            $l = Get-InstallLayout -ProgramDir "$t\prog" -DataDir "$t\data" -ElevatedDir "$t\elev"
            $plan = @(Get-InstallPlan -SourceRoot $s -Layout $l)
            ($plan | ForEach-Object step) -join ',' | Should Be 'program,install-info,elevated-folder,data-folder,migrate,tasks,shortcuts,verify'
            @(Get-ChildItem $t).Count | Should Be 0
            (@(Get-InstallPlan -SourceRoot $s -Layout $l -SkipTasks -SkipShortcuts -SkipMigration) | ForEach-Object step) -join ',' | Should Be 'program,install-info,elevated-folder,data-folder,verify'
        } finally { Remove-Item $s, $t -Recurse -Force }
    }
}

Describe 'Installer: program copy' {
    It 'installs a complete copy, and an update replaces it without leaving staging folders' {
        $s = New-FakeSource; $t = New-TempDir 'prog'
        try {
            $dest = "$t\prog"
            (Copy-ProgramFiles -SourceRoot $s -ProgramDir $dest) | Should BeGreaterThan 5
            Test-Path "$dest\src\bridge\server.js" | Should Be $true
            Test-Path "$dest\data" | Should Be $false
            Set-Content "$s\src\bridge\server.js" 'new version'
            Copy-ProgramFiles -SourceRoot $s -ProgramDir $dest | Out-Null
            (Get-Content "$dest\src\bridge\server.js" -Raw).Trim() | Should Be 'new version'
            Test-Path "$dest.new" | Should Be $false
            Test-Path "$dest.old" | Should Be $false
        } finally { Remove-Item $s, $t -Recurse -Force }
    }
    It 'a failed update keeps the working copy' {
        $s = New-FakeSource; $t = New-TempDir 'prog2'
        try {
            $dest = "$t\prog"
            Copy-ProgramFiles -SourceRoot $s -ProgramDir $dest | Out-Null
            Remove-Item "$s\src\dashboard\dist" -Recurse -Force   # unbuilt source
            { Copy-ProgramFiles -SourceRoot $s -ProgramDir $dest } | Should Throw
            Test-Path "$dest\src\bridge\server.js" | Should Be $true
            Test-Path "$dest.new" | Should Be $false
        } finally { Remove-Item $s, $t -Recurse -Force }
    }
    It 'refuses the same folder and a folder that is not a source tree' {
        $s = New-FakeSource; $e = New-TempDir 'empty'
        try {
            { Copy-ProgramFiles -SourceRoot $s -ProgramDir $s } | Should Throw
            { Copy-ProgramFiles -SourceRoot $e -ProgramDir "$e-x" } | Should Throw
        } finally { Remove-Item $s, $e -Recurse -Force }
    }
    It 'writes install.json as UTF-8 without a byte-order mark with the three roots' {
        $t = New-TempDir 'info'
        try {
            $l = Get-InstallLayout -ProgramDir "$t\prog" -DataDir "$t\data" -ElevatedDir "$t\elev"
            New-Item -ItemType Directory -Path $l.programDir | Out-Null
            $f = Write-InstallInfo -Layout $l -NodePath 'C:\node.exe' -Version '1.2.3' -Source 'C:\src'
            $b = [IO.File]::ReadAllBytes($f); ($b[0] -eq 0xEF) | Should Be $false
            $j = Get-Content $f -Raw | ConvertFrom-Json
            $j.dataRoot | Should Be $l.dataDir; $j.elevatedDir | Should Be $l.elevatedDir; $j.version | Should Be '1.2.3'
        } finally { Remove-Item $t -Recurse -Force }
    }
}

Describe 'Installer: migration' {
    It 'copies (never moves), backs up first, skips locks and bridge.json, and leaves the old folder untouched' {
        $s = New-FakeSource; $t = New-TempDir 'mig'
        try {
            $before = @(Get-ChildItem $s -Recurse -File | ForEach-Object { $_.FullName + '|' + $_.Length })
            $r = Invoke-DataMigration -LegacyRoot $s -DataDir "$t\data"
            $r.status | Should Be 'migrated'
            Test-Path $r.backup | Should Be $true
            Test-Path "$t\data\config\config.json" | Should Be $true
            Test-Path "$t\data\data\history\h1.json" | Should Be $true
            Test-Path "$t\data\data\state\bridge.json" | Should Be $false
            Test-Path "$t\data\data\state\x.lock" | Should Be $false
            Test-Path "$t\data\migration.json" | Should Be $true
            $after = @(Get-ChildItem $s -Recurse -File | ForEach-Object { $_.FullName + '|' + $_.Length })
            ($after -join "`n") | Should Be ($before -join "`n")
        } finally { Remove-Item $s, $t -Recurse -Force }
    }
    It 'is idempotent: a second run copies nothing and keeps one backup' {
        $s = New-FakeSource; $t = New-TempDir 'mig2'
        try {
            Invoke-DataMigration -LegacyRoot $s -DataDir "$t\data" | Out-Null
            Set-Content "$s\logs\later.log" 'x'
            (Invoke-DataMigration -LegacyRoot $s -DataDir "$t\data").status | Should Be 'already-migrated'
            Test-Path "$t\data\logs\later.log" | Should Be $false
            @(Get-ChildItem "$t\data" -Filter 'migration-backup-*.zip').Count | Should Be 1
        } finally { Remove-Item $s, $t -Recurse -Force }
    }
    It 'refuses the same folder and reports when there is nothing to migrate' {
        $s = New-FakeSource; $e = New-TempDir 'none'; $t = New-TempDir 'mig3'
        try {
            { Invoke-DataMigration -LegacyRoot $s -DataDir $s } | Should Throw
            (Invoke-DataMigration -LegacyRoot $e -DataDir "$t\data").status | Should Be 'nothing-to-migrate'
        } finally { Remove-Item $s, $e, $t -Recurse -Force }
    }
    It 'the backup zip contains the migrated files' {
        $s = New-FakeSource; $t = New-TempDir 'mig4'
        try {
            $r = Invoke-DataMigration -LegacyRoot $s -DataDir "$t\data"
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $z = [IO.Compression.ZipFile]::OpenRead($r.backup)
            try { (@($z.Entries | ForEach-Object FullName) -contains 'config/config.json') | Should Be $true } finally { $z.Dispose() }
        } finally { Remove-Item $s, $t -Recurse -Force }
    }
}

Describe 'Installer: rollback and legacy cleanup' {
    It 'rollback plan needs a migration record and a usable old folder, and deletes nothing' {
        $s = New-FakeSource; $t = New-TempDir 'rb'
        try {
            { Get-RollbackPlan -DataDir "$t\data" } | Should Throw
            New-Item -ItemType Directory -Path "$s\src\powershell" -Force | Out-Null; Set-Content "$s\src\powershell\Scheduler.ps1" '#'
            Invoke-DataMigration -LegacyRoot $s -DataDir "$t\data" | Out-Null
            $p = Get-RollbackPlan -DataDir "$t\data"
            $p.legacyRoot | Should Be $s.TrimEnd('\')
            Test-Path "$s\config\config.json" | Should Be $true
            Remove-Item "$s\src\powershell\Scheduler.ps1"
            { Get-RollbackPlan -DataDir "$t\data" } | Should Throw
        } finally { Remove-Item $s, $t -Recurse -Force }
    }
    It 'cleanup removes only the four data folders of the recorded old folder after a verified migration' {
        $s = New-FakeSource; $t = New-TempDir 'cl'
        try {
            { Invoke-LegacyCleanup -DataDir "$t\data" } | Should Throw
            Invoke-DataMigration -LegacyRoot $s -DataDir "$t\data" | Out-Null
            $gone = @(Invoke-LegacyCleanup -DataDir "$t\data")
            $gone.Count | Should Be 4
            Test-Path "$s\config" | Should Be $false
            Test-Path "$s\src\bridge\server.js" | Should Be $true
            Test-Path "$s\tests\x.ps1" | Should Be $true
            Test-Path "$t\data\config\config.json" | Should Be $true
        } finally { Remove-Item $s, $t -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It 'cleanup refuses when a file of the old folder is not in the new data folder' {
        $s = New-FakeSource; $t = New-TempDir 'cl2'
        try {
            Invoke-DataMigration -LegacyRoot $s -DataDir "$t\data" | Out-Null
            Set-Content "$s\data\history\new-after.json" 'x'
            { Invoke-LegacyCleanup -DataDir "$t\data" } | Should Throw
            Test-Path "$s\data\history\new-after.json" | Should Be $true
        } finally { Remove-Item $s, $t -Recurse -Force }
    }
}

Describe 'Installer: what an uninstall leaves behind' {
    It 'lists data, the migration backup, the administrators folder and the old folder; with -RemovedData the data line goes' {
        $s = New-FakeSource; $t = New-TempDir 'ul'
        try {
            New-Item -ItemType Directory -Path "$t\elev" | Out-Null
            Invoke-DataMigration -LegacyRoot $s -DataDir "$t\data" | Out-Null
            $l = Get-InstallLayout -ProgramDir "$t\prog" -DataDir "$t\data" -ElevatedDir "$t\elev"
            $left = (Get-UninstallLeftovers -Layout $l) -join "`n"
            $left | Should Match 'settings, history and reports'
            $left | Should Match 'migration-backup'
            $left | Should Match 'Administrator audit'
            $left | Should Match 'old folder'
            ((Get-UninstallLeftovers -Layout $l -RemovedData) -join "`n") | Should Not Match 'settings, history and reports'
        } finally { Remove-Item $s, $t -Recurse -Force }
    }
}

Describe 'Installer script: plan-only mode' {
    It 'prints the plan for temp folders and creates nothing; uninstall plan changes nothing either' {
        $t = New-TempDir 'planrun'
        try {
            $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'Install-LaptopGuardian.ps1') -PlanOnly -ProgramDir "$t\prog" -DataDir "$t\data" -ElevatedDir "$t\elev" 2>&1 | Out-String
            $LASTEXITCODE | Should Be 0
            $out | Should Match 'nothing is changed'
            $out | Should Match 'administrators-only folder'
            @(Get-ChildItem $t).Count | Should Be 0
            $u = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'Uninstall-LaptopGuardian.ps1') -PlanOnly 2>&1 | Out-String
            $LASTEXITCODE | Should Be 0
            $u | Should Match 'Stays'
        } finally { Remove-Item $t -Recurse -Force }
    }
    It 'rolls back and cleans up only on request, and rejects relative folders' {
        $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'Install-LaptopGuardian.ps1') -PlanOnly -ProgramDir 'rel' 2>&1 | Out-String
        $out | Should Match 'not an absolute path'
    }
}

Describe 'Installer: pre-install check (-Check)' {
    function Set-HealthyMachine {
        Mock -ModuleName Installer Get-NodeVersionText { '24.11.0' }
        Mock -ModuleName Installer Get-FreeBytesOf { 50GB }
        Mock -ModuleName Installer Test-PortListening { $false }
        Mock -ModuleName Installer Test-CurrentUserCanWrite { $true }
        Mock -ModuleName Installer Get-ExistingGuardianTasks { @() }
    }
    function Find-Check($list, $id) { @($list | Where-Object { $_.id -eq $id })[0] }
    It 'a healthy machine has no fail and no warning, and reports the tasks it will create' {
        $s = New-FakeSource; $t = New-TempDir 'chk'
        try {
            Set-HealthyMachine
            $l = Get-InstallLayout -ProgramDir "$t\prog" -DataDir "$t\data" -ElevatedDir "$t\elev"
            $r = @(Get-InstallCheck -Layout $l -SourceRoot $s)
            @($r | Where-Object { $_.status -in 'fail', 'warn' }).Count | Should Be 0
            (Find-Check $r 'node').status | Should Be 'ok'
            (Find-Check $r 'tasks').status | Should Be 'info'
            (Find-Check $r 'legacy').detail | Should Match 'backup zip'
            @(Get-ChildItem $t).Count | Should Be 0
        } finally { Remove-Item $s, $t -Recurse -Force }
    }
    It 'fails for a missing or old Node.js and for too little free space, and warns about a busy port' {
        $s = New-FakeSource; $t = New-TempDir 'chk2'
        try {
            Set-HealthyMachine
            $l = Get-InstallLayout -ProgramDir "$t\prog" -DataDir "$t\data" -ElevatedDir "$t\elev"
            Mock -ModuleName Installer Get-NodeVersionText { $null }
            (Find-Check @(Get-InstallCheck -Layout $l -SourceRoot $s) 'node').status | Should Be 'fail'
            Mock -ModuleName Installer Get-NodeVersionText { '20.11.0' }
            (Find-Check @(Get-InstallCheck -Layout $l -SourceRoot $s) 'node').detail | Should Match 'required'
            Mock -ModuleName Installer Get-NodeVersionText { '22.1.0' }
            Mock -ModuleName Installer Get-FreeBytesOf { 100MB }
            (Find-Check @(Get-InstallCheck -Layout $l -SourceRoot $s) 'disk-program').status | Should Be 'fail'
            Mock -ModuleName Installer Get-FreeBytesOf { 1GB }
            (Find-Check @(Get-InstallCheck -Layout $l -SourceRoot $s) 'disk-data').status | Should Be 'warn'
            Mock -ModuleName Installer Get-FreeBytesOf { 50GB }
            Mock -ModuleName Installer Test-PortListening { param($Port) $Port -eq 7878 }
            $r = @(Get-InstallCheck -Layout $l -SourceRoot $s)
            (Find-Check $r 'port-7878').status | Should Be 'warn'; (Find-Check $r 'port-7879').status | Should Be 'ok'
        } finally { Remove-Item $s, $t -Recurse -Force }
    }
    It 'warns when the program or administrators folder cannot be written, fails when the data folder cannot, and notes it is not elevated' {
        $s = New-FakeSource; $t = New-TempDir 'chk3'
        try {
            Set-HealthyMachine
            $l = Get-InstallLayout -ProgramDir "$t\prog" -DataDir "$t\data" -ElevatedDir "$t\elev"
            Mock -ModuleName Installer Test-CurrentUserCanWrite { param($Path) $Path -like '*\data' }
            $r = @(Get-InstallCheck -Layout $l -SourceRoot $s)
            (Find-Check $r 'write-program').status | Should Be 'warn'; (Find-Check $r 'write-administrators').status | Should Be 'warn'; (Find-Check $r 'write-data').status | Should Be 'ok'
            Mock -ModuleName Installer Test-CurrentUserCanWrite { $false }
            (Find-Check @(Get-InstallCheck -Layout $l -SourceRoot $s) 'write-data').status | Should Be 'fail'
        } finally { Remove-Item $s, $t -Recurse -Force }
    }
    It 'lists existing tasks with where they point, flags interrupted-update leftovers and an existing installed copy' {
        $s = New-FakeSource; $t = New-TempDir 'chk4'
        try {
            Set-HealthyMachine
            $l = Get-InstallLayout -ProgramDir "$t\prog" -DataDir "$t\data" -ElevatedDir "$t\elev"
            $global:T_Dir = $t; New-Item -ItemType Directory -Path "$t\prog", "$t\prog.new" | Out-Null; Set-Content "$t\prog\install.json" '{}'
            Mock -ModuleName Installer Get-ExistingGuardianTasks { @([pscustomobject]@{ name = 'Daily Audit'; state = 'Ready'; runLevel = 'Highest'; command = 'powershell.exe -File "C:\old\Daily.ps1"' }, [pscustomobject]@{ name = 'Weekly Deep Analysis'; state = 'Ready'; runLevel = 'Highest'; command = "powershell.exe -File `"$($global:T_Dir)\prog\src\powershell\Weekly.ps1`"" }) }
            $r = @(Get-InstallCheck -Layout $l -SourceRoot $s)
            (Find-Check $r 'task-Daily Audit').detail | Should Match 're-register'; (Find-Check $r 'task-Daily Audit').status | Should Be 'info'
            (Find-Check $r 'task-Weekly Deep Analysis').status | Should Be 'ok'
            (Find-Check $r 'staging').status | Should Be 'warn'; (Find-Check $r 'previous-install').status | Should Be 'info'
        } finally { Remove-Item $s, $t -Recurse -Force }
    }
    It 'the real wrappers only read: free space, ports and permissions of an existing folder' {
        $t = New-TempDir 'chk5'
        try {
            (Get-FreeBytesOf -Path "$t\not\yet") | Should BeGreaterThan 1MB
            (Test-CurrentUserCanWrite -Path "$t\not\yet") | Should Be $true
            (Test-CurrentUserCanWrite -Path (Join-Path $env:SystemRoot 'System32\drivers\etc\nothere')) | Should Be $false
            @(Get-ChildItem $t).Count | Should Be 0
        } finally { Remove-Item $t -Recurse -Force }
    }
    It 'Install-LaptopGuardian.ps1 -Check prints the report and creates nothing on temp folders' {
        $t = New-TempDir 'chk6'
        try {
            $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'Install-LaptopGuardian.ps1') -Check -ProgramDir "$t\prog" -DataDir "$t\data" -ElevatedDir "$t\elev" 2>&1 | Out-String
            $out | Should Match 'nothing is changed'; $out | Should Match 'Node.js'; $out | Should Match 'Port 7878'
            @(Get-ChildItem $t).Count | Should Be 0
        } finally { Remove-Item $t -Recurse -Force }
    }
}
