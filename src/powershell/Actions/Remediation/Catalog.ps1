# Reads the action catalog and validates parameters against it.
# Dot-sourced by Actions\Remediation.psm1 (same module scope, so Pester mocks and exports are unchanged).
function Get-ActionCatalog {
    if (-not $script:Catalog) { $script:Catalog = Get-Content -LiteralPath $script:CatalogPath -Raw | ConvertFrom-Json }
    return $script:Catalog
}
function Get-ActionSpec {
    param([string]$Id)
    $c = Get-ActionCatalog
    return @($c.actions | Where-Object { $_.id -eq $Id })[0]
}

function Test-ActionParams {
    <# Validates a params hashtable against the catalog spec: no unknown keys, required keys present, patterns and enums respected. #>
    param($Spec, [hashtable]$Params)
    $errs = New-Object System.Collections.ArrayList
    $catalog = Get-ActionCatalog
    $declared = @($Spec.params.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($k in $Params.Keys) { if ($k -like '_*') { continue }; if ($declared -notcontains $k) { [void]$errs.Add("Unexpected parameter '$k'") } }
    foreach ($d in $declared) {
        $def = $Spec.params.$d
        $optional = ($def.PSObject.Properties.Name -contains 'optional') -and $def.optional
        $has = $Params.ContainsKey($d) -and $null -ne $Params[$d] -and ([string]$Params[$d]) -ne ''
        if (-not $has) { if (-not $optional) { [void]$errs.Add("Missing parameter '$d'") }; continue }
        $v = [string]$Params[$d]
        if ($def.PSObject.Properties.Name -contains 'enum') { if (@($def.enum) -cnotcontains $v) { [void]$errs.Add("Parameter '$d' must be one of: $(@($def.enum) -join ', ')") } }
        elseif ($def.PSObject.Properties.Name -contains 'pattern') {
            $rx = $catalog.patterns.($def.pattern)
            if ($v -notmatch $rx) { [void]$errs.Add("Parameter '$d' has an invalid format") }
        }
    }
    return $errs   # callers wrap the result in @() so zero errors really is an empty array
}
