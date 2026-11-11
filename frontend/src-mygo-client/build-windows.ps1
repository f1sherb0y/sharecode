# Builds the Windows client and its installer into build/mygo-client.
# Nothing is installed or uploaded. test-windows.ps1 runs the tests.
#
#   .\build-windows.ps1                          development client, installs beside a real one
#   .\build-windows.ps1 -Release -Version 0.2.8  the released identity, with a signed update
param(
    [string]$Version = '0.2.7',
    [switch]$Release,
    [string]$MakeNSIS = "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe"
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'The version must be major.minor.patch' }
if ($Release -and -not $env:TAURI_SIGNING_PRIVATE_KEY) { throw 'A release needs TAURI_SIGNING_PRIVATE_KEY, the key the installed clients trust' }
if (-not (Test-Path -LiteralPath $MakeNSIS -PathType Leaf)) { throw 'Set -MakeNSIS to the makensis.exe of NSIS 3' }

$frontend = Split-Path $PSScriptRoot -Parent
$out = Join-Path (Split-Path $frontend -Parent) 'build/mygo-client'
if ($Release) {
    $name = 'sharecode-client'; $product = 'ShareCode Client'; $identity = 'dev.sharecode.client'
    $installer = Join-Path $out "ShareCode Client_${Version}_x64-setup.exe"
} else {
    $name = 'sharecode-client-mygo-dev'; $product = 'ShareCode Client (MyGo Development)'; $identity = 'dev.sharecode.client.mygo-dev'
    $installer = Join-Path $out "${name}_${Version}_x64-setup.exe"
}
function Assert-Success([string]$step) { if ($LASTEXITCODE -ne 0) { throw "$step failed (exit $LASTEXITCODE)" } }

Push-Location $PSScriptRoot
try {
    & "$PSScriptRoot\nativewin\build-helpers.ps1"

    # mygo.config.ts and identity.go read the same identity and version.
    $env:SHARECODE_MYGO_RELEASE_BUILD = if ($Release) { '1' } else { '0' }
    $env:SHARECODE_MYGO_VERSION = $Version
    $env:MYGO_LDFLAGS = "-X main.applicationID=$identity -X main.applicationName=$name -X main.applicationVersion=$Version"
    # MyGo's own installer has another registry key and no /P /R /UPDATE, so
    # packaging/installer.nsi makes the installer instead.
    & go run github.com/egoist/mygo/cmd/mygo build -platform windows/amd64 -skip-installer -o $out
    Assert-Success 'MyGo build'
    $binary = Join-Path $out "windows-amd64/$name.exe"

    & $MakeNSIS /INPUTCHARSET UTF8 /V2 "/DSC_NAME=$product" "/DSC_EXE=$name.exe" "/DSC_VERSION=$Version" "/DSC_BINARY=$binary" `
        "/DSC_OUTPUT=$installer" "/DSC_ICON=$frontend\src-tauri\icons\icon.ico" "$PSScriptRoot\packaging\installer.nsi"
    Assert-Success 'Installer'
    if ($Release) {
        & go run ./cmd/sign-update -file $installer
        Assert-Success 'Update signature'
    }
    Write-Output "Built $installer"
} finally {
    Remove-Item Env:SHARECODE_MYGO_RELEASE_BUILD, Env:SHARECODE_MYGO_VERSION, Env:MYGO_LDFLAGS -ErrorAction SilentlyContinue
    Pop-Location
}
