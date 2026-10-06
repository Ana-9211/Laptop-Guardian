#requires -Version 5.1
# Remediation: the ONLY executable fixes Laptop Guardian offers. Every action is a fixed, allowlisted template from
# src/shared/action-catalog.json. Parameters are validated against the catalog, live identity is re-checked immediately
# before acting, protected targets are refused, and the outcome is verified by reading the system back.
# Nothing here ever runs a string supplied by a user, a recommendation, or an AI model.
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'RemHelpers.psm1') -Force -DisableNameChecking -Global
Import-Module (Join-Path $PSScriptRoot 'NetworkActions.psm1') -Force -DisableNameChecking -Global

$script:CatalogPath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'shared\action-catalog.json'
$script:Catalog = $null
$script:RevoShortcut = 'C:\Users\Public\Desktop\Revo Uninstaller.lnk'

# The action families live in Remediation\*.ps1 and are dot-sourced here so they stay in this module's scope.
. (Join-Path $PSScriptRoot 'Remediation\Catalog.ps1')
. (Join-Path $PSScriptRoot 'Remediation\Helpers.ps1')
. (Join-Path $PSScriptRoot 'Remediation\Apps.ps1')
. (Join-Path $PSScriptRoot 'Remediation\Processes.ps1')
. (Join-Path $PSScriptRoot 'Remediation\Startup.ps1')
. (Join-Path $PSScriptRoot 'Remediation\Tasks.ps1')
. (Join-Path $PSScriptRoot 'Remediation\Services.ps1')
. (Join-Path $PSScriptRoot 'Remediation\Files.ps1')
. (Join-Path $PSScriptRoot 'Remediation\Defender.ps1')
. (Join-Path $PSScriptRoot 'Remediation\Firewall.ps1')
. (Join-Path $PSScriptRoot 'Remediation\Dns.ps1')
. (Join-Path $PSScriptRoot 'Remediation\System.ps1')
. (Join-Path $PSScriptRoot 'Remediation\Cleanup.ps1')
. (Join-Path $PSScriptRoot 'Remediation\Scans.ps1')
. (Join-Path $PSScriptRoot 'Remediation\Dispatch.ps1')

Export-ModuleMember -Function Get-ActionCatalog, Get-ActionSpec, Test-ActionParams, Invoke-GuardianRemediation, Get-InstalledPrograms, Get-RevoInfo
