# Launch the packaged Windows dev build with a profile under out\dev-profile.
#
#   .\tools\run-dev.ps1
#   .\tools\run-dev.ps1 -Fresh
#   .\tools\run-dev.ps1 -- -new-window
#
# The Linux launcher is tools/run-dev.sh; this script is Windows-only and does
# not touch the Linux path.
param(
    [switch]$Fresh,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$FirefoxArgs
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$binary = Join-Path $root 'engine\obj-astra-windows\dist\bin\firefox.exe'
$profile = Join-Path $root 'out\dev-profile'

if (-not (Test-Path $binary)) {
    Write-Host "run-dev: $binary is missing." -ForegroundColor Yellow
    Write-Host "run-dev: build it with:"
    Write-Host "  cargo run -q --manifest-path forge/astra-forge/Cargo.toml -- build --os windows --jobs 2"
    exit 1
}

if ($Fresh -and (Test-Path $profile)) {
    Remove-Item $profile -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $profile | Out-Null

$arguments = @('-no-remote', '-profile', $profile) + $FirefoxArgs
Write-Host "run-dev: $binary"
Write-Host "run-dev: profile $profile"
& $binary @arguments
exit $LASTEXITCODE
