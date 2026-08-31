param(
    [Parameter(Mandatory = $true)][string]$Confirmation
)

. "$PSScriptRoot/Common.ps1"

Assert-Confirmation -Actual $Confirmation -Expected "ANONYMOUS-SMOKE"
$env:HYPERPLAYER_ACCEPTANCE_NETWORK = "external"
$env:HYPERPLAYER_ACCEPTANCE_WRITE_ALLOWED = "false"

Invoke-AcceptanceDriver -Scenario "netease-anonymous-smoke"
