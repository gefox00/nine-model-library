@echo off
set "ELECTRON_RUN_AS_NODE="
set "APP_DIR=%~dp0release\win-unpacked"
if exist "%APP_DIR%\Nine print model hub.exe" (
  start "" "%APP_DIR%\Nine print model hub.exe"
) else if exist "%APP_DIR%\Nine Model Library.exe" (
  start "" "%APP_DIR%\Nine Model Library.exe"
) else (
  cd /d "%~dp0"
  call npm start
)
