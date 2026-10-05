# PSScriptAnalyzer settings for Laptop Guardian. CI fails on any remaining Warning or Error.
# The excluded rules are deliberate, repo-wide patterns, not oversights:
@{
    Severity     = @('Error', 'Warning')
    ExcludeRules = @(
        # Collectors, cleanup and best-effort writes are written as "try, and carry on if it fails" on purpose: one broken
        # collector must never stop a run. The ones that matter write an audit event or a warning instead.
        'PSAvoidUsingEmptyCatchBlock'
        # Module functions keep the Pester-style parameter lists of their callers; unused ones are reviewed by hand.
        'PSReviewUnusedParameter'
        # Names such as Get-ProtectedProcessNames are deliberate plurals; renaming them would churn the public surface for nothing.
        'PSUseSingularNouns'
        # Internal helpers that change state are guarded by plans, confirmations and Safe Mode, not by -WhatIf.
        'PSUseShouldProcessForStateChangingFunctions'
        # The installer and uninstaller talk to a person in a console.
        'PSAvoidUsingWriteHost'
        # False positive: "Get-NetworkHealth" style names and a local variable called ComputerName are not hard-coded hosts.
        'PSAvoidUsingComputerNameHardcoded'
        # The Gemini key is received over stdin and immediately protected with DPAPI (ConvertFrom-SecureString); there is no
        # other way to build the SecureString from the text.
        'PSAvoidUsingConvertToSecureStringWithPlainText'
    )
}
