<#
.SYNOPSIS
    Installs the AgentScope background worker as a per-user scheduled task.

.DESCRIPTION
    The worker (src\worker\index.ts) runs cron schedules, crash recovery and
    proactive scans in its OWN process. Registered here it:
      - starts automatically when you log in to Windows,
      - runs hidden (no console window),
      - restarts itself (every minute, up to 99 times) if it crashes,
      - keeps running after you close the Studio window / browser.

    No administrator rights are needed (it is a per-user task). This is NOT a
    Windows Service: it does not run while you are logged out, and a sleeping
    or shut-down laptop runs nothing - missed schedules are recovered by their
    misfire policy the next time the worker starts. For true 24/7 work, run
    the Studio on an always-on machine.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker.ps1 -Remove
#>
[CmdletBinding()]
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$studioRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$taskName = 'AgentScope Worker'

function Write-Ok   { param([string]$m) Write-Host "    OK  $m" -ForegroundColor Green }
function Write-Fail { param([string]$m) Write-Host "    XX  $m" -ForegroundColor Red }

if ($Remove) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Ok "Removed the scheduled task '$taskName'."
    } else {
        Write-Ok "Nothing to remove - '$taskName' is not installed."
    }
    exit 0
}

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { Write-Fail 'bun was not found on PATH - run scripts\windows\setup.ps1 first.'; exit 1 }

# the server must leave the ticking to the worker (it also yields automatically while the worker is alive)
$action = New-ScheduledTaskAction -Execute $bun -Argument 'run src/worker/index.ts' -WorkingDirectory $studioRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Ok "Installed and started '$taskName' (runs at every logon, hidden, auto-restart)."
Write-Host "    Check it : Get-ScheduledTask -TaskName '$taskName' | Get-ScheduledTaskInfo"
Write-Host "    Remove it: powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker.ps1 -Remove"
