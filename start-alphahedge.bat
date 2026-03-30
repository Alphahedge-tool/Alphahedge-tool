@echo off
title AlphaHedge Launcher
cd /d "%~dp0"

echo ================================
echo   AlphaHedge Launcher
echo ================================
echo.

:: Auto-detect Python executable
set PYTHON_EXE=
for %%p in (python python3 py) do (
    if not defined PYTHON_EXE (
        where %%p >nul 2>&1 && set PYTHON_EXE=%%p
    )
)
if not defined PYTHON_EXE (
    echo ERROR: Python not found in PATH. Please install Python.
    pause
    exit /b 1
)
echo [Python] Using: %PYTHON_EXE%

:: Auto-detect bridge script (same folder as this bat)
set BRIDGE_SCRIPT=%~dp0nubra_ws_bridge.py
if not exist "%BRIDGE_SCRIPT%" (
    echo ERROR: nubra_ws_bridge.py not found at %BRIDGE_SCRIPT%
    pause
    exit /b 1
)
echo [Bridge] Found: %BRIDGE_SCRIPT%
echo.

:: Start Nubra WS Bridge in background
echo [1/3] Starting Nubra WS Bridge...
start "Nubra WS Bridge" cmd /k "%PYTHON_EXE% "%BRIDGE_SCRIPT%""

:: Always delete old dist and rebuild fresh to avoid stale chunk 404s
echo [2/3] Cleaning old build and rebuilding...
if exist "dist" rmdir /s /q "dist"
call npm run build
if errorlevel 1 (
    echo.
    echo ERROR: Build failed! Check the output above.
    pause
    exit /b 1
)
echo Build complete!

echo [3/3] Starting AlphaHedge...
echo.
npm run start
