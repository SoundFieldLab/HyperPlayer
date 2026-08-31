Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-EnvironmentValue {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [switch]$Secret
    )

    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "BLOCKED: required environment variable '$Name' is not configured."
    }

    if ($Secret) {
        Write-Host "Credential '$Name' is configured (value redacted)."
    }

    return $value
}

function Assert-Confirmation {
    param(
        [Parameter(Mandatory = $true)][string]$Actual,
        [Parameter(Mandatory = $true)][string]$Expected
    )

    if ($Actual -cne $Expected) {
        throw "BLOCKED: confirmation must exactly equal '$Expected'."
    }
}

function Protect-AcceptanceOutput {
    param(
        [AllowNull()][object]$Line,
        [Parameter(Mandatory = $true)][string[]]$SensitiveValues
    )

    $redacted = [string]$Line
    foreach ($value in $SensitiveValues) {
        if (-not [string]::IsNullOrEmpty($value)) {
            $redacted = $redacted.Replace($value, "***REDACTED***")
            $escaped = [Uri]::EscapeDataString($value)
            if ($escaped -ne $value) {
                $redacted = $redacted.Replace($escaped, "***REDACTED***")
            }
        }
    }

    return $redacted
}

function Invoke-AcceptanceDriver {
    param(
        [Parameter(Mandatory = $true)][string]$Scenario,
        [string[]]$Arguments = @(),
        [string[]]$SecretNames = @()
    )

    $driver = Assert-EnvironmentValue -Name "HYPERPLAYER_ACCEPTANCE_DRIVER"
    $command = Get-Command $driver -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "BLOCKED: acceptance driver '$driver' is unavailable on this runner."
    }

    $sensitiveValues = @()
    foreach ($name in $SecretNames) {
        $sensitiveValues += Assert-EnvironmentValue -Name $name -Secret
    }

    Write-Host "Running isolated acceptance scenario '$Scenario'."
    & $command.Source "--scenario" $Scenario @Arguments 2>&1 |
        ForEach-Object { Write-Host (Protect-AcceptanceOutput -Line $_ -SensitiveValues $sensitiveValues) }
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 0 }
    if ($exitCode -ne 0) {
        throw "Acceptance scenario '$Scenario' failed with exit code $exitCode."
    }
}
