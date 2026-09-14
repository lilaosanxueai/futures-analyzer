@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ---- already running? just open browser ----
netstat -ano -p tcp | findstr "127.0.0.1:8300" | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo Already running - opening http://127.0.0.1:8300
  start "" "http://127.0.0.1:8300"
  timeout /t 2 /nobreak >nul
  exit /b 0
)

echo ============================================
echo   futures-analyzer starting...
echo   console window = service, close it to STOP
echo ============================================
rem ---- pick interpreter: .venv if present, else system Python312 (same as guardian.bat) ----
set "PY=.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=C:\Users\weimin8\AppData\Local\Programs\Python\Python312\python.exe"
start "futures-analyzer" /min "%PY%" app.py

set /a tries=0
:wait
timeout /t 1 /nobreak >nul
set /a tries+=1
netstat -ano -p tcp | findstr "127.0.0.1:8300" | findstr "LISTENING" >nul
if %errorlevel%==0 goto ready
if %tries% lss 20 goto wait
echo port 8300 not ready after 20s - check the python window for errors
pause
exit /b 1

:ready
start "" "http://127.0.0.1:8300"
echo READY - http://127.0.0.1:8300
timeout /t 2 /nobreak >nul
