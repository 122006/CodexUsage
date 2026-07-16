@echo off
setlocal

set "APP_DIR=%~dp0dist\win-unpacked"

if not exist "%APP_DIR%" (
  echo Application directory not found: "%APP_DIR%"
  echo Run npm run package first.
  pause
  exit /b 1
)

if exist "%APP_DIR%\CodexUsage.exe" (
  start "" /D "%APP_DIR%" "%APP_DIR%\CodexUsage.exe"
  exit /b 0
)

echo Application executable not found in: "%APP_DIR%"
pause
exit /b 1
