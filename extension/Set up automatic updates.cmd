@echo off
rem Turns on automatic updates for the SportsWitch in this folder (see updater\setup.ps1). Run it once per computer.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0updater\setup.ps1" %*
echo.
pause
