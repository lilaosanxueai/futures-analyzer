@echo off
title FuturesAnalyzer Guardian
cd /d "%~dp0"

:loop
rem Port 8300 already listening? -> recheck in 5 min
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8300 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if %errorlevel%==0 (
  timeout /t 300 /nobreak >nul
  goto loop
)

rem Rotate log if over 10MB
if exist server.log for %%F in (server.log) do if %%~zF GTR 10485760 move /y server.log server_old.log >nul

rem Start server; when it exits, restart in 5s
echo [%date% %time%] starting server >> server.log
python app.py >> server.log 2>&1
echo [%date% %time%] server exited, restarting in 5s >> server.log
timeout /t 5 /nobreak >nul
goto loop
