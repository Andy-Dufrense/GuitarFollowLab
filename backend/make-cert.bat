@echo off
setlocal
cd /d "%~dp0"
title Guitar Follow Lab - make certificate

echo.
echo   Generating a self-signed certificate for phone access ...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-cert.ps1"

if errorlevel 1 (
  echo.
  echo   [x] Failed. See the message above.
  echo.
)

pause
