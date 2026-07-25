@echo off
setlocal
cd /d "%~dp0"
title Img2PPT v0.5.1

if not exist "runtime\node.exe" (
  echo.
  echo [ERROR] runtime\node.exe is missing.
  echo Please extract the complete ZIP before running this file.
  echo.
  pause
  exit /b 1
)

if not exist "app\src\server.mjs" (
  echo.
  echo [ERROR] Application files are incomplete.
  echo Please extract the complete ZIP again.
  echo.
  pause
  exit /b 1
)

echo Starting Img2PPT v0.5.1...
echo Your browser will open automatically.
"runtime\node.exe" "app\src\server.mjs"

if errorlevel 1 (
  echo.
  echo Img2PPT stopped because of an error.
  pause
)
