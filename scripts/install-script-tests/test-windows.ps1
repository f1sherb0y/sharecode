# The Windows install command end to end, on Windows: the download page's exact command runs in
# Windows PowerShell 5.1 (through cmd, as Win+R runs it) against a local server that renders the
# script like the real one, with a fake installer that records its arguments. Needs rustc and
# Python. Run from any PowerShell: powershell -File scripts/install-script-tests/test-windows.ps1
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$work = Join-Path ([IO.Path]::GetTempPath()) ('sharecode-install-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$exe = Join-Path $work 'fake-setup.exe'
rustc -O (Join-Path $here 'fake.rs') -o $exe
if ($LASTEXITCODE -ne 0) { throw 'rustc failed' }

$servers = @(
  Start-Process python -ArgumentList (Join-Path $here 'serve.py'), 55470, $exe -PassThru -WindowStyle Hidden
  Start-Process python -ArgumentList (Join-Path $here 'serve.py'), 55471, $exe, 'bad-sha' -PassThru -WindowStyle Hidden
)
$record = Join-Path $env:TEMP 'sharecode-fake-installer.txt'
$failures = 0
function Run([int]$port) {
  Remove-Item $record -ErrorAction SilentlyContinue
  $command = "powershell -NoProfile -ExecutionPolicy Bypass -Command `"[Net.ServicePointManager]::SecurityProtocol=3072;irm -UseBasicParsing http://127.0.0.1:$port/api/client/install.ps1|iex`""
  # echo. answers the pause after a failure.
  (cmd /c "echo.| $command" 2>&1) -join "`n"
}
function Check([string]$name, [bool]$ok, [string]$output) {
  if ($ok) { Write-Host "PASS $name" } else { $script:failures++; Write-Host "FAIL $name`n$output" -ForegroundColor Red }
}
try {
  Start-Sleep -Seconds 2
  $out = Run 55470
  Check 'installs passively and restarts the client' ((Get-Content $record -ErrorAction SilentlyContinue) -eq '/P /R' -and $out -match '安装完成 / Installed: ShareCode Client 9.9.9') $out
  $out = Run 55471
  Check 'refuses a corrupted download' (-not (Test-Path $record) -and $out -match '下载的文件不完整') $out
  $env:FAKE_EXIT = '2'
  $out = Run 55470
  Remove-Item Env:FAKE_EXIT
  Check 'reports a failed installer' ($out -match '安装程序没有完成（代码 2）') $out
  $left = @(Get-ChildItem $env:TEMP -Directory -Filter 'sharecode-install-*' | Where-Object { $_.FullName -ne $work })
  Check 'leaves no temporary files' ($left.Count -eq 0) ($left.FullName -join "`n")
} finally {
  $servers | ForEach-Object { Stop-Process -Id $_.Id -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $record -ErrorAction SilentlyContinue
}
if ($failures) { throw "$failures check(s) failed" }
