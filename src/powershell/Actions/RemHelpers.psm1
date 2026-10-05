#requires -Version 5.1
# Shared helpers for the remediation modules. Imported globally so Remediation.psm1 and NetworkActions.psm1 see the same functions.
Set-StrictMode -Version 2.0

function New-RemResult {
    param([bool]$Ok, [string]$Message = '', [string[]]$Errors = @(), [bool]$NeedsAdmin = $false, [bool]$NeedsElevation = $false, [string]$IdentityKey = '', $Details = $null, $Undo = $null, [bool]$Verified = $false, [string]$Action = '', [string[]]$Warnings = @(), [string]$Mode = '')
    [pscustomobject]@{
        ok = $Ok; action = $Action; mode = $Mode; message = $Message; errors = @($Errors); needsAdmin = $NeedsAdmin; needsElevation = $NeedsElevation
        identityKey = $IdentityKey; verified = $Verified; details = $Details; undo = $Undo; warnings = @($Warnings)
    }
}
function Get-StringKey { param([string[]]$Parts) return (($Parts | ForEach-Object { [string]$_ }) -join '|') }
function Get-OptionalProp { param($Obj, [string]$Name) if ($null -ne $Obj -and ($Obj.PSObject.Properties.Name -contains $Name)) { $Obj.$Name } else { $null } }

Export-ModuleMember -Function New-RemResult, Get-StringKey, Get-OptionalProp
