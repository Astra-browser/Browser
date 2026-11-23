#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Full verification on Windows: contracts, UI checks, then the live probes
  serially against the packaged dev build.

.DESCRIPTION
  The Linux runner (tools/perf/full-suite.sh) needs a Wayland compositor
  (tools/perf/hidden-display.sh); this is the same gate with no compositor:
  variables under test are the platform's own `engine/obj-astra-windows` build.

  Results go to out/full-suite-<UTC stamp>/ (contract-*.log, probe-*.json,
  probe-*.err, summary.txt, results.json). Set ASTRA_SUITE_OUT to choose
  another directory.

  Build is a separate step (forge build --os windows --faster); pass -Build to
  run the UI bundles and the engine build from here.

  A probe that cannot start is SKIP with the reason (exit 2, or no binary at
  the resolved path), never PASS and never invented.

.PARAMETER SkipBuild
  Re-use the current build (this is the default; -Build opts in).
.PARAMETER SkipLive
  Contracts + UI checks + lint/state only: no browser, no benches.
.PARAMETER SkipPerf
  Skip the benchmark pass.
.PARAMETER Timeout
  Per-probe timeout in seconds (default 420).
.PARAMETER Out
  Results directory (default out/full-suite-<stamp>).

.EXAMPLE
  pwsh -File tools/perf/full-suite.ps1 -SkipLive
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/perf/full-suite.ps1 --skip-live
#>
# No param() block: the runner accepts `-SkipLive` and `--skip-live` alike from
# both pwsh and powershell, which parameter binding does not.
$ErrorActionPreference = "Continue"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

# --- arguments (accept PowerShell and `--kebab-case` spellings) --------------
$SkipBuild = $false
$SkipLive = $false
$SkipPerf = $false
$Build = $false
$Timeout = 420
$Out = $null
$index = 0
while ($index -lt $args.Count) {
    $arg = [string]$args[$index]
    switch -Regex ($arg.ToLowerInvariant()) {
        '^(-{1,2})(skip-build|skipbuild)$' { $SkipBuild = $true; break }
        '^(-{1,2})(skip-live|skiplive)$' { $SkipLive = $true; break }
        '^(-{1,2})(skip-perf|skipperf)$' { $SkipPerf = $true; break }
        '^(-{1,2})(build)$' { $Build = $true; break }
        '^(-{1,2})(help|h|\?)$' {
            Write-Host "tools/perf/full-suite.ps1 [--skip-build] [--skip-live] [--skip-perf]"
            Write-Host "                            [-build] [-timeout <s>] [-out <dir>]"
            Write-Host ""
            Write-Host "  --skip-live   contracts + UI checks + lint/state only (no browser)"
            Write-Host "  --build       run the UI bundles and the engine build first"
            Write-Host "  -timeout <s>  per-probe timeout (default 420)"
            Write-Host "  -out <dir>    results directory (default out/full-suite-<stamp>)"
            exit 0
        }
        '^(-{1,2})(out|results)(=(.+))?$' {
            if ($arg -match '=(.+)$') {
                $Out = $Matches[1]
            } else {
                $index += 1
                if ($index -ge $args.Count) { Write-Error "-Out needs a path"; exit 2 }
                $Out = [string]$args[$index]
            }
            break
        }
        '^(-{1,2})(timeout)(=(.+))?$' {
            if ($arg -match '=(.+)$') {
                $Timeout = [int]$Matches[1]
            } else {
                $index += 1
                if ($index -ge $args.Count) { Write-Error "-Timeout needs seconds"; exit 2 }
                $Timeout = [int]$args[$index]
            }
            break
        }
        default {
            Write-Error "full-suite: unknown argument $arg"
            exit 2
        }
    }
    $index += 1
}

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

$Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
if (-not $Out -and $env:ASTRA_SUITE_OUT) { $Out = $env:ASTRA_SUITE_OUT }
if (-not $Out) { $Out = Join-Path $Root "out/full-suite-$Stamp" }
if (-not [System.IO.Path]::IsPathRooted($Out)) { $Out = Join-Path $Root $Out }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Out "tmp") | Out-Null
Write-Host "results: $Out"

# --- build resolution (same rules as tools/perf/stress/astra_env.py) --------
$IsWindowsHost = $true
if ($PSVersionTable.PSVersion.Major -ge 6) {
    $IsWindowsHost = $IsWindows
}
$DefaultObjdir = if ($IsWindowsHost) { "obj-astra-windows" } else { "obj-astra-linux" }
$Objdir = if ($env:ASTRA_OBJDIR) { $env:ASTRA_OBJDIR } else { $DefaultObjdir }
$Engine = if ($env:ASTRA_ENGINE) { $env:ASTRA_ENGINE } else { Join-Path $Root "engine/$Objdir" }
$BinaryName = if ($IsWindowsHost) { "firefox.exe" } else { "firefox" }
$Binary = if ($env:ASTRA_BINARY) { $env:ASTRA_BINARY } else { Join-Path $Engine "dist/bin/$BinaryName" }
$DriverName = if ($IsWindowsHost) { "geckodriver.exe" } else { "geckodriver" }
$Driver = if ($env:ASTRA_GECKODRIVER) { $env:ASTRA_GECKODRIVER } else { Join-Path $Engine "dist/host/bin/$DriverName" }

$Reason = $null
if (-not (Test-Path -PathType Leaf $Binary)) {
    $Reason = "browser binary not found: $Binary"
}
if (-not (Test-Path -PathType Container $Engine)) {
    Write-Host "WARN: engine objdir not found: $Engine"
}
$env:ASTRA_ENGINE = $Engine
$env:ASTRA_BINARY = $Binary
$env:ASTRA_GECKODRIVER = $Driver
$env:ASTRA_METADATA_AUTODETECT = "1"
$env:TMP = Join-Path $Out "tmp"
$env:TEMP = $env:TMP

Write-Host "engine: $Engine"
Write-Host "binary: $Binary"
if ($Reason) { Write-Host "WARN: $Reason" } else { Write-Host "driver: $Driver" }

# --- python -----------------------------------------------------------------
$Python = $null
foreach ($candidate in @(
        (Join-Path $Root ".venv/Scripts/python.exe"),
        (Join-Path $Root ".venv/bin/python")
    )) {
    if (Test-Path $candidate) { $Python = $candidate; break }
}
if (-not $Python) {
    $found = Get-Command python -ErrorAction SilentlyContinue
    if (-not $found) { $found = Get-Command python3 -ErrorAction SilentlyContinue }
    if ($found) { $Python = $found.Source }
}
if (-not $Python) { Write-Host "WARN: no python; live probes and state-check will SKIP" }

$Fail = 0
$Skip = 0
$Pass = 0
$Results = New-Object System.Collections.ArrayList
function Add-Result([string]$Kind, [string]$Name, [string]$Status, [string]$Detail, [double]$Seconds) {
    $null = $Results.Add([pscustomobject]@{
            kind = $Kind; name = $Name; status = $Status; detail = $Detail; seconds = $Seconds
        })
}

# --- build (opt-in) ---------------------------------------------------------
if ($Build) {
    Write-Host "== build: UI bundles + overlay + engine"
    Push-Location (Join-Path $Root "ui")
    & bun run --filter @astra/shell-hello build
    $rc = $LASTEXITCODE
    if ($rc -eq 0) { & bun run --filter @astra/frame build:chrome; $rc = $LASTEXITCODE }
    Pop-Location
    if ($rc -ne 0) { Write-Host "FAIL ui build"; exit 1 }
    Push-Location (Join-Path $Root "forge/astra-forge")
    & cargo run -q -- overlay
    $rc = $LASTEXITCODE
    # Never without --jobs 2: the libxul link peaks near 10 GB and this machine
    # has 31 GB, so the default job count OOMs the desktop (BUILD_TIMES.md).
    if ($rc -eq 0) { & cargo run -q -- build --os windows --faster --jobs 2; $rc = $LASTEXITCODE }
    Pop-Location
    if ($rc -ne 0) { Write-Host "FAIL engine build"; exit 1 }
} elseif ($SkipBuild) {
    Write-Host "== build: skipped (--skip-build)"
}

# --- contracts --------------------------------------------------------------
echo "== contracts"
# The suite list comes from run-all.mjs, which globs the directory. There is no
# second list to drift: a suite that exists is discovered. This runner still
# owns the per-suite log and result row.
$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
    Write-Host "FAIL node not found: the contract gate cannot run"
    exit 1
}
$Contracts = @(
    & node (Join-Path $Root "tests/contract/run-all.mjs") --list |
        Where-Object { $_ }
)
if ($Contracts.Count -eq 0) {
    Write-Host "FAIL no contract suites discovered by tests/contract/run-all.mjs"
    $Fail += 1
}
foreach ($name in $Contracts) {
    $path = Join-Path $Root "tests/contract/$name.mjs"
    $log = Join-Path $Out "contract-$name.log"
    if (-not (Test-Path $path)) {
        Write-Host "FAIL contract suite missing: $name"
        $Fail += 1
        Add-Result "contract" $name "FAIL" "file missing" 0
        continue
    }
    $started = Get-Date
    & node $path *> $log
    $rc = $LASTEXITCODE
    $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    if ($rc -eq 0) {
        Write-Host "PASS $name"
        $Pass += 1
        Add-Result "contract" $name "PASS" "" $seconds
    } elseif ($name -eq "sidecar_spike" -and (Select-String -Path $log -Pattern "sidecar-stub" -Quiet)) {
        Write-Host "SKIP $name (out/sidecar-stub not built; $log)"
        $Skip += 1
        Add-Result "contract" $name "SKIP" "out/sidecar-stub not built" $seconds
    } else {
        Write-Host "FAIL $name (see $log)"
        $Fail += 1
        Add-Result "contract" $name "FAIL" "exit $rc" $seconds
    }
}

# --- UI checks --------------------------------------------------------------
echo "== UI checks"
$Bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $Bun) {
    Write-Host "SKIP bun check (bun not installed)"
    $Skip += 1
    Add-Result "ui" "frame-check" "SKIP" "bun not installed" 0
} else {
    $started = Get-Date
    Push-Location (Join-Path $Root "ui")
    & bun run --filter @astra/frame check *> (Join-Path $Out "frame-check.log")
    $rc = $LASTEXITCODE
    Pop-Location
    $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    if ($rc -eq 0) {
        Write-Host "PASS frame check"
        $Pass += 1
        Add-Result "ui" "frame-check" "PASS" "" $seconds
    } else {
        Write-Host "FAIL frame check (see $Out/frame-check.log)"
        $Fail += 1
        Add-Result "ui" "frame-check" "FAIL" "exit $rc" $seconds
    }
}
$shellLog = Join-Path $Out "shell-unit.log"
$started = Get-Date
& node --test (Join-Path $Root "ui/shell/src") *> $shellLog
$rc = $LASTEXITCODE
$seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
if ($rc -eq 0) {
    Write-Host "PASS shell unit"
    $Pass += 1
    Add-Result "ui" "shell-unit" "PASS" "" $seconds
} else {
    Write-Host "FAIL shell unit (see $shellLog)"
    $Fail += 1
    Add-Result "ui" "shell-unit" "FAIL" "exit $rc" $seconds
}

# --- live probes ------------------------------------------------------------
if ($SkipLive) {
    Write-Host "== live probes: skipped (--skip-live)"
} elseif (-not $Python) {
    Write-Host "SKIP live probes (no python interpreter)"
    $Skip += 1
    Add-Result "probe" "all" "SKIP" "no python interpreter" 0
} else {
    Write-Host "== live probes ($Timeout s each, one at a time)"
    # Registered probes are the ones the sweep showed meaningful on Windows.
    # Stale expectations (search engine, .sidebar-edge, 240 px geometry,
    # ffmpeg fixtures) are in out/audit/findings/probes.md; register one again
    # only after it is repaired.
    $Probes = [ordered]@{
        "shell_app_chrome"      = "tests/contract/shell_app_chrome.py"
        "stage"                 = "tools/perf/stress/gbrowser_stage_probe.py"
        "tabs"                  = "tools/perf/stress/gbrowser_tabs_probe.py"
        "p43"                   = "tools/perf/stress/gbrowser_p43_probe.py"
        "multiwindow"           = "tools/perf/stress/gbrowser_multiwindow_probe.py"
        "multi_window_isolation" = "tools/marionette-probe/multi-window-isolation-probe.py"
        "downloads_lifecycle"   = "tools/marionette-probe/downloads-lifecycle-probe.py"
        "downloads_history"     = "tools/marionette-probe/downloads-history-probe.py"
        "gallery"               = "tools/marionette-probe/gallery-probe.py"
        "tab_order"             = "tools/marionette-probe/tab-order-probe.py"
        "tabs_churn"            = "tools/marionette-probe/tabs-churn-probe.py"
        "split_view"            = "tools/marionette-probe/split-view-probe.py"
        "sessionstore"          = "tools/perf/stress/sessionstore_probe.py"
        "containers_space"      = "tools/perf/stress/containers_space_probe.py"
        "containers_private"    = "tools/perf/stress/containers_private_move_probe.py"
        "native_nav"            = "tools/perf/stress/native_nav_probe.py"
        "native_windows"        = "tools/perf/stress/native_windows_probe.py"
        "permissions_store"     = "tools/perf/stress/permissions_store_probe.py"
        "permission_prompt"     = "tools/perf/stress/permission_prompt_probe.py"
        "webrtc"                = "tools/perf/stress/webrtc_permission_probe.py"
        "metadata_restore"      = "tools/perf/stress/metadata_restore_probe.py"
        "metadata_owner"        = "tools/perf/stress/metadata_owner_probe.py"
        "page_source"           = "tools/perf/stress/page_source_probe.py"
        "certificate"           = "tools/perf/stress/certificate_probe.py"
        "http_auth"             = "tools/perf/stress/http_auth_probe.py"
        "media"                 = "tools/perf/stress/media_player_probe.py"
        "now_playing"           = "tools/marionette-probe/now-playing-probe.py"
        "media_card"            = "tools/marionette-probe/media-card-probe.py"
        "pip_player"            = "tools/marionette-probe/pip-player-probe.py"
        "webext"                = "tools/perf/stress/webext_probe.py"
        "webext_prompt"         = "tools/perf/stress/webext_prompt_probe.py"
        "webext_ui"             = "tools/perf/stress/webext_ui_probe.py"
        "passkeys"              = "tools/marionette-probe/passkeys-probe.py"
        "devtools"              = "tools/perf/stress/devtools_probe.py"
        "first_load"            = "tools/perf/stress/first_load_probe.py"
        "settings_native"       = "tools/marionette-probe/settings-native-probe.py"
        "settings_restart"      = "tools/marionette-probe/settings-restart-probe.py"
        "settings_audit"        = "tools/marionette-probe/settings-audit-probe.py"
        "settings_parity"       = "tools/marionette-probe/settings-parity-probe.py"
        "blocker"               = "tools/marionette-probe/blocker-probe.py"
        "blocker_lifecycle"     = "tools/marionette-probe/blocker-refresh-probe.py"
        "superadblock"          = "tools/marionette-probe/superadblock-probe.py"
        "adblocktester"         = "tools/marionette-probe/adblocktester-probe.py"
        "shields"               = "tools/marionette-probe/shields-probe.py"
        "fingerprint"           = "tools/marionette-probe/fingerprint-probe.py"
        "material_zoom_home"    = "tools/marionette-probe/material-zoom-home-probe.py"
        "profiles_switch"       = "tools/marionette-probe/profiles-switch-probe.py"
        "search_theme"          = "tools/marionette-probe/search-theme-probe.py"
        "native_surfaces"       = "tools/marionette-probe/native-surfaces-probe.py"
        "owner_report"          = "tools/marionette-probe/owner-report-probe.py"
        "sidebar_shield"        = "tools/marionette-probe/sidebar-shield-probe.py"
        "sidebar_card_head"     = "tools/marionette-probe/sidebar-card-head-probe.py"
        "surface_park"          = "tools/marionette-probe/surface-park-probe.py"
        "surface_registry"      = "tools/marionette-probe/surface-registry-probe.py"
        "notes"                 = "tools/marionette-probe/notes-probe.py"
        "theme"                 = "tools/marionette-probe/theme-probe.py"
        "version"               = "tools/marionette-probe/version-probe.py"
        "work_off"              = "tools/marionette-probe/work-off-probe.py"
        "tab_switch_seam"       = "tools/marionette-probe/tab-switch-seam-probe.py"
  "tab_reassert"          = "tools/marionette-probe/tab-reassert-probe.py"
        "popup_window"          = "tools/marionette-probe/popup-window-probe.py"
        "sidebar_strip"         = "tools/marionette-probe/sidebar-strip-probe.py"
        "fullscreen"            = "tools/marionette-probe/fullscreen-probe.py"
        "chrome_ext"            = "tools/perf/stress/chrome_ext_probe.py"
        "real_extensions"       = "tools/perf/stress/real_extensions_probe.py"
        "extension_bench"       = "tools/perf/stress/extension_bench.py"
        "corpus"                = "tools/perf/stress/extension_corpus_probe.py"
    }
    foreach ($name in $Probes.Keys) {
        $relative = $Probes[$name]
        $path = Join-Path $Root $relative
        if (-not (Test-Path $path)) {
            Write-Host "FAIL $name (probe script missing: $relative)"
            $Fail += 1
            Add-Result "probe" $name "FAIL" "script missing: $relative" 0
            continue
        }
        if ($Reason) {
            Write-Host "SKIP $name ($Reason)"
            $Skip += 1
            Add-Result "probe" $name "SKIP" $Reason 0
            continue
        }
        $stdout = Join-Path $Out "probe-$name.json"
        $stderr = Join-Path $Out "probe-$name.err"
        $quoted = '"' + $path + '"'
        $started = Get-Date
        $proc = Start-Process -FilePath $Python -ArgumentList $quoted -NoNewWindow -PassThru `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $rc = $null
        if (-not $proc.WaitForExit($Timeout * 1000)) {
            & taskkill.exe /PID $proc.Id /T /F *> $null
            $rc = 124
        } else {
            $proc.WaitForExit()
            $rc = $proc.ExitCode
        }
        $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
        if ($rc -eq 0) {
            Write-Host "PASS $name ($seconds s)"
            $Pass += 1
            Add-Result "probe" $name "PASS" "" $seconds
        } elseif ($rc -eq 2) {
            $why = ""
            if (Test-Path $stderr) {
                $why = (Get-Content $stderr -TotalCount 3 | Where-Object { $_ -match "SKIP" } | Select-Object -First 1)
            }
            if (-not $why) { $why = "exit 2 (environment)" }
            Write-Host "SKIP $name ($why; $seconds s)"
            $Skip += 1
            Add-Result "probe" $name "SKIP" $why $seconds
        } elseif ($rc -eq 124) {
            Write-Host "FAIL $name (timeout ${Timeout}s; $stderr)"
            $Fail += 1
            Add-Result "probe" $name "FAIL" "timeout ${Timeout}s" $seconds
        } else {
            Write-Host "FAIL $name (rc=$rc, $seconds s; $stdout)"
            $Fail += 1
            Add-Result "probe" $name "FAIL" "exit $rc" $seconds
        }
    }
}

# --- benches ----------------------------------------------------------------
if ($SkipPerf -or $SkipLive) {
    if ($SkipLive) { Write-Host "== performance benches: skipped (--skip-live)" }
    else { Write-Host "== performance benches: skipped (--skip-perf)" }
} elseif ($Python) {
    Write-Host "== performance benches"
    & $Python (Join-Path $Root "tools/perf/run_all.py") --runs 1 --out (Join-Path $Root "out/perf-full-suite") *> (Join-Path $Out "perf.log")
    if ($LASTEXITCODE -ne 0) { Write-Host "WARN performance benches reported a failure (see $Out/perf.log)" }
} else {
    Write-Host "SKIP performance benches (no python)"
    $Skip += 1
}

# --- lint/state -------------------------------------------------------------
echo "== lint/state"
if ($Python) {
    & $Python (Join-Path $Root "tools/state-check.py")
    if ($LASTEXITCODE -ne 0) { $Fail += 1 }
} else {
    Write-Host "SKIP state-check (no python)"
    $Skip += 1
}
$brandLint = Join-Path $Root "tools/brand-lint.sh"
$Bash = Get-Command bash -ErrorAction SilentlyContinue
if ($Bash -and (Test-Path $brandLint)) {
    & bash $brandLint
    if ($LASTEXITCODE -ne 0) { $Fail += 1 }
} else {
    Write-Host "SKIP brand-lint (bash or script not available)"
    $Skip += 1
}

# --- summary ----------------------------------------------------------------
$Summary = @(
    "full-suite (windows) $Stamp",
    "engine: $Engine",
    "binary: $Binary",
    "pass: $Pass  fail: $Fail  skip: $Skip",
    ""
)
foreach ($kind in @("contract", "ui", "probe")) {
    foreach ($row in $Results) {
        if ($row.kind -eq $kind) {
            $line = "{0,-6} {1,-8} {2}" -f $row.status, $row.kind, $row.name
            if ($row.detail) { $line += " - " + $row.detail }
            $Summary += $line
        }
    }
}
$Summary | Set-Content -Path (Join-Path $Out "summary.txt") -Encoding UTF8
$Results | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $Out "results.json") -Encoding UTF8

if ($Fail -ne 0) {
    Write-Host "FULL SUITE: FAIL ($Fail failed, $Skip skipped; results in $Out)"
    exit 1
}
Write-Host "FULL SUITE: PASS ($Skip skipped by environment; results in $Out)"
exit 0
