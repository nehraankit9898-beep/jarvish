@echo off
REM ---------------------------------------------------------------------------
REM  AgentScope Studio - one-click Windows launcher.
REM
REM  Usage:
REM    start-studio.bat            start the development server on port 3000
REM    start-studio.bat 3001       start it on another port
REM    start-studio.bat prod       start the PRODUCTION server (needs a build)
REM
REM  The heavy lifting lives in scripts\windows\*.ps1 so that the behaviour is
REM  identical from the batch file and from PowerShell.
REM ---------------------------------------------------------------------------
setlocal

set "STUDIO_ROOT=%~dp0"
set "PORT=%~1"

if "%PORT%"=="" set "PORT=3000"

if /i "%PORT%"=="prod" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%STUDIO_ROOT%scripts\windows\start-prod.ps1" -Port 3000
    goto :eof
)

where bun >nul 2>nul
if not exist "%STUDIO_ROOT%node_modules" (
    echo [SETUP] node_modules is missing - running the setup script first...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%STUDIO_ROOT%scripts\windows\setup.ps1" -SkipTests
    if errorlevel 1 (
        echo [FAIL] setup failed.
        exit /b 1
    )
)

echo [START] AgentScope Studio -^> http://localhost:%PORT%
powershell -NoProfile -ExecutionPolicy Bypass -File "%STUDIO_ROOT%scripts\windows\start-dev.ps1" -Port %PORT%
goto :eof
