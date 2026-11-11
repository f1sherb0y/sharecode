; Current-user installer of the customer client. It keeps the Tauri installer's
; registry key, install directory and command line (/P passive, /R restart the
; client afterwards, /UPDATE), so an installed Tauri client updates into this one.
; Built by build-windows.ps1, which passes the SC_* definitions.
Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define SC_UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SC_NAME}"
!define WEBVIEW2_CLIENT "Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

Name "${SC_NAME}"
OutFile "${SC_OUTPUT}"
InstallDir "$LOCALAPPDATA\${SC_NAME}"
Icon "${SC_ICON}"
UninstallIcon "${SC_ICON}"
VIProductVersion "${SC_VERSION}.0"
VIAddVersionKey "ProductName" "${SC_NAME}"
VIAddVersionKey "CompanyName" "ShareCode"
VIAddVersionKey "FileVersion" "${SC_VERSION}"
VIAddVersionKey "FileDescription" "${SC_NAME} Installer"
VIAddVersionKey "LegalCopyright" "ShareCode"

Var Passive
Var RestartApp

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${SC_EXE}"
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

LangString ClosePrompt ${LANG_ENGLISH} "${SC_NAME} is running. Close it to continue?"
LangString ClosePrompt ${LANG_SIMPCHINESE} "${SC_NAME} 正在运行。关闭客户端并继续？"
LangString CloseFailure ${LANG_ENGLISH} "Unable to close ${SC_NAME}. Close it yourself and try again."
LangString CloseFailure ${LANG_SIMPCHINESE} "无法关闭 ${SC_NAME}。请关闭客户端后重试。"
LangString WebViewFailure ${LANG_ENGLISH} "WebView2 could not be installed. Check your connection and try again."
LangString WebViewFailure ${LANG_SIMPCHINESE} "无法安装 WebView2，请检查网络后重试。"

Function .onInit
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/P" $1
  ${IfNot} ${Errors}
    StrCpy $Passive 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/R" $1
  ${IfNot} ${Errors}
    StrCpy $RestartApp 1
  ${EndIf}
  ; Install over the existing copy unless /D= chose a directory. The Tauri
  ; installer wrote InstallLocation in quotes.
  ClearErrors
  ${GetOptions} $0 "/D=" $1
  ${If} ${Errors}
    ReadRegStr $1 HKCU "${SC_UNINST}" "InstallLocation"
    StrCpy $2 $1 1
    ${If} $2 == '"'
      StrCpy $1 $1 -1 1
    ${EndIf}
    ${If} $1 != ""
      StrCpy $INSTDIR $1
    ${EndIf}
  ${EndIf}
  ${If} $Passive != 1
    !insertmacro MUI_LANGDLL_DISPLAY
  ${EndIf}
FunctionEnd

Function SkipIfPassive
  ${If} $Passive == 1
    Abort
  ${EndIf}
FunctionEnd

; Closes the client running from $INSTDIR and waits for it to exit. Only its
; main window gets WM_CLOSE, so it shuts down properly (it restores meeting
; windows on the way out): MyGo and Tao both keep a hidden helper window whose
; closing would leave the process running without an event loop. The window
; classes are MyGo's and Tao's.
!macro CloseAppFunction PREFIX
Function ${PREFIX}CloseApp
  Call ${PREFIX}AppIsRunning
  Pop $0
  ${If} $0 == 0
    Return
  ${EndIf}
  ${If} $Passive != 1
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(ClosePrompt)" /SD IDOK IDOK +2
    Abort
  ${EndIf}
  Push "MyGoWindow"
  Call ${PREFIX}CloseWindowsOfClass
  Push "Window Class"
  Call ${PREFIX}CloseWindowsOfClass
  ${For} $1 1 150
    Call ${PREFIX}AppIsRunning
    Pop $0
    ${If} $0 == 0
      Return
    ${EndIf}
    Sleep 100
  ${Next}
  MessageBox MB_OK|MB_ICONSTOP "$(CloseFailure)" /SD IDOK
  SetErrorLevel 2
  Quit
FunctionEnd

; Pushes 1 while the installed executable is in use, which is while it runs.
Function ${PREFIX}AppIsRunning
  ${IfNot} ${FileExists} "$INSTDIR\${SC_EXE}"
    Push 0
    Return
  ${EndIf}
  ClearErrors
  FileOpen $0 "$INSTDIR\${SC_EXE}" a
  ${If} ${Errors}
    Push 1
  ${Else}
    FileClose $0
    Push 0
  ${EndIf}
FunctionEnd

; Posts WM_CLOSE to the windows of one class that belong to the installed executable.
Function ${PREFIX}CloseWindowsOfClass
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  StrCpy $R1 0
  ${Do}
    FindWindow $R1 "$R0" "" 0 $R1
    ${If} $R1 == 0
      ${ExitDo}
    ${EndIf}
    System::Call 'user32::GetWindowThreadProcessId(p R1, *i .R2)'
    System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i R2) p .R2' ; PROCESS_QUERY_LIMITED_INFORMATION
    StrCpy $R3 ""
    System::Call 'kernel32::QueryFullProcessImageNameW(p R2, i 0, w .R3, *i ${NSIS_MAX_STRLEN})'
    System::Call 'kernel32::CloseHandle(p R2)'
    ${If} $R3 == "$INSTDIR\${SC_EXE}"
      System::Call 'user32::PostMessageW(p R1, i ${WM_CLOSE}, p 0, p 0)'
    ${EndIf}
  ${Loop}
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd
!macroend
!insertmacro CloseAppFunction ""
!insertmacro CloseAppFunction "un."

; Windows 11 and current Windows 10 ship the WebView2 runtime. Elsewhere,
; Microsoft's bootstrapper installs it, before anything installed is touched.
Section "WebView2"
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\${WEBVIEW2_CLIENT}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "SOFTWARE\${WEBVIEW2_CLIENT}" "pv"
  ${EndIf}
  ${If} $0 == ""
    ReadRegStr $0 HKCU "SOFTWARE\${WEBVIEW2_CLIENT}" "pv"
  ${EndIf}
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    InitPluginsDir
    nsExec::Exec `powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=3072;Invoke-WebRequest -UseBasicParsing 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile '$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe'"`
    Pop $0
    ${If} $0 == 0
      ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install' $0
    ${EndIf}
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "$(WebViewFailure)" /SD IDOK
      SetErrorLevel 5
      Quit
    ${EndIf}
  ${EndIf}
SectionEnd

Section "Install"
  Call CloseApp
  SetOutPath "$INSTDIR"
  File "/oname=${SC_EXE}" "${SC_BINARY}"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateShortCut "$SMPROGRAMS\${SC_NAME}.lnk" "$INSTDIR\${SC_EXE}"
  WriteRegStr HKCU "${SC_UNINST}" "DisplayName" "${SC_NAME}"
  WriteRegStr HKCU "${SC_UNINST}" "DisplayVersion" "${SC_VERSION}"
  WriteRegStr HKCU "${SC_UNINST}" "Publisher" "ShareCode"
  WriteRegStr HKCU "${SC_UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${SC_UNINST}" "DisplayIcon" '"$INSTDIR\${SC_EXE}"'
  WriteRegStr HKCU "${SC_UNINST}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${SC_UNINST}" "NoModify" 1
  WriteRegDWORD HKCU "${SC_UNINST}" "NoRepair" 1
  ${If} $Passive == 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function .onInstSuccess
  ${If} $RestartApp == 1
    Exec '"$INSTDIR\${SC_EXE}"'
  ${EndIf}
FunctionEnd

; Removes what the installer put there. Saved sessions (the WebView2 profile)
; and anything else in the directory stay.
Section "Uninstall"
  Call un.CloseApp
  Delete "$INSTDIR\${SC_EXE}"
  Delete "$INSTDIR\uninstall.exe"
  Delete "$SMPROGRAMS\${SC_NAME}.lnk"
  DeleteRegKey HKCU "${SC_UNINST}"
  RMDir "$INSTDIR"
SectionEnd
