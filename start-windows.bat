@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required. Install it with: winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
node scripts\check-node.mjs
if errorlevel 1 (
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)
call npm start -- %*
pause
