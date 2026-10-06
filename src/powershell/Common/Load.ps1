# Dot-source this from entrypoints:  . "$PSScriptRoot\Common\Load.ps1"
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Encoding.ps1')   # UTF-8 on stdout/stdin before anything can print
$script:GuardianPsRoot = Split-Path -Parent $PSScriptRoot
$mods = @(
    'Common\Core.psm1', 'Common\Security.psm1',
    'Processes\Persistence.psm1', 'Processes\Processes.psm1', 'Processes\Policy.psm1', 'Processes\Recommendations.psm1',
    'Health\System.psm1', 'Defender\Defender.psm1', 'Network\Network.psm1', 'Windows\WindowsHealth.psm1', 'Services\Services.psm1',
    'Storage\Storage.psm1', 'Files\Files.psm1', 'AI\AI.psm1', 'Reports\Reports.psm1', 'Pipeline\Pipeline.psm1', 'Shutdown\Shutdown.psm1', 'Install\InstallSecurity.psm1'
)
foreach ($m in $mods) {
    $p = Join-Path $script:GuardianPsRoot $m
    if (-not (Test-Path -LiteralPath $p)) { throw "Laptop Guardian module missing: $m" }
    Import-Module -Name $p -Force -DisableNameChecking -Global -ErrorAction Stop
}
