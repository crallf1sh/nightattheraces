@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or later is required. Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Preparing Night at the Races for first use...
  call npm install
)
start "" "http://localhost:3000/admin"
echo Night at the Races is starting. Keep this window open while the event is running.
call npm start
