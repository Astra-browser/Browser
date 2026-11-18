; Astra per-user Windows installer (NSIS 3.x).
;
; Built by tools/package-windows.ps1 -Installer:
;   makensis /DVERSION=... /DSTAGE=<staged Astra> /DOUT=<release dir> \
;            /DOUTFILE=... /DICON=... tools/windows/astra-installer.nsi
;
; Per-user only: RequestExecutionLevel user, SetShellVarContext current,
; $LOCALAPPDATA\Programs\Astra. No service, no machine-wide registry write.

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef STAGE
  !error "STAGE is required"
!endif
!ifndef OUT
  !define OUT "."
!endif
!ifndef OUTFILE
  !define OUTFILE "Astra-${VERSION}-windows-x86_64-setup.exe"
!endif
!ifndef ICON
  !define ICON ""
!endif

Name "Astra ${VERSION}"
OutFile "${OUT}\${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Astra"
InstallDirRegKey HKCU "Software\Astra" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
BrandingText "Astra ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Astra"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "Astra browser installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Astra"

!define MUI_ABORTWARNING
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_WELCOMEPAGE_TITLE "Install Astra ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "Astra installs for the current user only. No administrator rights are needed.$\r$\n$\r$\nThe browser, the astra-core sidecar and the Windows packaging files are copied to $\"$LOCALAPPDATA\Programs\Astra$\". Your profile stays in $\"%APPDATA%\Astra$\" and is kept when you uninstall."
!define MUI_FINISHPAGE_RUN "$INSTDIR\astra.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "-profile $\"$APPDATA\Astra\Profiles\default$\" -no-remote"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Astra"
!define MUI_FINISHPAGE_LINK "Open Windows default apps to choose Astra"
!define MUI_FINISHPAGE_LINK_LOCATION "ms-settings:defaultapps"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

!macro WriteAppCommand ROOT
  WriteRegStr HKCU "${ROOT}\shell\open\command" "" "$\"$INSTDIR\astra.exe$\" -profile $\"$APPDATA\Astra\Profiles\default$\" -no-remote $\"%1$\""
!macroend

Function .onInit
  ; A silent install can pre-select the directory with /D=... (NSIS contract:
  ; /D must be the last argument and is not quoted).
  SetShellVarContext current
FunctionEnd

Section "Astra" SEC_MAIN
  SetShellVarContext current
  SetOutPath "$INSTDIR"

  ; The whole dist/bin tree, including chrome/astra, defaults, distribution,
  ; mozilla.cfg and astra-core.exe. Never stage a partial browser.
  File /r "${STAGE}\*.*"

  CreateDirectory "$APPDATA\Astra\Profiles\default"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; --- shortcuts -----------------------------------------------------------
  CreateDirectory "$SMPROGRAMS\Astra"
  CreateShortCut "$SMPROGRAMS\Astra\Astra.lnk" "$INSTDIR\astra.exe" \
    '-profile "$APPDATA\Astra\Profiles\default" -no-remote' \
    "$INSTDIR\astra.exe" 0 SW_SHOWNORMAL
  CreateShortCut "$SMPROGRAMS\Astra\Uninstall Astra.lnk" "$INSTDIR\uninstall.exe"
  CreateShortCut "$DESKTOP\Astra.lnk" "$INSTDIR\astra.exe" \
    '-profile "$APPDATA\Astra\Profiles\default" -no-remote' \
    "$INSTDIR\astra.exe" 0 SW_SHOWNORMAL

  ; --- install record ------------------------------------------------------
  WriteRegStr HKCU "Software\Astra" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Astra" "Version" "${VERSION}"
  WriteRegStr HKCU "Software\Astra" "ProfileDir" "$APPDATA\Astra\Profiles\default"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Astra" \
    "DisplayName" "Astra"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Astra" \
    "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Astra" \
    "DisplayIcon" "$INSTDIR\astra.exe,0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Astra" \
    "Publisher" "Astra"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Astra" \
    "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Astra" \
    "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Astra" \
    "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Astra" \
    "NoRepair" 1

  ; --- ProgId, capabilities and default-browser registration ---------------
  WriteRegStr HKCU "Software\Classes\AstraHTML" "" "Astra HTML Document"
  WriteRegStr HKCU "Software\Classes\AstraHTML" "FriendlyTypeName" "Astra HTML Document"
  WriteRegStr HKCU "Software\Classes\AstraHTML\DefaultIcon" "" "$INSTDIR\astra.exe,0"
  !insertmacro WriteAppCommand "Software\Classes\AstraHTML"

  WriteRegStr HKCU "Software\Classes\AstraURL" "" "Astra URL"
  WriteRegStr HKCU "Software\Classes\AstraURL" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\AstraURL\DefaultIcon" "" "$INSTDIR\astra.exe,0"
  !insertmacro WriteAppCommand "Software\Classes\AstraURL"

  ; Open-with entries, never a forced default: Windows still owns the choice.
  WriteRegStr HKCU "Software\Classes\.html\OpenWithProgids" "AstraHTML" ""
  WriteRegStr HKCU "Software\Classes\.htm\OpenWithProgids" "AstraHTML" ""
  WriteRegStr HKCU "Software\Classes\.xhtml\OpenWithProgids" "AstraHTML" ""
  WriteRegStr HKCU "Software\Classes\.shtml\OpenWithProgids" "AstraHTML" ""

  WriteRegStr HKCU "Software\RegisteredApplications" "Astra" "Software\Astra\Capabilities"
  WriteRegStr HKCU "Software\Astra\Capabilities" "ApplicationName" "Astra"
  WriteRegStr HKCU "Software\Astra\Capabilities" "ApplicationDescription" "Browse the web with Astra"
  WriteRegStr HKCU "Software\Astra\Capabilities" "ApplicationIcon" "$INSTDIR\astra.exe,0"
  WriteRegStr HKCU "Software\Astra\Capabilities\FileAssociations" ".html" "AstraHTML"
  WriteRegStr HKCU "Software\Astra\Capabilities\FileAssociations" ".htm" "AstraHTML"
  WriteRegStr HKCU "Software\Astra\Capabilities\FileAssociations" ".xhtml" "AstraHTML"
  WriteRegStr HKCU "Software\Astra\Capabilities\FileAssociations" ".shtml" "AstraHTML"
  WriteRegStr HKCU "Software\Astra\Capabilities\URLAssociations" "http" "AstraURL"
  WriteRegStr HKCU "Software\Astra\Capabilities\URLAssociations" "https" "AstraURL"

  ; AppUserModelID registration for the exe (taskbar grouping, notifications).
  WriteRegStr HKCU "Software\Classes\Applications\astra.exe\Application" "ApplicationName" "Astra"
  WriteRegStr HKCU "Software\Classes\Applications\astra.exe\Application" "ApplicationIcon" "$INSTDIR\astra.exe,0"
  WriteRegStr HKCU "Software\Classes\Applications\astra.exe\Application" "AppUserModelID" "Astra.Browser"
  !insertmacro WriteAppCommand "Software\Classes\Applications\astra.exe"
  WriteRegStr HKCU "Software\Classes\Applications\astra.exe\SupportedTypes" ".html" ""
  WriteRegStr HKCU "Software\Classes\Applications\astra.exe\SupportedTypes" ".htm" ""
  WriteRegStr HKCU "Software\Classes\Applications\astra.exe\SupportedTypes" ".xhtml" ""

  ; Refresh the shell so Open-with and Default apps see the new ProgId.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'

  ; Warm the executable cache and the fresh profile once. Without this the
  ; first launch pays Windows' first-scan and profile-creation cost (8-10 s
  ; measured); the headless screenshot exits without showing a window.
  nsExec::ExecToLog '"$INSTDIR\astra.exe" --headless --screenshot "$TEMP\astra-warm.png" -profile "$APPDATA\Astra\Profiles\default" about:blank'
  Delete "$TEMP\astra-warm.png"
SectionEnd

Section "Uninstall"
  SetShellVarContext current

  Delete "$SMPROGRAMS\Astra\Astra.lnk"
  Delete "$SMPROGRAMS\Astra\Uninstall Astra.lnk"
  RMDir "$SMPROGRAMS\Astra"
  Delete "$DESKTOP\Astra.lnk"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Astra"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Astra"
  DeleteRegKey HKCU "Software\Astra\Capabilities"
  DeleteRegKey HKCU "Software\Astra"
  DeleteRegKey HKCU "Software\Classes\AstraHTML"
  DeleteRegKey HKCU "Software\Classes\AstraURL"
  DeleteRegKey HKCU "Software\Classes\Applications\astra.exe"
  DeleteRegValue HKCU "Software\Classes\.html\OpenWithProgids" "AstraHTML"
  DeleteRegValue HKCU "Software\Classes\.htm\OpenWithProgids" "AstraHTML"
  DeleteRegValue HKCU "Software\Classes\.xhtml\OpenWithProgids" "AstraHTML"
  DeleteRegValue HKCU "Software\Classes\.shtml\OpenWithProgids" "AstraHTML"

  RMDir /r "$INSTDIR"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
SectionEnd

Function .onInstSuccess
  ; No forced default. The finish page links to Settings > Default apps.
FunctionEnd
