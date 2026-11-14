# Runs every test of the Windows client. All of them use their own windows,
# processes, registry key and temporary folders: no installed client, meeting
# or saved session is touched, and no input is generated.
#
# Run build-windows.ps1 first: the WebView tests load the embedded frontend.
# Pinning is covered only when this runs from the focused terminal, because
# Windows makes a window topmost only for a process with foreground rights.
param([string]$ISCC = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe")
$ErrorActionPreference = 'Stop'
function Assert-Success([string]$step) { if ($LASTEXITCODE -ne 0) { throw "$step failed (exit $LASTEXITCODE)" } }

Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    & node --test tests/client-chrome.test.mjs tests/i18n.test.mjs src/client/mygo.test.mjs
    Assert-Success 'Frontend tests'
} finally { Pop-Location }

Push-Location $PSScriptRoot
try {
    & go vet ./...
    & go test ./...
    Assert-Success 'Go tests'
    # The x86 and x64 meeting helpers against fixture processes of both architectures.
    & "$PSScriptRoot\nativewin\test-meeting.ps1"
    Assert-Success 'Meeting helper tests'
    # Real MyGo windows with WebView2: transparency, click-through, the page's IPC.
    $env:SHARECODE_MYGO_NATIVE_SMOKE = '1'
    & go test -tags mygo_smoke -run TestMyGo -count=1 ./nativewin
    Assert-Success 'WebView tests'
    & "$PSScriptRoot\packaging\test-installer.ps1" -ISCC $ISCC
    Assert-Success 'Installer tests'
} finally {
    Remove-Item Env:SHARECODE_MYGO_NATIVE_SMOKE -ErrorAction SilentlyContinue
    Pop-Location
}
