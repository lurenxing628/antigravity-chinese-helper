@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Uninstall-AutoStart.ps1" %*
set "AGH_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %AGH_EXIT%
