# Installs, updates and uninstalls a fixture application with installer.nsi,
# under its own name, registry key and temporary directory.
param([string]$MakeNSIS = "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe")
$ErrorActionPreference = 'Stop'
$module = Split-Path $PSScriptRoot -Parent
$id = [Guid]::NewGuid().ToString('N')
$root = Join-Path ([IO.Path]::GetTempPath()) "sharecode-mygo-installer-test-$id"
$name = "ShareCode MyGo Installer Fixture $id"
$exe = "sharecode-installer-fixture-$id.exe"
$target = Join-Path $root 'legacy install 中文 path'
$installed = Join-Path $target $exe
$launched = Join-Path $target 'fixture-launched.txt'
$registry = "Software\Microsoft\Windows\CurrentVersion\Uninstall\$name"
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
    $installer = Join-Path $root "setup-$version.exe"
    & $MakeNSIS /INPUTCHARSET UTF8 /V2 "/DSC_NAME=$name" "/DSC_EXE=$exe" "/DSC_VERSION=$version" "/DSC_BINARY=$payload" `
        "/DSC_OUTPUT=$installer" "/DSC_ICON=$module\..\src-tauri\icons\icon.ico" "$PSScriptRoot\installer.nsi" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The fixture installer failed to compile' }
    return $installer
}
function Run-Installer([string]$path, [string]$arguments) {
    $process = Start-Process -FilePath $path -ArgumentList $arguments -PassThru
    if (-not $process.WaitForExit(45000)) { $process.Kill(); throw "Timed out: $path" }
    Assert ($process.ExitCode -eq 0) "Exit code $($process.ExitCode): $path"
}
function Assert-Installed([string]$version) {
    Wait-Until { (Test-Path -LiteralPath $launched) -and ([IO.File]::ReadAllText($launched) -eq $version) } "Version $version was not restarted"
    Assert ((Get-FileHash -LiteralPath $installed).Hash -eq (Get-FileHash -LiteralPath (Join-Path $root "payload-$version.exe")).Hash) "Version $version is not what is installed"
    Assert ((Get-ItemProperty -LiteralPath "HKCU:\$registry").DisplayVersion -eq $version) "Version $version is not registered"
}

Push-Location $module
try {
    New-Item -ItemType Directory -Path $target | Out-Null
    Set-Content -LiteralPath (Join-Path $target 'keep-me.txt') -Value 'a user file'
    # What a Tauri installation leaves: InstallLocation in quotes.
    New-Item -Path "HKCU:\$registry" | Out-Null
    Set-ItemProperty -LiteralPath "HKCU:\$registry" -Name InstallLocation -Value "`"$target`""

    Run-Installer (Build-Installer '1.0.0') '/S /R'
    Assert-Installed '1.0.0'
    Assert ((Get-ItemProperty -LiteralPath "HKCU:\$registry").InstallLocation -eq $target) 'The quoted install location was not understood'

    # An update, with the command line of the client's updater, while the
    # application runs with a hidden window.
    $running = Start-Process -FilePath $installed -ArgumentList '--hold' -PassThru
    Wait-Until { Test-Path -LiteralPath (Join-Path $target 'fixture-ready.txt') } 'The fixture application did not start'
    Run-Installer (Build-Installer '1.0.1') '/S /P /R /UPDATE'
    Assert ($running.WaitForExit(5000)) 'The running application was not closed'
    Assert ($running.ExitCode -eq 0) 'The running application was killed instead of closed'
    Assert-Installed '1.0.1'

    Run-Installer (Join-Path $target 'uninstall.exe') '/S'
    Wait-Until { -not (Test-Path -LiteralPath $installed) } 'Uninstalling left the executable'
    Wait-Until { -not (Test-Path -LiteralPath "HKCU:\$registry") } 'Uninstalling left the registry key'
    Assert (Test-Path -LiteralPath (Join-Path $target 'keep-me.txt')) 'Uninstalling removed a user file'
    Write-Output 'PASS: install over a quoted path with spaces and Unicode, update of a running application with restart, uninstall keeping user files.'
} finally {
    if ($running -and -not $running.HasExited) { $running.Kill() }
    Remove-Item -LiteralPath "HKCU:\$registry" -Recurse -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\$name.lnk" -ErrorAction SilentlyContinue
    Pop-Location
}
