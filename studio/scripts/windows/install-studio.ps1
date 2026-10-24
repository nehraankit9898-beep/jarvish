<#
.SYNOPSIS
    Installs AgentScope Jarvis as an always-on setup (Jarvis #6):
    the Studio production server AND the tray icon start at every logon.

.DESCRIPTION
    Registers TWO per-user scheduled tasks (no admin rights needed):

      "AgentScope Studio"  — bun run start (production server on port 3000).
                             Runs hidden, restarts on crash (99x, 1 min apart).
                             RAM note (i3, 12 GB): ye PRODUCTION build chalata
                             hai — dev mode se halka. Pehle ek baar
                             scripts\windows\build.ps1 chalana zaroori hai.

      "AgentScope Tray"    — python python-bridge\tray.py (status icon +
                             Open Studio / Mute / Pause / Kill menu). Optional:
                             -WithTray is the default; -NoTray skips it.

    Voice/wake word ke liye ek baar:
      pip install -r python-bridge\requirements-voice.txt

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-studio.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-studio.ps1 -Remove
#>
[CmdletBinding()]
param(
    [switch]$Remove,
    [switch]$NoTray
)

$ErrorActionPreference = 'Stop'
$studioRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$studioTask = 'AgentScope Studio'
$trayTask = 'AgentScope Tray'

function Write-Ok   { param([string]$m) Write-Host "    OK  $m" -ForegroundColor Green }
function Write-Fail { param([string]$m) Write-Host "    XX  $m" -ForegroundColor Red }
function Write-Note { param([string]$m) Write-Host "    ..  $m" -ForegroundColor Yellow }

if ($Remove) {
    foreach ($name in @($studioTask, $trayTask)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Ok "Removed the scheduled task '$name'."
        } else {
            Write-Ok "Nothing to remove - '$name' is not installed."
        }
    }
    exit 0
}

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { Write-Fail 'bun was not found on PATH - run scripts\windows\setup.ps1 first.'; exit 1 }

$prodOutput = Join-Path $studioRoot '.next\standalone\server.js'
if (-not (Test-Path $prodOutput)) {
    Write-Note "Production build not found (.next\standalone\server.js)."
    Write-Note "Run:  powershell -ExecutionPolicy Bypass -File scripts\windows\build.ps1"
    Write-Note "Phir ye script dobara chalao. (Dev mode auto-start ke liye theek nahi - RAM.)"
}

$commonSettings = {
    New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew `
        -Hidden
}

# ---- task 1: the Studio production server -------------------------------
$action = New-ScheduledTaskAction -Execute $bun -Argument 'run start' -WorkingDirectory $studioRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = & $commonSettings
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $studioTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $studioTask
Write-Ok "Installed and started '$studioTask' (bun run start at every logon, hidden, auto-restart)."

# ---- task 2: the tray icon (optional) ------------------------------------
if (-not $NoTray) {
    $python = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
    if (-not $python) {
        Write-Note 'python not found on PATH - tray skipped (pip install python, then re-run).'
    } else {
        $pyArgs = "`"$studioRoot\python-bridge\tray.py`" --studio-root `"$studioRoot`""
        $trayAction = New-ScheduledTaskAction -Execute $python -Argument $pyArgs -WorkingDirectory $studioRoot
        $trayTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $traySettings = & $commonSettings
        Register-ScheduledTask -TaskName $trayTask -Action $trayAction -Trigger $trayTrigger -Settings $traySettings -Principal $principal -Force | Out-Null
        Start-ScheduledTask -TaskName $trayTask
        Write-Ok "Installed and started '$trayTask' (status icon in the system tray)."
        Write-Note 'Tray needs: pip install pystray pillow'
    }
}

Write-Host ""
Write-Host "    Check it : Get-ScheduledTask -TaskName '$studioTask' | Get-ScheduledTaskInfo"
Write-Host "    Remove it: powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-studio.ps1 -Remove"
Write-Host "    Voice    : pip install -r python-bridge\requirements-voice.txt"
