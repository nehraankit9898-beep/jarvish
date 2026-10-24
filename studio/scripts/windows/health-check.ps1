<#
.SYNOPSIS
    Health check for a running AgentScope Studio.

.DESCRIPTION
    Calls /api/health and /api/system/status and prints a readable summary:
    database, environment, providers, tools, python runtime and the security
    policy. Exit code 0 = healthy, 1 = degraded, 2 = the server is unreachable.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\windows\health-check.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\windows\health-check.ps1 -BaseUrl http://localhost:3001
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://localhost:3000',
    [int]$TimeoutSec = 30
)

$ErrorActionPreference = 'Stop'

function Write-Ok   { param([string]$Message) Write-Host "  [OK]   $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  [WARN] $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "  [FAIL] $Message" -ForegroundColor Red }
function Write-Info { param([string]$Message) Write-Host "  [INFO] $Message" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "AgentScope Studio health check - $BaseUrl" -ForegroundColor White
Write-Host ""

# ------------------------------------------------------------------ health --
try {
    $health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -TimeoutSec $TimeoutSec
} catch {
    Write-Fail "The server is not reachable: $($_.Exception.Message)"
    Write-Host ""
    exit 2
}

if ($health.status -eq 'ok') {
    Write-Ok "health: $($health.status) (uptime $($health.uptimeSeconds)s)"
} else {
    Write-Fail "health: $($health.status)"
    if ($health.checks.database.error) {
        Write-Fail "database: $($health.checks.database.error)"
    }
}
Write-Info "database latency: $($health.checks.database.latencyMs) ms"

# ------------------------------------------------------------------ status --
try {
    $status = Invoke-RestMethod -Uri "$BaseUrl/api/system/status" -TimeoutSec $TimeoutSec
} catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 503) {
        Write-Warn 'The status endpoint is fail-closed: NODE_ENV=production without AGENTSCOPE_API_TOKEN.'
        Write-Info  'Set AGENTSCOPE_API_TOKEN in .env and restart (the token is sent as `x-agentscope-token` or `Authorization: Bearer <token>`).'
    } else {
        Write-Warn "The status endpoint is not reachable: $($_.Exception.Message)"
    }
    Write-Host ""
    if ($health.status -ne 'ok') { exit 1 }
    exit 0
}

Write-Ok "providers: $($status.providers.total) configured, $($status.providers.enabled) enabled, $($status.providers.withKey) with a key"
Write-Ok "tools: $($status.tools.healthy)/$($status.tools.total) healthy"
if ($status.python.ok) {
    Write-Ok "python: $($status.python.version) (agentscope: $($status.python.agentscope))"
} else {
    Write-Warn "python: not available - $($status.python.hint)"
}

if ($status.env.issues -and $status.env.issues.Count -gt 0) {
    Write-Host ""
    Write-Host "  Configuration issues:" -ForegroundColor White
    foreach ($issue in $status.env.issues) {
        if ($issue.severity -eq 'error') {
            Write-Fail "$($issue.name): $($issue.message)"
        } else {
            Write-Warn "$($issue.name): $($issue.message)"
        }
    }
} else {
    Write-Ok "configuration: no issues"
}

Write-Host ""
if ($health.status -eq 'ok' -and -not ($status.env.issues | Where-Object { $_.severity -eq 'error' })) {
    Write-Host "Result: HEALTHY" -ForegroundColor Green
    exit 0
}
Write-Host "Result: DEGRADED" -ForegroundColor Yellow
exit 1
