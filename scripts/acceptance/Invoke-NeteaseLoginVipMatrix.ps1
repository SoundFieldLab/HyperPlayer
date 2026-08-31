param(
    [Parameter(Mandatory = $true)][string]$Confirmation
)

. "$PSScriptRoot/Common.ps1"

Assert-Confirmation -Actual $Confirmation -Expected "LOGIN-VIP-MATRIX"
$env:HYPERPLAYER_ACCEPTANCE_NETWORK = "external"
$env:HYPERPLAYER_ACCEPTANCE_WRITE_ALLOWED = "false"

Invoke-AcceptanceDriver `
    -Scenario "netease-login-vip-matrix" `
    -SecretNames @("HYPERPLAYER_NETEASE_TEST_ACCOUNTS_JSON")
