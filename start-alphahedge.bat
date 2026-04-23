@echo off
setlocal EnableExtensions EnableDelayedExpansion
title AlphaHedge Launcher
cd /d "%~dp0"

echo ================================
echo   AlphaHedge Launcher
echo ================================
echo.

:: Auto-update from GitHub when this folder is a clean git clone.
:: If the user has local edits, skip update to avoid overwriting their work.
echo [Update] Checking for GitHub updates...
where git >nul 2>&1
if errorlevel 1 (
    echo [Update] Git not found. Skipping auto-update.
    echo.
    goto after_update
)
if not exist ".git" (
    echo [Update] This folder is not a git clone. Skipping auto-update.
    echo.
    goto after_update
)

set HAS_LOCAL_CHANGES=
for /f %%s in ('git status --porcelain') do set HAS_LOCAL_CHANGES=1
if defined HAS_LOCAL_CHANGES (
    echo [Update] Local changes found. Skipping auto-update.
    echo [Update] Commit/stash changes or use a fresh clone to auto-update.
    echo.
    goto after_update
)

git fetch origin main
if errorlevel 1 (
    echo [Update] Could not reach GitHub. Starting current local version.
    echo.
    goto after_update
)

set LOCAL_COMMIT=
set REMOTE_COMMIT=
for /f %%h in ('git rev-parse HEAD') do set LOCAL_COMMIT=%%h
for /f %%h in ('git rev-parse origin/main') do set REMOTE_COMMIT=%%h

if not "!LOCAL_COMMIT!"=="!REMOTE_COMMIT!" (
    echo [Update] New version found. Updating...
    git pull --ff-only origin main
    if errorlevel 1 (
        echo.
        echo ERROR: Auto-update failed. Please resolve git state manually.
        pause
        exit /b 1
    )
    echo [Update] Updated successfully.
) else (
    echo [Update] Already up to date.
)
echo.

:after_update

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
echo [1/4] Starting Nubra WS Bridge...
start "Nubra WS Bridge" cmd /k ""%PYTHON_EXE%" "%BRIDGE_SCRIPT%""

:: Always delete old dist and rebuild fresh to avoid stale chunk 404s
echo [2/4] Cleaning old build and rebuilding...
if exist "dist" rmdir /s /q "dist"
call npm run build
if errorlevel 1 (
    echo.
    echo ERROR: Build failed! Check the output above.
    pause
    exit /b 1
)
echo Build complete!

echo [3/4] Starting AlphaHedge API server...
start "AlphaHedge API Server" cmd /k "call npm run server"

echo [4/4] Starting AlphaHedge production preview...
echo.
echo App will run at http://localhost:8888
echo API server runs at http://localhost:3001
echo.
call npm run preview
