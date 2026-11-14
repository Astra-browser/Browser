# Verify that sccache is actually caching C/C++ and Rust compiles, survives
# concurrent clients, and leaves a live server behind.
#
#   .\tools\windows\sccache-smoke.ps1
#
# Exits 0 on PASS, 1 on any failed assertion. Safe to run while a build is
# running: it only resets counters, not cache entries.
param(
    [string]$CacheDir = $(if ($env:SCCACHE_DIR) { $env:SCCACHE_DIR } else { 'D:\astra-build\sccache' })
)

$ErrorActionPreference = 'Stop'
$env:SCCACHE_DIR = $CacheDir
$env:SCCACHE_LOG = 'warn'
$env:SCCACHE_ERROR_LOG = Join-Path $CacheDir 'smoke-error.log'
New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

$sccache = (Get-Command sccache -ErrorAction Stop).Source
$rustc = (Get-Command rustc -ErrorAction Stop).Source
$dir = Join-Path $env:TEMP ("astra-sccache-smoke-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function Get-Stat {
    param([string]$Name)
    $stats = & $sccache --show-stats 2>$null
    $line = $stats | Select-String -Pattern ("^" + [regex]::Escape($Name) + "\s+(\d+)") |
        Select-Object -First 1
    if ($line) { return [int]$line.Matches[0].Groups[1].Value }
    return 0
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "FAIL: $Message" }
}

try {
    # A running server makes `--start-server` exit nonzero with "Address in
    # use"; that is success for this check, so start it via Start-Process and
    # then probe the stats endpoint.
    Start-Process -FilePath $sccache -ArgumentList '--start-server' -NoNewWindow -Wait `
        -RedirectStandardOutput (Join-Path $dir 'start.out') `
        -RedirectStandardError (Join-Path $dir 'start.err') | Out-Null
    & $sccache --show-stats 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'FAIL: sccache server is not reachable' }
    & $sccache --zero-stats | Out-Null

    Set-Content -Path (Join-Path $dir 'hello.c') -Value 'int main(void) { return 0; }' -Encoding Ascii
    Push-Location $dir
    try {
        & $sccache clang-cl /c hello.c /Fohello.obj | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'FAIL: first C compile failed' }
        Remove-Item hello.obj -Force
        & $sccache clang-cl /c hello.c /Fohello.obj | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'FAIL: second C compile failed' }
        $cHits = Get-Stat 'Cache hits (C/C++)'
        Assert-True ($cHits -ge 1) "expected a C/C++ cache hit, got $cHits"

        Set-Content -Path (Join-Path $dir 'lib.rs') -Value 'pub fn answer() -> u32 { 42 }' -Encoding Ascii
        & $sccache $rustc --crate-name sccache_smoke --edition=2021 lib.rs --crate-type lib --emit=dep-info,metadata,link --out-dir . | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'FAIL: first Rust compile failed' }
        Get-ChildItem *.rmeta,*.rlib,*.d -ErrorAction SilentlyContinue | Remove-Item -Force
        & $sccache $rustc --crate-name sccache_smoke --edition=2021 lib.rs --crate-type lib --emit=dep-info,metadata,link --out-dir . | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'FAIL: second Rust compile failed' }
        $rustHits = Get-Stat 'Cache hits (Rust)'
        Assert-True ($rustHits -ge 1) "expected a Rust cache hit, got $rustHits"

        1..8 | ForEach-Object { Set-Content -Path (Join-Path $dir "p$_.c") -Value "int f$_(void) { return $_; }" -Encoding Ascii }
        $parallel = 1..8 | ForEach-Object {
            Start-Process -FilePath $sccache -ArgumentList "clang-cl /c p$_.c /Fop$_.obj" `
                -WorkingDirectory $dir -NoNewWindow -PassThru
        }
        $parallel | Wait-Process
        $failed = @($parallel | Where-Object { $null -ne $_.ExitCode -and $_.ExitCode -ne 0 })
        $missing = @(1..8 | Where-Object { -not (Test-Path (Join-Path $dir "p$_.obj")) })
        Assert-True ($failed.Count -eq 0 -and $missing.Count -eq 0) `
            "parallel first pass failures=$($failed.Count) missing_objects=$($missing.Count)"

        Remove-Item (Join-Path $dir 'p*.obj') -Force
        $parallel = 1..8 | ForEach-Object {
            Start-Process -FilePath $sccache -ArgumentList "clang-cl /c p$_.c /Fop$_.obj" `
                -WorkingDirectory $dir -NoNewWindow -PassThru
        }
        $parallel | Wait-Process
        $failed = @($parallel | Where-Object { $null -ne $_.ExitCode -and $_.ExitCode -ne 0 })
        $missing = @(1..8 | Where-Object { -not (Test-Path (Join-Path $dir "p$_.obj")) })
        Assert-True ($failed.Count -eq 0 -and $missing.Count -eq 0) `
            "parallel second pass failures=$($failed.Count) missing_objects=$($missing.Count)"
        $cHitsFinal = Get-Stat 'Cache hits (C/C++)'
        Assert-True ($cHitsFinal -ge 9) "expected >=9 C/C++ hits after the parallel pass, got $cHitsFinal"
    }
    finally {
        Pop-Location
    }

    Assert-True ([bool](Get-Process sccache -ErrorAction SilentlyContinue)) 'sccache server is not running'
    Write-Host 'sccache-smoke: PASS (C/C++ hit, Rust hit, 16 concurrent compiles, server alive)'
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
finally {
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
}
