@echo off
REM AgentScope Studio - one-shot start (Windows)
REM Prefers bun, falls back to npm. See docs\WINDOWS_SETUP.md for the full guide.
setlocal
cd /d "%~dp0studio"

if not exist node_modules (
  echo Installing dependencies...
  where bun >nul 2>nul
  if %ERRORLEVEL%==0 (
    call bun install
  ) else (
    call npm install
  )
)

echo Preparing database...
where bun >nul 2>nul
if %ERRORLEVEL%==0 (
  call bunx prisma db push
) else (
  call npx prisma db push
)

echo Starting AgentScope Studio at http://localhost:3000
where bun >nul 2>nul
if %ERRORLEVEL%==0 (
  call bunx next dev -p 3000
) else (
  call npx next dev -p 3000
)

endlocal
