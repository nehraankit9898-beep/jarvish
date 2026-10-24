<#
.SYNOPSIS
    Builds the production bundle of AgentScope Studio on Windows.

.DESCRIPTION
    Runs the type check, the linter, the tests and the Next.js production
    build (including the standalone output). A failing step stops the build.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\windows\build.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\windows\build.ps1 -SkipTests
#>
[CmdletBinding()]
param(
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$studioRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $studioRoot

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "    OK  $Message" -ForegroundColor Green }

$useBun = [bool](Get-Command bun -ErrorAction SilentlyContinue)
function Invoke-Step {
    param([string]$Name, [scriptblock]$Command)
    Write-Step $Name
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
    Write-Ok $Name
}

if ($useBun) {
    Invoke-Step 'type check' { bun run typecheck }
    Invoke-Step 'lint' { bun run lint }
    if (-not $SkipTests) { Invoke-Step 'tests' { bun test } }
    Invoke-Step 'production build' { bun run build }
} else {
    Invoke-Step 'type check' { npm run typecheck }
    Invoke-Step 'lint' { npm run lint }
    if (-not $SkipTests) { Invoke-Step 'tests' { npm test } }
    Invoke-Step 'production build' { npm run build }
}

Write-Host ""
Write-Host "Build finished. Start it with:" -ForegroundColor Green
Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-prod.ps1" -ForegroundColor Cyan
Write-Host ""
