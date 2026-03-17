@echo off
title AlphaHedge Launcher
cd /d "C:\Users\guddu\Alphahedge-product"

echo ================================
echo   AlphaHedge Launcher
echo ================================
echo.

:: Start Nubra WS Bridge in background
echo [1/3] Starting Nubra WS Bridge...
start "Nubra WS Bridge" cmd /k "cd /d C:\Users\guddu\Alphahedge-product && python nubra_ws_bridge.py"

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
