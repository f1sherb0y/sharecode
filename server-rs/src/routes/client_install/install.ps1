# ShareCode Client for Windows: installs the newest version for this user, or updates or repairs
# an existing install. The download page's command runs it in Windows PowerShell 5.1, which
# every Windows 10 and 11 has (PowerShell 7 works too); paste it into Win+R, cmd or PowerShell:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=3072;irm -UseBasicParsing {{ORIGIN}}/api/client/install.ps1|iex"
# The server fills in the release below. The installer runs passively (/P): it closes a running
# client, needs no administrator rights and starts the client again (/R). The client then updates
# itself.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  # Windows PowerShell 5.1 may not offer TLS 1.2 by default.
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}

  $origin = '{{ORIGIN}}'
  $arm = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64'
  if ($arm) {
    $version = '{{ARM64_VERSION}}'; $url = '{{ARM64_URL}}'; $sha256 = '{{ARM64_SHA256}}'
  } else {
    $version = '{{X64_VERSION}}'; $url = '{{X64_URL}}'; $sha256 = '{{X64_SHA256}}'
  }

  function Step([string]$text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
  function Say([string]$text) { Write-Host "    $text" }

  $dir = $null
  try {
    Write-Host 'ShareCode Client'
    if (-not $url) { throw '暂时没有适用于这台电脑的版本。 / No version is available for this PC yet.' }

    $dir = Join-Path ([IO.Path]::GetTempPath()) ('sharecode-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    $file = Join-Path $dir 'ShareCode-Client-setup.exe'

    Step "下载 $version / Downloading $version"
    try {
      (New-Object Net.WebClient).DownloadFile($origin + $url, $file)
    } catch {
      throw '下载失败，请检查网络后重新运行这条命令。 / The download failed. Check your connection and run the command again.'
    }
    $stream = [IO.File]::OpenRead($file)
    try {
      $hash = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
    } finally {
      $stream.Dispose()
    }
    if ($hash -ne $sha256) { throw '下载的文件不完整，请重新运行这条命令。 / The download is incomplete. Run the command again.' }

    Step '安装 / Installing'
    Say '安装时会自动关闭正在运行的客户端。 / A running client is closed while installing.'
    # Wait for the installer only: the client it starts again (/R) keeps running.
    $installer = [Diagnostics.Process]::Start($file, '/P /R')
    $installer.WaitForExit()
    if ($installer.ExitCode -ne 0) {
      throw "安装程序没有完成（代码 $($installer.ExitCode)）。 / The installer did not finish (code $($installer.ExitCode))."
    }

    Write-Host ''
    Write-Host "安装完成 / Installed: ShareCode Client $version" -ForegroundColor Green
    Say '客户端会自动更新；也可以随时重新运行这条命令来更新或修复安装。'
    Say 'The client updates itself; run this command again any time to update or repair it.'
    Start-Sleep -Seconds 3
  } catch {
    Write-Host ''
    Write-Host '安装失败 / Installation failed' -ForegroundColor Red
    Say $_.Exception.Message
    Write-Host ''
    Read-Host '按回车键关闭 / Press Enter to close' | Out-Null
  } finally {
    if ($dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
