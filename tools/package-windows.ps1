# Build the per-user Windows package from a finished engine build.
#
#   .\tools\package-windows.ps1                 # portable zip only
#   .\tools\package-windows.ps1 -Installer      # zip + setup.exe (NSIS)
#   .\tools\package-windows.ps1 -Dist <dir> -Out <dir>
#
# Output (default out\release):
#   Astra-<version>-windows-x86_64.zip
#   Astra-<version>-windows-x86_64.zip.sha256
#   Astra-<version>-windows-x86_64-setup.exe          (with -Installer)
#   windows-package.json
#
# The zip is the portable build: extract the Astra folder and run astra.cmd
# (or firefox.exe with an explicit -profile). The installer is per-user, no
# elevation, and registers a ProgId, capabilities and an AppUserModelID.
#
# The engine build must already be overlaid (forge overlay --os windows) and
# built; this script never builds or mutates engine/.
[CmdletBinding()]
param(
    [string]$Dist = '',
    [string]$Out = '',
    [string]$Version = '',
    [switch]$Installer,
    [switch]$SkipZip,
    [switch]$KeepStage
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Dist) { $Dist = Join-Path $root 'engine\obj-astra-windows\dist\bin' }
if (-not $Out) { $Out = Join-Path $root 'out\release' }
$Dist = (Resolve-Path $Dist).Path
if (-not (Test-Path (Join-Path $Dist 'firefox.exe'))) {
    throw "package-windows: no firefox.exe under $Dist; build the Windows tree first"
}
if (-not (Test-Path (Join-Path $Dist 'astra-core.exe'))) {
    throw "package-windows: astra-core.exe is missing beside firefox.exe"
}

if (-not $Version) {
    $toml = Get-Content (Join-Path $root 'branding\astra.toml') -Raw
    $match = [regex]::Match($toml, '(?m)^\s*version\s*=\s*"([^"]+)"')
    if (-not $match.Success) { throw 'branding/astra.toml has no version' }
    $Version = $match.Groups[1].Value
}

$name = "Astra-$Version-windows-x86_64"
$release = New-Item -ItemType Directory -Force -Path $Out
$stageRoot = Join-Path $Out 'stage-windows'
$app = Join-Path $stageRoot 'Astra'
if (Test-Path $stageRoot) { Remove-Item $stageRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $app | Out-Null

Write-Host "== staging $Dist -> $app"
# /MIR gives a fresh tree; /NFL /NDL keep the console readable, /NJH /NJS
# drop the banner and per-job summary. Test executables are build artifacts,
# not product payload.
$robocopyArgs = @(
    $Dist, $app, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/R:2', '/W:2',
    '/XF', 'Test*.exe', 'crashinject.exe', 'crashinjectdll.dll',
    '/XD', 'gtest', 'cppunittests', 'xpcrs'
)
& robocopy @robocopyArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

# Give the product its own executable name. The engine launcher works under
# any name and this keeps Windows' Applications\firefox.exe identity (shared
# with a real Firefox install) untouched. firefox.exe stays for compatibility.
Copy-Item (Join-Path $app 'firefox.exe') (Join-Path $app 'astra.exe') -Force

$gitCommit = (git -C $root rev-parse --short HEAD 2>$null)
$gitBranch = (git -C $root rev-parse --abbrev-ref HEAD 2>$null)
$engineVersion = '153.6.0esr'
$engineIni = Join-Path $Dist 'platform.ini'
if (Test-Path $engineIni) {
    $m = [regex]::Match((Get-Content $engineIni -Raw), '(?m)^Milestone=(.+)$')
    if ($m.Success) { $engineVersion = $m.Groups[1].Value.Trim() + 'esr' }
}

$build = @"
product: Astra
version: $Version
platform: windows-x86_64
built: $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))
git: $gitBranch @ $gitCommit
engine: Firefox ESR $engineVersion (pinned upstream)
work-flag: off (VITE_ASTRA_WORK unset)
package: $name
"@
Set-Content -Path (Join-Path $app 'BUILD.txt') -Value $build -Encoding UTF8

$launcher = @'
@echo off
rem Astra portable launcher. Keeps its profile under %APPDATA%\Astra so it is
rem separate from a Firefox install. Pass -profile yourself to override.
setlocal
set "ASTRA_DIR=%~dp0"
if not defined ASTRA_PROFILE set "ASTRA_PROFILE=%APPDATA%\Astra\Profiles\default"
if not exist "%ASTRA_PROFILE%" mkdir "%ASTRA_PROFILE%"
start "" "%ASTRA_DIR%astra.exe" -profile "%ASTRA_PROFILE%" -no-remote %*
'@
Set-Content -Path (Join-Path $app 'astra.cmd') -Value $launcher -Encoding ASCII

$readme = @"
# Astra for Windows 11 x64

This is the portable Astra build. It contains the full product: ad and tracker
blocking, spaces, split view, picture-in-picture, notes, tasks, extensions and
the Astra interface. Work is off in this build (Beta 1 rule).

## Run without installing

Double-click ``astra.cmd``. It keeps its profile in
``%APPDATA%\Astra\Profiles\default``, separate from Firefox.

You can also run ``astra.exe -profile <dir> -no-remote`` directly. The
``firefox.exe`` beside it is the original engine launcher and is kept for
compatibility.

## Install

Run the ``Astra-$Version-windows-x86_64-setup.exe`` installer for a per-user
install (no administrator rights). It creates Start Menu and desktop shortcuts,
registers an Astra ProgId and capabilities, and writes an uninstaller in the
install directory.

Windows decides the default browser. Open
``Settings > Apps > Default apps > Astra`` after installing to choose it.

## Requirements

Windows 11 x64. The build uses the system WebView2/Windows App Runtime
components staged beside the binary; no Visual C++ redistributable or .NET
download is needed.

For the discrete GPU, set Windows Graphics preference for ``astra.exe`` to
**High performance** (NVIDIA RTX), and prefer the NVIDIA GPU in the NVIDIA
Control Panel. The browser reports the adapter in ``about:support``.

## Notes

- The engine build is not update-enabled; replace the folder to update.
- Uninstalling leaves the profile under ``%APPDATA%\Astra`` alone. Remove it
  yourself if you want a clean slate.
- Build metadata: ``BUILD.txt``. The SHA-256 of the archive is in the
  ``.sha256`` file beside it.
"@
Set-Content -Path (Join-Path $app 'README.md') -Value $readme -Encoding UTF8

if (-not $SkipZip) {
    $zip = Join-Path $Out "$name.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Write-Host "== zip $zip"
    $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($tar) {
        & $tar.Source -a -c -f $zip -C $stageRoot Astra
        if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
    } else {
        Compress-Archive -Path (Join-Path $stageRoot 'Astra') -DestinationPath $zip -CompressionLevel Optimal
    }

    $hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
    "$hash  $name.zip" | Set-Content -Path "$zip.sha256" -Encoding ASCII
    Write-Host "sha256 $hash"
}

if ($Installer) {
    $makensis = Get-Command makensis.exe -ErrorAction SilentlyContinue
    if (-not $makensis) {
        foreach ($candidate in @(
            "$env:ProgramFiles\NSIS\makensis.exe",
            "${env:ProgramFiles(x86)}\NSIS\makensis.exe"
        )) {
            if (Test-Path $candidate) { $makensis = Get-Command $candidate }
        }
    }
    if (-not $makensis) {
        throw 'package-windows: makensis.exe not found (winget install NSIS.NSIS)'
    }
    $setup = Join-Path $Out "$name-setup.exe"
    if (Test-Path $setup) { Remove-Item $setup -Force }
    $nsi = Join-Path $PSScriptRoot 'windows\astra-installer.nsi'
    $icon = Join-Path $root 'overlay\astra\branding\astra.ico'
    Write-Host "== installer $setup"
    & $makensis.Source /V2 "/DVERSION=$Version" "/DSTAGE=$app" "/DOUT=$Out" `
        "/DOUTFILE=$name-setup.exe" "/DICON=$icon" $nsi
    if ($LASTEXITCODE -ne 0) { throw "makensis failed with exit code $LASTEXITCODE" }
    $setupHash = (Get-FileHash -Algorithm SHA256 $setup).Hash.ToLowerInvariant()
    "$setupHash  $name-setup.exe" | Set-Content -Path "$setup.sha256" -Encoding ASCII
    Write-Host "sha256 $setupHash"
}

$manifest = [ordered]@{
    product = 'Astra'
    version = $Version
    platform = 'windows-x86_64'
    engine = "Firefox ESR $engineVersion"
    git = "$gitBranch@$gitCommit"
    built = (Get-Date).ToUniversalTime().ToString('o')
    dist = $Dist
    stage = if ($KeepStage) { $app } else { $null }
    zip = if ($SkipZip) { $null } else { "$name.zip" }
    installer = if ($Installer) { "$name-setup.exe" } else { $null }
}
$manifest | ConvertTo-Json | Set-Content -Path (Join-Path $Out 'windows-package.json') -Encoding UTF8
if (-not $KeepStage) {
    # Keep `out/` free of a duplicate 337 MiB browser tree; brand-lint and
    # accidental packaging of a stale stage both get simpler.
    Remove-Item $stageRoot -Recurse -Force
}
Write-Host "== package $name in $Out"
