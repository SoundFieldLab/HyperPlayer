param(
    [Parameter(Mandatory = $true)][string]$Confirmation
)

. "$PSScriptRoot/Common.ps1"

Assert-Confirmation -Actual $Confirmation -Expected "WINDOWS-AUDIO-SMTC"
if (-not $IsWindows) {
    throw "BLOCKED: Windows audio/SMTC acceptance requires a Windows runner."
}

$env:HYPERPLAYER_ACCEPTANCE_NETWORK = "disabled"
$env:HYPERPLAYER_ACCEPTANCE_WRITE_ALLOWED = "false"

Invoke-AcceptanceDriver -Scenario "windows-audio-smtc"
