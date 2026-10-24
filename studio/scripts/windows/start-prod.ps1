<#
.SYNOPSIS
    Starts the PRODUCTION server of AgentScope Studio on Windows.

.DESCRIPTION
    Serves the standalone Next.js output that `build.ps1` produced. The heavy
    lifting (loading .env, resolving DATABASE_URL, reporting the token state)
    lives in scripts\start-prod.mjs so that `bun run start` and this script
    behave identically on every platform.

    A token is mandatory in production: if AGENTSCOPE_API_TOKEN is not set in
    .env the server starts but every mutating API call is rejected
    (fail-closed).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-prod.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-prod.ps1 -Port 3001
#>
[CmdletBinding()]
param(
    [int]$Port = 3000,
    [string]$BindHost = '0.0.0.0'
)

$ErrorActionPreference = 'Stop'
$studioRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $studioRoot

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "    OK  $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "    !!  $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "    XX  $Message" -ForegroundColor Red }

$standalone = Join-Path $studioRoot '.next\standalone\server.js'
if (-not (Test-Path -LiteralPath $standalone)) {
    Write-Fail 'The standalone build is missing - run scripts\windows\build.ps1 first.'
    exit 1
}

# the token state is reported for convenience; the server itself is the
# authority (scripts\start-prod.mjs reads the same .env file)
$envFile = Join-Path $studioRoot '.env'
$tokenConfigured = $false
if (Test-Path -LiteralPath $envFile) {
    $tokenConfigured = (Get-Content -LiteralPath $envFile -Raw) -match '(?m)^AGENTSCOPE_API_TOKEN=\s*\S+'
}
if ($tokenConfigured) {
    Write-Ok 'AGENTSCOPE_API_TOKEN is configured in .env'
} else {
    Write-Warn 'AGENTSCOPE_API_TOKEN is NOT set - every mutating API call will be rejected (fail-closed).'
}

Write-Step "Starting the production server on http://localhost:$Port"
node (Join-Path $studioRoot 'scripts\start-prod.mjs') --port $Port --host $BindHost
