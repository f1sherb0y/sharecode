# Installs, updates and uninstalls a fixture application with installer.iss,
# under its own name, registry key and temporary directory. The fixture is
# built per user (SC_PRIVILEGES=lowest), so nothing here asks for administrator
# rights; the real installer, UAC and WebView2 are covered on the test VMs
# (frontend/scripts/windows-compat).
param([string]$ISCC = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe")
$ErrorActionPreference = 'Stop'
$module = Split-Path $PSScriptRoot -Parent
$id = [Guid]::NewGuid().ToString('N')
$root = Join-Path ([IO.Path]::GetTempPath()) "sharecode-mygo-installer-test-$id"
$name = "ShareCode MyGo Installer Fixture $id"
$exe = "sharecode-installer-fixture-$id.exe"
$target = Join-Path $root 'install 中文 path'
$installed = Join-Path $target $exe
$launched = Join-Path $target 'fixture-launched.txt'
$ready = Join-Path $target 'fixture-ready.txt'
$registry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\sharecode.fixture.${id}_is1"
$shortcut = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\$name.lnk"
$running = $null

function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
function Wait-Until([scriptblock]$condition, [string]$message) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not (& $condition)) {
        if ([DateTime]::UtcNow -ge $deadline) { throw $message }
        Start-Sleep -Milliseconds 100
    }
}
function Build-Installer([string]$version) {
    $payload = Join-Path $root "payload-$version.exe"
    & go build -ldflags "-H=windowsgui -X main.version=$version" -o $payload ./packaging/fixture
    if ($LASTEXITCODE -ne 0) { throw 'The fixture application failed to build' }
    & $ISCC /Q "/DSC_ID=sharecode.fixture.$id" "/DSC_NAME=$name" "/DSC_EXE=$exe" "/DSC_VERSION=$version" "/DSC_BINARY=$payload" `
        "/DSC_OUTPUT_DIR=$root" "/DSC_OUTPUT_NAME=setup-$version" "/DSC_ICON=$module\..\src-tauri\icons\icon.ico" `
        /DSC_PRIVILEGES=lowest "$PSScriptRoot\installer.iss" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The fixture installer failed to compile' }
    return Join-Path $root "setup-$version.exe"
}
function Run-Installer([string]$path, [string]$arguments) {
    $process = Start-Process -FilePath $path -ArgumentList $arguments -PassThru
    if (-not $process.WaitForExit(45000)) { $process.Kill(); throw "Timed out: $path" }
    Assert ($process.ExitCode -eq 0) "Exit code $($process.ExitCode): $path"
}
function Assert-Installed([string]$version) {
    Assert ((Get-FileHash -LiteralPath $installed).Hash -eq (Get-FileHash -LiteralPath (Join-Path $root "payload-$version.exe")).Hash) "Version $version is not what is installed"
    Assert ((Get-ItemProperty -LiteralPath $registry).DisplayVersion -eq $version) "Version $version is not registered"
}
function Assert-Launched([string]$version) {
    Wait-Until { (Test-Path -LiteralPath $launched) -and ([IO.File]::ReadAllText($launched) -eq $version) } "Version $version was not started"
}
function Start-Fixture {
    Remove-Item -LiteralPath $ready -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $installed -ArgumentList '--hold' -PassThru
    Wait-Until { Test-Path -LiteralPath $ready } 'The fixture application did not start'
    return $process
}
function Assert-Closed($process) {
    Assert ($process.WaitForExit(5000)) 'The running application was not closed'
    Assert ($process.ExitCode -eq 0) 'The running application was killed instead of closed'
}

Push-Location $module
try {
    New-Item -ItemType Directory -Path $target | Out-Null
    Set-Content -LiteralPath (Join-Path $target 'keep-me.txt') -Value 'a user file'

    # A first install, with the command line of the one-line install command.
    Run-Installer (Build-Installer '1.0.0') "/SILENT /NORESTART /LAUNCH /DIR=`"$target`""
    Assert-Installed '1.0.0'
    Assert-Launched '1.0.0'
    Assert (Test-Path -LiteralPath $shortcut) 'No Start menu shortcut'

    # An update, with the command line of the client's updater, while the
    # application runs with a hidden window. It finds the directory itself.
    $running = Start-Fixture
    $update = Build-Installer '1.0.1'
    Run-Installer $update '/SILENT /NORESTART /LAUNCH'
    Assert-Closed $running
    Assert-Installed '1.0.1'
    Assert-Launched '1.0.1'

    # Without /LAUNCH a silent install starts nothing.
    Remove-Item -LiteralPath $launched
    Run-Installer $update '/SILENT /NORESTART'
    Start-Sleep -Seconds 2
    Assert (-not (Test-Path -LiteralPath $launched)) 'A silent install without /LAUNCH started the application'

    # Uninstalling closes the running application and removes what was
    # installed and the unpacked helpers, nothing else.
    New-Item -ItemType Directory -Path (Join-Path $target 'meeting-helpers') | Out-Null
    Set-Content -LiteralPath (Join-Path $target 'meeting-helpers\helper.dll') -Value 'unpacked by the client'
    $running = Start-Fixture
    Run-Installer (Join-Path $target 'unins000.exe') '/VERYSILENT /NORESTART'
    Assert-Closed $running
    Wait-Until { -not (Test-Path -LiteralPath $installed) } 'Uninstalling left the executable'
    Wait-Until { -not (Test-Path -LiteralPath $registry) } 'Uninstalling left the registry key'
    Assert (-not (Test-Path -LiteralPath (Join-Path $target 'meeting-helpers'))) 'Uninstalling left the meeting helpers'
    Assert (-not (Test-Path -LiteralPath $shortcut)) 'Uninstalling left the Start menu shortcut'
    Assert (Test-Path -LiteralPath (Join-Path $target 'keep-me.txt')) 'Uninstalling removed a user file'
    Write-Output 'PASS: install into a path with spaces and Unicode, update of a running application with restart, no start without /LAUNCH, uninstall of a running application keeping user files.'
} finally {
    if ($running -and -not $running.HasExited) { $running.Kill() }
    Remove-Item -LiteralPath $registry -Recurse -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $shortcut -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    Pop-Location
}
