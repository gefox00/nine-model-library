@echo off
set "ELECTRON_RUN_AS_NODE="
if exist "%~dp0release\win-unpacked\Nine Model Library.exe" (
  start "" "%~dp0release\win-unpacked\Nine Model Library.exe"
) else (
  cd /d "%~dp0"
  call npm start
)
