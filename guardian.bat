@echo off
title FuturesAnalyzer Guardian
cd /d "C:\Users\10166\.agents\skills\futures-analyzer"

rem ---- 单实例锁：mkdir 原子性，日期做名防陈旧锁（每天最多一个守护） ----
set "LOCKDIR=%TEMP%\fa_guardian_lock_%date:~0,4%%date:~5,2%%date:~8,2%"
md "%LOCKDIR%" 2>nul
if errorlevel 1 (
  echo guardian already running today - exit
  exit /b 0
)

:loop
rem Port 8300 already listening? -> recheck in 5 min
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8300 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if %errorlevel%==0 (
  timeout /t 300 /nobreak >nul
  goto loop
)

rem Rotate log if over 10MB
if exist server.log for %%F in (server.log) do if %%~zF GTR 10485760 move /y server.log server_old.log >nul

rem Start server with absolute python path; when it exits, restart in 5s
echo [%date% %time%] starting server >> server.log
"C:\Users\10166\.agents\skills\futures-analyzer\.venv\Scripts\python.exe" "C:\Users\10166\.agents\skills\futures-analyzer\app.py" >> server.log 2>&1
echo [%date% %time%] server exited, restarting in 5s >> server.log
timeout /t 5 /nobreak >nul
goto loop
