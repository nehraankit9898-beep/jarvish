<#
.SYNOPSIS
    Starts the AgentScope Studio development server on Windows.

.DESCRIPTION
    Verifies that the database and the Prisma client exist, then starts the
    Next.js dev server. The port can be changed with -Port.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-dev.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-dev.ps1 -Port 3001
#>
[CmdletBinding()]
param(
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$studioRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $studioRoot

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "    OK  $Message" -ForegroundColor Green }
function Write-Fail { param([string]$Message) Write-Host "    XX  $Message" -ForegroundColor Red }

if (-not (Test-Path -LiteralPath (Join-Path $studioRoot 'node_modules'))) {
    Write-Fail 'node_modules is missing - run scripts\windows\setup.ps1 first.'
    exit 1
}

$dbFile = Join-Path $studioRoot 'db\custom.db'
if (-not (Test-Path -LiteralPath $dbFile)) {
    Write-Step 'The database is missing - creating it'
    if (Get-Command bun -ErrorAction SilentlyContinue) {
        bunx prisma db push
    } else {
        npx prisma db push
    }
    Write-Ok 'Database created'
}

Write-Step "Starting the dev server on http://localhost:$Port"
if (Get-Command bun -ErrorAction SilentlyContinue) {
    bunx next dev -p $Port
} else {
    npx next dev -p $Port
}
