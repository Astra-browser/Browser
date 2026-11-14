# Switch the local engine tree between the dev Rust thin-LTO profile and the
# release fat-LTO profile. Only the final gkrust invocation is affected.
#
#   .\tools\windows\thin-lto.ps1            # dev: -Clto=thin
#   .\tools\windows\thin-lto.ps1 -Revert    # release: -Clto (fat)
#
# `forge fetch` replaces engine/, so re-run this after a fetch. `forge import`
# and `forge overlay` do not touch config/makefiles/rust.mk.
param(
    [switch]$Revert
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$file = Join-Path $root 'engine\config\makefiles\rust.mk'
if (-not (Test-Path $file)) {
    throw "thin-lto: $file is missing (run forge fetch first)"
}

$fat = 'cargo_rustc_flags += -Clto$(if $(filter full,$(MOZ_LTO_RUST_CROSS)),=fat)'
$thin = 'cargo_rustc_flags += -Clto=thin'
$text = [System.IO.File]::ReadAllText($file)
$utf8 = New-Object System.Text.UTF8Encoding($false)

if ($Revert) {
    if ($text.Contains($fat)) {
        Write-Host 'thin-lto: release fat LTO is already active'
        exit 0
    }
    if (-not $text.Contains($thin)) {
        throw 'thin-lto: expected gkrust LTO line not found'
    }
    [System.IO.File]::WriteAllText($file, $text.Replace($thin, $fat), $utf8)
    Write-Host 'thin-lto: release fat LTO restored'
    exit 0
}

if ($text.Contains($thin)) {
    Write-Host 'thin-lto: dev thin LTO is already active'
    exit 0
}
if (-not $text.Contains($fat)) {
    throw 'thin-lto: expected gkrust LTO line not found'
}
[System.IO.File]::WriteAllText($file, $text.Replace($fat, $thin), $utf8)
Write-Host 'thin-lto: dev thin LTO enabled (run with -Revert for release)'
