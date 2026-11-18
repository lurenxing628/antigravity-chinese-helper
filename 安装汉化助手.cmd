@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Install-Helper.ps1" %*
set "AGH_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %AGH_EXIT%
