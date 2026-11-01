@rem Chrome starts SportsWitch Updater through this file. Keep it one command ending in "& exit /b": an update can replace this file while it runs.
@"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0sportswitch_updater.ps1" & exit /b
