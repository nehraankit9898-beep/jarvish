<#
.SYNOPSIS
    One-shot Windows setup for AgentScope Studio.

.DESCRIPTION
    Checks the toolchain, installs the dependencies, creates a .env file with
    generated secrets, applies the Prisma schema to the SQLite database and
    runs the test suite. Everything is done relative to this script, so the
    folder can live anywhere on disk.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1 -SkipTests
#>
[CmdletBinding()]
param(
    [switch]$SkipTests,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$studioRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $studioRoot

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "    OK  $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "    !!  $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "    XX  $Message" -ForegroundColor Red }

Write-Host ""
Write-Host "AgentScope Studio - Windows setup" -ForegroundColor White
Write-Host "Project: $studioRoot" -ForegroundColor DarkGray
Write-Host ""

# ---------------------------------------------------------------- toolchain --
Write-Step 'Checking the toolchain'

$packageManager = $null
if (Get-Command bun -ErrorAction SilentlyContinue) {
    $packageManager = 'bun'
    Write-Ok "bun $(bun --version)"
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
    $packageManager = 'npm'
    Write-Ok "node $(node --version) / npm $(npm --version)"
} else {
    Write-Fail 'Neither bun nor node was found. Install Node.js 20+ from https://nodejs.org (bun is recommended).'
    exit 1
}

$pythonBin = $null
foreach ($candidate in @('python3', 'python', 'py')) {
    if (Get-Command $candidate -ErrorAction SilentlyContinue) {
        $pythonBin = $candidate
        break
    }
}
if ($pythonBin) {
    Write-Ok "python ($pythonBin) - optional, used by the AgentScope bridge"
} else {
    Write-Warn 'No Python found. The Studio works without it; the AgentScope Python bridge stays disabled.'
}

# ------------------------------------------------------------ dependencies --
if (-not (Test-Path -LiteralPath (Join-Path $studioRoot 'node_modules'))) {
    Write-Step 'Installing dependencies (this takes a minute)'
    if ($packageManager -eq 'bun') { bun install } else { npm install }
    Write-Ok 'Dependencies installed'
} else {
    Write-Ok 'node_modules already present (delete it to reinstall)'
}

# -------------------------------------------------------------------- .env --
$envPath = Join-Path $studioRoot '.env'
if ((-not (Test-Path -LiteralPath $envPath)) -or $Force) {
    Write-Step 'Creating .env'
    $example = Join-Path $studioRoot '.env.example'
    if (Test-Path -LiteralPath $example) {
        Copy-Item -LiteralPath $example -Destination $envPath -Force
    } else {
        "DATABASE_URL=file:../db/custom.db" | Set-Content -LiteralPath $envPath -Encoding UTF8
    }

    # generate the secrets that must not be committed
    $token = [guid]::NewGuid().ToString('N')
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''

    $content = Get-Content -LiteralPath $envPath -Raw
    $content = $content -replace '(?m)^AGENTSCOPE_API_TOKEN=.*$', "AGENTSCOPE_API_TOKEN=$token"
    $content = $content -replace '(?m)^AGENTSCOPE_SECRET_KEY=.*$', "AGENTSCOPE_SECRET_KEY=$secret"
    Set-Content -LiteralPath $envPath -Value $content -Encoding UTF8 -NoNewline

    Write-Ok '.env created with a generated API token and secret key'
} else {
    Write-Ok '.env already exists (use -Force to regenerate it)'
}

# ----------------------------------------------------------------- database --
Write-Step 'Applying the database schema (prisma db push)'
if ($packageManager -eq 'bun') { bunx prisma db push } else { npx prisma db push }
Write-Ok 'SQLite database is up to date'

Write-Step 'Generating the Prisma client'
if ($packageManager -eq 'bun') { bunx prisma generate } else { npx prisma generate }
Write-Ok 'Prisma client generated'

# ------------------------------------------------------------------- checks --
if (-not $SkipTests) {
    Write-Step 'Running the test suite'
    if ($packageManager -eq 'bun') { bun test } else { npm test -- --passWithNoTests }
    Write-Ok 'Tests passed'
}

Write-Host ""
Write-Host "Setup finished." -ForegroundColor Green
Write-Host "Start the Studio with:  powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-dev.ps1" -ForegroundColor Cyan
Write-Host "Or the batch file:      start-studio.bat" -ForegroundColor Cyan
Write-Host "Full guide:             docs\WINDOWS_SETUP.md" -ForegroundColor Cyan
Write-Host ""
