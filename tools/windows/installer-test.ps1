# Install, verify and uninstall the per-user Astra Windows setup.
#
#   .\tools\windows\installer-test.ps1 -Setup out\release\Astra-*-setup.exe
#   .\tools\windows\installer-test.ps1 -Setup ... -KeepInstalled
#
# Uses a throwaway install directory under out\installer-test so it never
# touches the user's real Astra install. Registry writes and shortcuts are the
# installer's own and are removed by its silent uninstaller.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Setup,
    [string]$InstallDir = '',
    [switch]$KeepInstalled,
    [switch]$RunProbe
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Setup = (Resolve-Path $Setup).Path
if (-not $InstallDir) { $InstallDir = Join-Path $root 'out\installer-test\Astra' }
if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }

$failures = @()
function Check($name, $ok, $detail = '') {
    Write-Host (("{0} {1} {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail)).TrimEnd()
    if (-not $ok) { $script:failures += $name }
}

Write-Host "== install $Setup -> $InstallDir"
$proc = Start-Process -FilePath $Setup -ArgumentList '/S', "/D=$InstallDir" -Wait -PassThru
Check 'installer exits 0' ($proc.ExitCode -eq 0) "exit=$($proc.ExitCode)"
Check 'astra.exe is installed' (Test-Path (Join-Path $InstallDir 'astra.exe'))
Check 'firefox.exe is installed' (Test-Path (Join-Path $InstallDir 'firefox.exe'))
Check 'astra-core.exe is installed' (Test-Path (Join-Path $InstallDir 'astra-core.exe'))
Check 'uninstaller is written' (Test-Path (Join-Path $InstallDir 'uninstall.exe'))
Check 'profile directory exists' (Test-Path (Join-Path $env:APPDATA 'Astra\Profiles\default'))

$install = Get-ItemProperty 'HKCU:\Software\Astra' -ErrorAction SilentlyContinue
Check 'install record names the directory' ($install.InstallDir -eq $InstallDir) "$($install.InstallDir)"
Check 'install record names the version' ([bool]$install.Version) "$($install.Version)"
$registered = (Get-ItemProperty 'HKCU:\Software\RegisteredApplications' -ErrorAction SilentlyContinue).Astra
Check 'default apps capability is registered' ($registered -eq 'Software\Astra\Capabilities') "$registered"
Check 'HTML ProgId command exists' (Test-Path 'HKCU:\Software\Classes\AstraHTML\shell\open\command')
Check 'URL ProgId command exists' (Test-Path 'HKCU:\Software\Classes\AstraURL\shell\open\command')
$appId = (Get-ItemProperty 'HKCU:\Software\Classes\Applications\astra.exe\Application' -ErrorAction SilentlyContinue).AppUserModelID
Check 'AppUserModelID is registered' ($appId -eq 'Astra.Browser') "$appId"

$programs = [Environment]::GetFolderPath('Programs')
$desktop = [Environment]::GetFolderPath('Desktop')
Check 'Start Menu shortcut exists' (Test-Path (Join-Path $programs 'Astra\Astra.lnk'))
Check 'desktop shortcut exists' (Test-Path (Join-Path $desktop 'Astra.lnk'))

if ($RunProbe) {
    Write-Host '== live version probe against the installed binary'
    & python (Join-Path $root 'tools\marionette-probe\version-probe.py') (Join-Path $InstallDir 'astra.exe')
    Check 'installed build passes the live version probe' ($LASTEXITCODE -eq 0)
}

if ($KeepInstalled) {
    Write-Host "kept installed at $InstallDir (remove with its uninstall.exe /S)"
} else {
    Write-Host '== uninstall'
    $un = Start-Process -FilePath (Join-Path $InstallDir 'uninstall.exe') -ArgumentList '/S' -Wait -PassThru
    Start-Sleep -Seconds 2
    Check 'uninstaller exits 0' ($un.ExitCode -eq 0) "exit=$($un.ExitCode)"
    Check 'install directory removed' (-not (Test-Path $InstallDir))
    Check 'Start Menu entry removed' (-not (Test-Path (Join-Path $programs 'Astra')))
    Check 'desktop shortcut removed' (-not (Test-Path (Join-Path $desktop 'Astra.lnk')))
    Check 'install record removed' (-not (Test-Path 'HKCU:\Software\Astra'))
    Check 'capability registration removed' (-not ((Get-ItemProperty 'HKCU:\Software\RegisteredApplications' -ErrorAction SilentlyContinue).Astra))
    Check 'HTML ProgId removed' (-not (Test-Path 'HKCU:\Software\Classes\AstraHTML'))
    Check 'URL ProgId removed' (-not (Test-Path 'HKCU:\Software\Classes\AstraURL'))
    Check 'Astra app identity removed' (-not (Test-Path 'HKCU:\Software\Classes\Applications\astra.exe'))
}

$result = if ($failures.Count -eq 0) { 'PASS' } else { 'FAIL (' + ($failures -join ', ') + ')' }
Write-Host "`n$result"
if ($failures.Count -ne 0) { exit 1 }
