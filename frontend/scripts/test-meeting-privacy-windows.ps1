$ErrorActionPreference = 'Stop'
$client = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src-tauri-client'))
$fixture = Join-Path $client 'native/tests/meeting_windows.rs'
$output = Join-Path $client 'target/meeting-privacy-fixtures'
foreach ($arch in @('x86', 'x64')) {
    $target = if ($arch -eq 'x86') { 'i686-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
    $directory = Join-Path $output $arch
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $name = if ($arch -eq 'x86') { 'voovmeetingapp.exe' } else { 'wemeetapp.exe' }
    $binary = Join-Path $directory $name
    & rustc --edition=2021 --target $target -C target-feature=+crt-static $fixture -o $binary
    if ($LASTEXITCODE -ne 0) { throw "Fixture compilation failed for $arch" }
}
$env:SHARECODE_MEETING_FIXTURES = $output
try {
    & cargo test --manifest-path (Join-Path $client 'Cargo.toml') --locked meeting_privacy::tests::native_lifecycle_both_architectures -- --ignored --test-threads=1 --nocapture
    if ($LASTEXITCODE -ne 0) { throw 'Meeting privacy tests failed' }
} finally {
    Remove-Item Env:SHARECODE_MEETING_FIXTURES
}
