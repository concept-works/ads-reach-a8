@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title ADS-REACH-A8 - Windows Build
set "LOG=%~dp0build-windows.log"
>"%LOG%" echo ADS-REACH-A8 build log
>>"%LOG%" echo Working directory: %CD%
echo =====================================
echo ADS-REACH-A8 v0.5.1 Windows Build
echo =====================================
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed on this BUILD PC.
  >>"%LOG%" echo ERROR: node.exe was not found.
  goto :failed
)
where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm was not found.
  >>"%LOG%" echo ERROR: npm was not found.
  goto :failed
)
call :run_install
if errorlevel 1 goto :failed
call :run_checks
if errorlevel 1 goto :failed
if exist "dist\ADS-REACH-A8-*-portable-x64.exe" del /q "dist\ADS-REACH-A8-*-portable-x64.exe" >>"%LOG%" 2>&1
call :run_build
if errorlevel 1 goto :failed
for /f "delims=" %%F in ('dir /b /a-d "dist\ADS-REACH-A8-*-portable-x64.exe" 2^>nul') do set "BUILT_EXE=%%F"
if not defined BUILT_EXE (
  echo [ERROR] The expected EXE was not generated.
  >>"%LOG%" echo ERROR: expected portable EXE not found.
  goto :failed
)
echo.
echo [SUCCESS] Portable EXE created: %BUILT_EXE%
>>"%LOG%" echo SUCCESS: Portable EXE created: %BUILT_EXE%
start "" "%~dp0dist"
exit /b 0
:run_install
echo [1/3] Installing dependencies...
call npm install --no-audit --no-fund >>"%LOG%" 2>&1
if errorlevel 1 (
 echo [ERROR] npm install failed. See build-windows.log
 exit /b 1
)
exit /b 0
:run_checks
echo [2/3] Checking JavaScript...
node --check src\main.js >>"%LOG%" 2>&1
if errorlevel 1 exit /b 1
node --check src\preload.js >>"%LOG%" 2>&1
if errorlevel 1 exit /b 1
exit /b 0
:run_build
echo [3/3] Building portable EXE...
call npm run build:win >>"%LOG%" 2>&1
if errorlevel 1 (
 echo [ERROR] electron-builder failed. See build-windows.log
 exit /b 1
)
exit /b 0
:failed
echo.
echo Build failed. Please share build-windows.log.
echo (This window is kept open ONLY when the build fails.)
pause
exit /b 1
