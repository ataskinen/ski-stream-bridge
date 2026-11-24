@echo off
cd /d "%~dp0"
if exist SkiStreamBridge.exe (
  SkiStreamBridge.exe --config config.json %*
) else (
  node src\cli.cjs --config config.json %*
)
if errorlevel 1 pause
