# Astra one-command setup for Windows 10/11 x64.
# Invoked by ../../setup.sh from Git Bash, or directly:
#   powershell -ExecutionPolicy Bypass -File tools/setup-windows.ps1
#
# It checks/installs prerequisites, links an existing Firefox source tree when
# asked, builds the UI + overlay + Windows engine, and packages the portable
# zip plus the per-user setup.exe. Generated engine files are never committed.
[CmdletBinding()]
param(
    [string]$EngineSource = $env:ASTRA_ENGINE_SOURCE,
    [string]$ObjDir = $env:ASTRA_OBJDIR,
    [string]$Jobs = $(if ($env:JOBS) { $env:JOBS } else { '2' }),
    [switch]$DryRun,
    [switch]$SkipUi,
    [switch]$SkipBuild,
    [switch]$SkipPackage,
    [switch]$SkipInstaller,
    [switch]$Faster,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'out'
$setupDir = Join-Path $out 'setup'
New-Item -ItemType Directory -Force -Path $setupDir | Out-Null
$log = Join-Path $setupDir ("setup-windows-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")

function Write-Log([string]$text) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $text
    Write-Host $line
    Add-Content -Path $log -Value $line
}
function Step([string]$text) { Write-Log ''; Write-Log "== $text" }
function Fail([string]$text) {
    Write-Log "FAILED: $text"
    Write-Log "log: $log"
    exit 1
}
function Have([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Find-Makensis {
    $cmd = Get-Command makensis.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles 'NSIS\makensis.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe')
    )) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Find-Nasm216 {
    if ($env:ASTRA_NASM_DIR -and (Test-Path (Join-Path $env:ASTRA_NASM_DIR 'nasm.exe'))) {
        return (Resolve-Path $env:ASTRA_NASM_DIR).Path
    }
    foreach ($candidate in @(
        'D:\astra-build\nasm-2.16.03\nasm-2.16.03',
        'C:\tools\nasm-2.16.03',
        'C:\tools\nasm-2.16.03\nasm-2.16.03'
    )) {
        if (Test-Path (Join-Path $candidate 'nasm.exe')) { return $candidate }
    }
    return $null
}

function Find-WasiSysroot {
    foreach ($candidate in @(
        $env:MOZ_WASI_SYSROOT,
        $env:WASI_SYSROOT,
        'D:\astra-build\wasi-34\wasi-sysroot-34.0',
        'D:\astra-build\wasi\wasi-sysroot',
        'C:\tools\wasi-sysroot',
        (Join-Path $env:USERPROFILE '.mozbuild\wasi-sysroot')
    )) {
        if ($candidate -and (Test-Path (Join-Path $candidate 'include'))) {
            return (Resolve-Path $candidate).Path
        }
    }
    return $null
}

function Add-UserPaths {
    $paths = @(
        (Join-Path $env:USERPROFILE '.cargo\bin'),
        (Join-Path $env:USERPROFILE '.bun\bin')
    )
    foreach ($p in $paths) {
        if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) { $env:Path = "$p;$env:Path" }
    }
}

function Install-Winget([string]$id, [string]$command) {
    if (Have $command) { return $true }
    if ($DryRun) { Write-Log "missing $command (would install $id)"; return $false }
    if (-not (Have winget)) { Write-Log "missing $command and winget; install $id manually"; return $false }
    Step "installing $id"
    & winget install --id $id -e --source winget --silent --accept-package-agreements --accept-source-agreements
    Add-UserPaths
    return (Have $command)
}

function Install-Bun {
    if (Have bun) { return $true }
    if ($DryRun) { Write-Log 'missing bun (would install from https://bun.sh/install.ps1)'; return $false }
    Step 'installing Bun'
    Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
    Add-UserPaths
    return (Have bun)
}

function Require-Tools {
    Step 'checking prerequisites'
    $missing = @()
    if (-not (Install-Winget 'Git.Git' 'git')) { $missing += 'git' }
    if (-not (Install-Winget 'Python.Python.3.12' 'python')) { $missing += 'python' }
    if (-not (Install-Winget 'OpenJS.NodeJS.LTS' 'node')) { $missing += 'node' }
    if (-not (Install-Winget 'Rustlang.Rustup' 'cargo')) { $missing += 'cargo' }
    Add-UserPaths
    if (-not (Have cargo)) { $missing += 'cargo' }
    if (-not (Install-Bun)) { $missing += 'bun' }

    $mozillaBuild = 'C:\mozilla-build\start-shell.bat'
    if (-not (Test-Path $mozillaBuild)) { $missing += 'MozillaBuild (C:\mozilla-build)' }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) {
        if ($DryRun) { Write-Log 'missing Visual Studio Build Tools (would install VCTools workload)' }
        else {
            Step 'installing Visual Studio Build Tools (VCTools workload)'
            & winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --silent `
                --accept-package-agreements --accept-source-agreements `
                --override '--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
        }
        if (-not (Test-Path $vswhere)) { $missing += 'Visual Studio Build Tools' }
    }
    if (-not $SkipInstaller) {
        if (-not (Find-Makensis)) {
            if (-not (Install-Winget 'NSIS.NSIS' 'makensis.exe')) { $missing += 'makensis' }
        }
        if (-not (Find-Makensis)) { $missing += 'makensis' }
    }
    if ($missing.Count -gt 0) {
        Write-Log ("missing prerequisites: " + ($missing -join ', '))
        if ($DryRun) { return }
        Fail 'prerequisites are still missing after install attempts'
    }
    Write-Log 'prerequisites ok'
}

function Run([string]$name, [scriptblock]$body) {
    Step $name
    $global:LASTEXITCODE = 0
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $body 2>&1 | Tee-Object -FilePath $log -Append
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($LASTEXITCODE -ne 0) { Fail "$name (exit $LASTEXITCODE)" }
}

if ($Check) {
    Step 'checking the packaged build'
    $zip = Get-ChildItem (Join-Path $out 'release') -Filter 'Astra-*-windows-x86_64.zip' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $zip) { Fail 'no packaged Windows zip (run setup first)' }
    Write-Log "package: $($zip.FullName)"
    $hash = Get-FileHash -Algorithm SHA256 $zip.FullName
    Write-Log "sha256: $($hash.Hash.ToLowerInvariant())"
    exit 0
}

Write-Log "Astra Windows setup -> $root"
Write-Log "host: $([Environment]::OSVersion.VersionString) x64=$([Environment]::Is64BitOperatingSystem)"
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'x64 Windows is required' }
Require-Tools

if ($DryRun) {
    Write-Log ''
    Write-Log 'plan:'
    Write-Log "  jobs:     $Jobs"
    Write-Log "  engine:   $(if ($EngineSource) { "reuse $EngineSource" } else { 'forge fetch pinned Firefox ESR' })"
    Write-Log "  objdir:   $(if ($ObjDir) { $ObjDir } else { 'engine\obj-astra-windows' })"
    Write-Log "  ui:       $(if ($SkipUi) { 'reuse existing bundle' } else { 'bun install + build:chrome' })"
    Write-Log "  build:    $(if ($SkipBuild) { 'skip' } else { 'forge config + overlay + forge build --os windows' })"
    Write-Log "  package:  $(if ($SkipPackage) { 'skip' } else { 'portable zip' + $(if ($SkipInstaller) { '' } else { ' + setup.exe' }) })"
    Write-Log '  output:   out\release\Astra-<version>-windows-x86_64.zip (+ .sha256, + setup.exe)'
    exit 0
}

$forge = Join-Path $root 'forge\astra-forge\target\release\astra-forge.exe'
Run 'building astra-forge' {
    & cargo build --release --manifest-path (Join-Path $root 'forge\astra-forge\Cargo.toml')
    if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }
}

$engine = Join-Path $root 'engine'
if ($EngineSource) {
    $source = (Resolve-Path $EngineSource).Path
    if (Test-Path $engine) {
        $item = Get-Item $engine -Force
        if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Fail "$engine exists and is not a junction; move it aside or omit -EngineSource"
        }
    } else {
        Step 'linking reusable engine source'
        New-Item -ItemType Junction -Path $engine -Target $source | Out-Null
    }
    Write-Log "engine: $engine -> $source"
} else {
    if (-not (Test-Path (Join-Path $engine 'mach'))) {
        Run 'fetching pinned upstream' { & $forge fetch }
    } else {
        Write-Log "engine: existing source at $engine"
    }
}

$configArgs = @('config', '--os', 'windows', '--branding', 'astra')
if ($ObjDir) {
    New-Item -ItemType Directory -Force -Path $ObjDir | Out-Null
    $configArgs += @('--objdir', $ObjDir)
}
Run 'rendering mozconfig' { & $forge @configArgs }
$mozconfig = Join-Path $root 'out\mozconfig.windows'
$wasi = Find-WasiSysroot
if ($wasi) {
    $wasiOption = $wasi -replace '\\', '/'
    Add-Content -Path $mozconfig -Value "`nac_add_options --with-wasi-sysroot=$wasiOption"
    Write-Log "wasi sysroot: $wasi"
} else {
    Add-Content -Path $mozconfig -Value "`nac_add_options --without-wasm-sandboxed-libraries"
    Write-Log 'wasi sysroot: not found; building with --without-wasm-sandboxed-libraries'
}

if (-not $SkipUi) {
    Run 'building the chrome UI bundle' {
        Push-Location (Join-Path $root 'ui')
        try {
            & bun install --frozen-lockfile
            if ($LASTEXITCODE -ne 0) { throw 'bun install failed' }
            & bun run --filter '@astra/frame' build:chrome
            if ($LASTEXITCODE -ne 0) { throw 'build:chrome failed' }
        } finally { Pop-Location }
    }
}

Run 'regenerating the host jar manifest' { & node (Join-Path $root 'tools\stage-host-jar.mjs') }
Run 'applying overlay + patch series' { & $forge overlay --os windows }

if (-not $SkipBuild) {
    $nasm = Get-Command nasm.exe -ErrorAction SilentlyContinue
    if ($nasm) {
        $nasmVersion = (& $nasm.Source -v 2>&1 | Select-Object -First 1)
        Write-Log "nasm: $nasmVersion"
        if ($nasmVersion -match 'NASM version 3\.') {
            $nasm216 = Find-Nasm216
            if (-not $nasm216) {
                Fail 'NASM 3.x crashes the pinned libvpx assembly; install NASM 2.16.x or set ASTRA_NASM_DIR'
            }
            $env:ASTRA_NASM_DIR = $nasm216
            $env:Path = "$nasm216;$env:Path"
            Write-Log "nasm 2.16: $nasm216 (overriding 3.x for this build)"
        }
    }
    # Force this checkout's rendered mozconfig. The objdir may remember a
    # different one from another checkout; a changed file also makes mach
    # regenerate backend.mk with the NASM above.
    $env:MOZCONFIG = Join-Path $root 'out\mozconfig.windows'
    $buildArgs = @('build', '--os', 'windows', '--jobs', $Jobs)
    if ($Faster) { $buildArgs += '--faster' }
    Run 'building the engine' { & $forge @buildArgs }
}

if (-not $SkipPackage) {
    $package = Join-Path $root 'tools\package-windows.ps1'
    $packageArgs = @{}
    if (-not $SkipInstaller) { $packageArgs.Installer = $true }
    Run 'packaging Windows release' { & $package @packageArgs }

    Step 'verifying the package'
    $zip = Get-ChildItem (Join-Path $out 'release') -Filter 'Astra-*-windows-x86_64.zip' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $zip) { Fail 'package produced no zip' }
    $sha = "$($zip.FullName).sha256"
    if (-not (Test-Path $sha)) { Fail "package produced no sha256 for $($zip.Name)" }
    $listing = & tar.exe -tf $zip.FullName
    if ($LASTEXITCODE -ne 0 -or -not ($listing -match 'Astra/astra.exe')) {
        Fail "package does not contain Astra/astra.exe"
    }
    if (-not $SkipInstaller) {
        $setup = Get-ChildItem (Join-Path $out 'release') -Filter 'Astra-*-windows-x86_64-setup.exe' |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $setup) { Fail 'installer was requested but no setup.exe was produced' }
        Write-Log "installer: $($setup.FullName)"
    }
    Write-Log "package: $($zip.FullName)"
    Write-Log "sha256:  $((Get-FileHash -Algorithm SHA256 $zip.FullName).Hash.ToLowerInvariant())"
}

Step 'done'
Write-Log "log: $log"
