# Runs on the test VM over SSH (session 0, administrator): reports the system and starts the desktop
# agent, which installs the client as the signed-in user.
param([int]$Port = 39100)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Get-WebView2 {
    foreach ($key in 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') {
        $version = (Get-ItemProperty $key -ErrorAction SilentlyContinue).pv
        if ($version -and $version -ne '0.0.0.0') { return $version }
    }
    $null
}

$windows = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$report = [ordered]@{
    build            = "$($windows.CurrentBuild).$($windows.UBR)"
    displayVersion   = $windows.DisplayVersion
    product          = $windows.ProductName
    culture          = (Get-Culture).Name
    uiLanguage       = (Get-UICulture).Name
    inputLanguages   = @(Get-WinUserLanguageList | ForEach-Object { $_.LanguageTag })
    uac              = (Get-ItemProperty HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System).EnableLUA
    # 5 asks an administrator for consent (the default); 0 elevates without asking.
    uacAdminPrompt   = (Get-ItemProperty HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System).ConsentPromptBehaviorAdmin
    webview2Before   = Get-WebView2
}

# The agent runs on the signed-in desktop with the user's ordinary (not elevated) token, like the
# shell a customer starts the installer and the client from. SSH answers before the automatic
# sign-in has finished on some builds, and an interactive task only starts on a signed-in desktop:
# wait for the shell first.
$ErrorActionPreference = 'Continue'
$deadline = (Get-Date).AddMinutes(3)
while (-not (Get-Process explorer -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }

# Registered with the ScheduledTasks module, not schtasks.exe: its tasks refuse to start while the
# machine is on battery, and a VM on a laptop host reports the host's battery. Priority 4 is the
# normal one: a task's default (7) is below normal for processor, disk and memory, and the client
# the agent starts would inherit it.
$null = Register-ScheduledTask -TaskName sccompat-agent -Force `
    -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:/test/agent.ps1 -Port $Port") `
    -Principal (New-ScheduledTaskPrincipal -UserId 'fish' -LogonType Interactive -RunLevel Limited) `
    -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -Priority 4)

$report.agentListening = $false
while (-not $report.agentListening -and (Get-Date) -lt $deadline) {
    Start-ScheduledTask -TaskName sccompat-agent
    foreach ($attempt in 1..40) {
        if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $report.agentListening = $true; break }
        Start-Sleep -Milliseconds 500
    }
}

$report | ConvertTo-Json -Compress
