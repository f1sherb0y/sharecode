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

  $dir = $null
  try {
    if (-not $url) { throw 'No version is available for this PC yet.' }

    $dir = Join-Path ([IO.Path]::GetTempPath()) ('sharecode-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    $file = Join-Path $dir 'ShareCode-Client-setup.exe'

    Write-Host "Downloading ShareCode Client $version..."
    try {
      (New-Object Net.WebClient).DownloadFile($origin + $url, $file)
    } catch {
      throw 'Download failed. Check your connection and try again.'
    }
    $stream = [IO.File]::OpenRead($file)
    try {
      $hash = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
    } finally {
      $stream.Dispose()
    }
    if ($hash -ne $sha256) { throw 'Download was incomplete. Try again.' }

    # The installer closes a running client. Wait for the installer only: the client it starts
    # again (/R) keeps running.
    $installer = [Diagnostics.Process]::Start($file, '/P /R')
    $installer.WaitForExit()
    if ($installer.ExitCode -ne 0) { throw "The installer failed (code $($installer.ExitCode))." }

    Write-Host "Installed ShareCode Client $version." -ForegroundColor Green
    Start-Sleep -Seconds 3
  } catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host 'Press Enter to close' | Out-Null
  } finally {
    if ($dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
