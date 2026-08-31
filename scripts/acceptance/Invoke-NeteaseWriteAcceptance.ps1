param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("playlist-create-delete", "favorite-toggle")]
    [string]$Operation,
    [Parameter(Mandatory = $true)][string]$Confirmation
)

. "$PSScriptRoot/Common.ps1"

Assert-Confirmation -Actual $Confirmation -Expected "WRITE:$Operation"
$env:HYPERPLAYER_ACCEPTANCE_NETWORK = "external"
$env:HYPERPLAYER_ACCEPTANCE_WRITE_ALLOWED = "true"

Invoke-AcceptanceDriver `
    -Scenario "netease-write-acceptance" `
    -Arguments @("--operation", $Operation, "--cleanup", "required") `
    -SecretNames @("HYPERPLAYER_NETEASE_WRITE_ACCOUNT_JSON")
