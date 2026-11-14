; Installer of the customer client (Inno Setup 6). It asks for administrator
; rights (UAC), installs for the machine under Program Files and brings the
; WebView2 runtime to a version the page can use. The client itself runs as
; administrator (cmd/require-admin), so nothing is lost by asking here.
; Built by build-windows.ps1, which passes the SC_* definitions.
;
;   setup.exe                             the wizard
;   setup.exe /SILENT /NORESTART /LAUNCH  what the updater and the one-line
;                                         install command run: a progress window
;                                         only, then the client is started
; /LAUNCH is this script's own switch; the others are Inno Setup's.

; The page needs Chromium 111 (CSS color-mix; Tailwind 4's baseline). Windows
; images carry older runtimes (Windows 11 21H2: 90, 23H2: 100) until Edge's
; updater has run; with one of those the window stays empty.
#define WebView2Minimum 111

; The installer test builds a per-user fixture so that it runs without UAC.
#ifndef SC_PRIVILEGES
  #define SC_PRIVILEGES "admin"
#endif

[Setup]
AppId={#SC_ID}
AppName={#SC_NAME}
AppVersion={#SC_VERSION}
AppPublisher=ShareCode
VersionInfoVersion={#SC_VERSION}.0
DefaultDirName={autopf}\{#SC_NAME}
DisableProgramGroupPage=yes
PrivilegesRequired={#SC_PRIVILEGES}
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#SC_OUTPUT_DIR}
OutputBaseFilename={#SC_OUTPUT_NAME}
SetupIconFile={#SC_ICON}
UninstallDisplayIcon={app}\{#SC_EXE}
UninstallDisplayName={#SC_NAME}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=auto
; The client is closed by CloseClient below, through its main window, so that
; it shuts down properly (it restores meeting windows on the way out).
CloseApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
; Inno Setup ships no Simplified Chinese; this is its unofficial translation.
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[CustomMessages]
english.ClosePrompt=%1 is running. Close it to continue?
chinesesimplified.ClosePrompt=%1 正在运行。关闭客户端并继续？
english.CloseFailure=Unable to close %1. Close it yourself and try again.
chinesesimplified.CloseFailure=无法关闭 %1。请关闭客户端后重试。
english.WebViewInstalling=Installing Microsoft Edge WebView2...
chinesesimplified.WebViewInstalling=正在安装 Microsoft Edge WebView2...
english.WebViewFailure=WebView2 could not be installed or updated. Check your connection and try again.
chinesesimplified.WebViewFailure=无法安装或更新 WebView2，请检查网络后重试。

[Files]
Source: "{#SC_BINARY}"; DestDir: "{app}"; DestName: "{#SC_EXE}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#SC_NAME}"; Filename: "{app}\{#SC_EXE}"

[Run]
; The wizard's last page offers to start the client; a silent install starts
; it when asked to. Both start it from this elevated process, without a
; second UAC prompt.
Filename: "{app}\{#SC_EXE}"; Description: "{cm:LaunchProgram,{#SC_NAME}}"; Flags: nowait postinstall skipifsilent runascurrentuser
Filename: "{app}\{#SC_EXE}"; Flags: nowait; Check: LaunchSilently

[UninstallDelete]
; What the client keeps beside itself: the meeting helpers it unpacks and the
; installers of its updates. Saved sessions (the WebView2 profile under
; %LOCALAPPDATA%) and anything else stay.
Type: filesandordirs; Name: "{app}\meeting-helpers"
Type: filesandordirs; Name: "{app}\updates"

[Code]
const
  WebView2Client = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2Bootstrapper = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';
  ClientWindowClass = 'MyGoWindow';
  CloseMessage = $10; { WM_CLOSE }
  QueryLimitedInformation = $1000;
  Synchronize = $100000;

function FindWindowEx(Parent, After: HWND; ClassName: String; Title: UINT_PTR): HWND;
  external 'FindWindowExW@user32.dll stdcall';
function GetWindowThreadProcessId(Window: HWND; var ProcessId: DWORD): DWORD;
  external 'GetWindowThreadProcessId@user32.dll stdcall';
function OpenProcess(Access: DWORD; Inherit: BOOL; ProcessId: DWORD): THandle;
  external 'OpenProcess@kernel32.dll stdcall';
function QueryFullProcessImageName(Process: THandle; Flags: DWORD; Name: String; var Size: DWORD): BOOL;
  external 'QueryFullProcessImageNameW@kernel32.dll stdcall';
function WaitForSingleObject(Handle: THandle; Milliseconds: DWORD): DWORD;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function CloseHandle(Handle: THandle): BOOL;
  external 'CloseHandle@kernel32.dll stdcall';

function Silent: Boolean;
begin
  if IsUninstaller then
    Result := UninstallSilent
  else
    Result := WizardSilent;
end;

function LaunchSilently: Boolean;
var
  I: Integer;
begin
  Result := False;
  if WizardSilent then
    for I := 1 to ParamCount do
      if CompareText(ParamStr(I), '/LAUNCH') = 0 then
        Result := True;
end;

function MajorVersion(const Version: String): Integer;
var
  Dot: Integer;
begin
  Dot := Pos('.', Version);
  if Dot = 0 then
    Result := StrToIntDef(Version, 0)
  else
    Result := StrToIntDef(Copy(Version, 1, Dot - 1), 0);
end;

procedure ConsiderWebView2(RootKey: Integer; var Newest: Integer);
var
  Version: String;
begin
  if RegQueryStringValue(RootKey, WebView2Client, 'pv', Version) and (MajorVersion(Version) > Newest) then
    Newest := MajorVersion(Version);
end;

{ The major version of the newest WebView2 runtime registered for the machine
  or the user, which is the one the client loads; 0 without one. }
function WebView2Major: Integer;
begin
  Result := 0;
  ConsiderWebView2(HKLM32, Result);
  ConsiderWebView2(HKLM64, Result);
  ConsiderWebView2(HKCU, Result);
end;

{ Installs the runtime, or updates one too old for the page, with Microsoft's
  bootstrapper. As administrator it installs for the machine, and only so can
  it replace the runtime Windows came with. Returns '' or what went wrong. }
function InstallWebView2: String;
var
  ExitCode: Integer;
begin
  Result := '';
  Log(Format('WebView2 runtime: major version %d, the page needs %d', [WebView2Major, {#WebView2Minimum}]));
  if WebView2Major >= {#WebView2Minimum} then
    Exit;
  Result := CustomMessage('WebViewFailure');
  WizardForm.PreparingLabel.Caption := CustomMessage('WebViewInstalling');
  WizardForm.PreparingLabel.Visible := True;
  try
    DownloadTemporaryFile(WebView2Bootstrapper, 'MicrosoftEdgeWebview2Setup.exe', '', nil);
  except
    Log('WebView2 bootstrapper download: ' + GetExceptionMessage);
    Exit;
  end;
  if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_SHOW, ewWaitUntilTerminated, ExitCode) then
  begin
    Log('WebView2 bootstrapper did not start: ' + SysErrorMessage(ExitCode));
    Exit;
  end;
  Log(Format('WebView2 bootstrapper exit code %d, runtime now major version %d', [ExitCode, WebView2Major]));
  { What is registered afterwards decides, not the exit code. }
  if WebView2Major >= {#WebView2Minimum} then
    Result := '';
end;

{ Finds a main window of the installed client and opens its process. }
function FindClient(var Window: HWND; var Process: THandle): Boolean;
var
  ProcessId, Size: DWORD;
  Path: String;
begin
  Result := False;
  Window := 0;
  repeat
    Window := FindWindowEx(0, Window, ClientWindowClass, 0);
    if Window = 0 then
      Exit;
    ProcessId := 0;
    GetWindowThreadProcessId(Window, ProcessId);
    Process := OpenProcess(QueryLimitedInformation or Synchronize, False, ProcessId);
    if Process <> 0 then
    begin
      Size := 1024;
      Path := StringOfChar(#0, Size);
      if QueryFullProcessImageName(Process, 0, Path, Size) then
        SetLength(Path, Size)
      else
        Path := '';
      if CompareText(Path, ExpandConstant('{app}\{#SC_EXE}')) = 0 then
      begin
        Result := True;
        Exit;
      end;
      CloseHandle(Process);
    end;
  until False;
end;

{ Closes the running client and waits for it to exit. Only its main window
  gets WM_CLOSE: MyGo keeps a hidden helper window whose closing would leave
  the process running without an event loop. Returns '' or what went wrong. }
function CloseClient: String;
var
  Window: HWND;
  Process: THandle;
  Asked, Exited: Boolean;
begin
  Result := '';
  Asked := False;
  while FindClient(Window, Process) do
  begin
    if not Asked and not Silent then
      if SuppressibleMsgBox(FmtMessage(CustomMessage('ClosePrompt'), ['{#SC_NAME}']), mbConfirmation, MB_OKCANCEL, IDOK) <> IDOK then
        Result := FmtMessage(CustomMessage('CloseFailure'), ['{#SC_NAME}']);
    Asked := True;
    Exited := False;
    if Result = '' then
    begin
      PostMessage(Window, CloseMessage, 0, 0);
      Exited := WaitForSingleObject(Process, 15000) = 0;
    end;
    CloseHandle(Process);
    if not Exited then
    begin
      Result := FmtMessage(CustomMessage('CloseFailure'), ['{#SC_NAME}']);
      Exit;
    end;
  end;
end;

{ WebView2 first: when it fails, a running client is left alone. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := InstallWebView2;
  if Result = '' then
    Result := CloseClient;
end;

function InitializeUninstall: Boolean;
var
  Failure: String;
begin
  Failure := CloseClient;
  Result := Failure = '';
  if not Result then
    SuppressibleMsgBox(Failure, mbError, MB_OK, IDOK);
end;
