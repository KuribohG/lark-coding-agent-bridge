; Lark Channel Bridge - per-user Windows installer.
;
; Built by installer/build.ps1:
;   /DVERSION=<display version>
;   /DPRODUCTVERSION=<a.b.c.d>
;   /DSTAGE=<staged payload directory>
;   /DOUTFILE=<output .exe>
;
; Per-user (RequestExecutionLevel user): no UAC prompt, installs under
; %LOCALAPPDATA%, writes only HKCU and the user's Task Scheduler tasks.

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef PRODUCTVERSION
  !define PRODUCTVERSION "0.0.0.0"
!endif
!ifndef STAGE
  !error "STAGE is required (pass /DSTAGE=...)"
!endif
!ifndef OUTFILE
  !define OUTFILE "LarkChannelBridge-Setup-${VERSION}.exe"
!endif

!define APP_NAME "Lark Channel Bridge"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\LarkChannelBridge"

Name "${APP_NAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\LarkChannelBridge"
InstallDirRegKey HKCU "Software\LarkChannelBridge" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
CRCCheck on
XPStyle on
BrandingText "${APP_NAME}"

VIProductVersion "${PRODUCTVERSION}"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "${APP_NAME} installer"
VIAddVersionKey "LegalCopyright" "MIT"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_TEXT "Configuration is kept in %USERPROFILE%\.lark-channel.$\r$\n$\r$\nDouble-click ${APP_NAME} (Start Menu or Desktop) to run it in the notification area. Right-click the tray icon to open the console or exit."
!define MUI_FINISHPAGE_RUN "$INSTDIR\bin\LarkChannelBridgeTray.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Run ${APP_NAME} now (tray icon)"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Var ServiceRecord

Function .onInit
  ; The uninstaller is not signed; keep the classic NSIS behaviour.
FunctionEnd

Section "Install"
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "stop-existing.ps1"
  File "post-install.ps1"
  File "path-manager.ps1"
  StrCpy $ServiceRecord "$PLUGINSDIR\old-services.json"

  ; 1. Stop and unregister every previous service, kill leftover bridge node
  ;    processes, and remove an old npm/pnpm global install.  The record file
  ;    lets us recreate the same services with the new paths.
  DetailPrint "Stopping previous ${APP_NAME}..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-existing.ps1" -InstallDir "$INSTDIR" -RecordPath "$ServiceRecord"'
  Pop $R0
  DetailPrint "stop-existing exit code: $R0"
  Sleep 500

  ; 2. Remove the old payload.  Keep unrelated files the user may have put here.
  SetOutPath "$TEMP"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\bin"
  Delete "$INSTDIR\uninstall.exe"

  ; 3. Install the new payload.
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; 4. Uninstall entry (per-user, no admin).
  WriteRegStr HKCU "Software\LarkChannelBridge" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "lark-channel-bridge"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\bin\LarkChannelBridgeTray.exe,0"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ; 5. Start Menu and Desktop shortcuts.  The primary entry is the tray
  ;    launcher: double-click -> background supervisor -> tray icon.
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\bin\LarkChannelBridgeTray.exe" "" "$INSTDIR\bin\LarkChannelBridgeTray.exe" 0
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\bin\LarkChannelBridgeTray.exe" "" "$INSTDIR\bin\LarkChannelBridgeTray.exe" 0
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME} (foreground).lnk" "$INSTDIR\bin\run-lark-cc-fg.cmd" "" "$INSTDIR\bin\run-lark-cc-fg.cmd" 0
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Stop GUI supervisor.lnk" "$INSTDIR\bin\stop-gui.cmd" "" "$INSTDIR\bin\stop-gui.cmd" 0
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk" "$INSTDIR\uninstall.exe"

  ; 6. Put the shims on the user's PATH (prepended so a stale global shim
  ;    cannot win) and restore the services that were running before.
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\path-manager.ps1" -InstallDir "$INSTDIR" -Action add'
  Pop $R0
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\post-install.ps1" -InstallDir "$INSTDIR" -RecordPath "$ServiceRecord"'
  Pop $R0
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "stop-existing.ps1"
  File "path-manager.ps1"

  DetailPrint "Stopping ${APP_NAME}..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-existing.ps1" -InstallDir "$INSTDIR" -RecordPath "$PLUGINSDIR\uninstall-services.json" -SkipPackageManagers'
  Pop $R0
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\path-manager.ps1" -InstallDir "$INSTDIR" -Action remove'
  Pop $R0

  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\*.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKCU "Software\LarkChannelBridge"
  DeleteRegKey HKCU "${UNINST_KEY}"

  ; Keep profiles/secrets/sessions by default.  Only remove them when the user
  ; explicitly says yes; silent uninstall keeps them too.
  IfSilent keep_config
  MessageBox MB_YESNO|MB_ICONQUESTION "Also delete %USERPROFILE%\.lark-channel?$\r$\n$\r$\nThis removes profiles, secrets, sessions and logs. Choose No to keep them for a later reinstall." IDNO keep_config
  StrCmp $PROFILE "" keep_config
  RMDir /r "$PROFILE\.lark-channel"

keep_config:
  SetOutPath "$TEMP"
  RMDir /r "$INSTDIR"
SectionEnd
