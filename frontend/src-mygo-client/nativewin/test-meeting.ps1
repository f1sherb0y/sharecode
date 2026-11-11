# Builds and exercises only isolated native fixture windows, never a real meeting.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build-helpers.ps1')
$fixture = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../src-tauri-client/native/tests/meeting_windows.rs'))
$out = Join-Path $PSScriptRoot 'assets/fixtures'
foreach ($arch in @('x86','x64')) {
    $target = if ($arch -eq 'x86') { 'i686-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
    $name = if ($arch -eq 'x86') { 'voovmeetingapp.exe' } else { 'wemeetapp.exe' }
    $dir = Join-Path $out $arch
    New-Item -ItemType Directory -Force $dir | Out-Null
    & rustc --edition=2021 -C target-feature=+crt-static --target $target $fixture -o (Join-Path $dir $name)
    if ($LASTEXITCODE -ne 0) { throw "Fixture compilation failed: $arch" }
}
$old = $env:NATIVEWIN_FIXTURES
try {
    $env:NATIVEWIN_FIXTURES = $out
    Push-Location (Split-Path $PSScriptRoot -Parent)
    try {
        & go test -v ./nativewin
        if ($LASTEXITCODE -ne 0) { throw 'Isolated native regression tests failed' }
    } finally { Pop-Location }
} finally { $env:NATIVEWIN_FIXTURES = $old }
