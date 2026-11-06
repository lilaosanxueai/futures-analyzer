@echo off
rem ==== self-relaunch hidden (ASCII only in this block) ====
if "%~1"=="__hidden__" goto :run
set "VBS=%TEMP%\fa_start.vbs"
> "%VBS%" echo Set sh = CreateObject("WScript.Shell")
>> "%VBS%" echo sh.CurrentDirectory = "%~dp0"
>> "%VBS%" echo sh.Run "cmd /c ""%~f0"" __hidden__", 0, False
start "" wscript.exe "%VBS%"
exit /b 0

:run
chcp 65001 >nul
cd /d "%~dp0"
set "PY=%~dp0.venv\Scripts\python.exe"

rem ---- 服务已在运行？ ----
netstat -ano -p tcp | findstr ":8300" | findstr "LISTENING" >nul
if %errorlevel%==0 goto :assistant

rem ---- 隐藏启动服务：0 窗口，日志进 server.log ----
> "%TEMP%\fa_server.vbs" echo Set sh = CreateObject("WScript.Shell")
>> "%TEMP%\fa_server.vbs" echo sh.CurrentDirectory = "%~dp0"
>> "%TEMP%\fa_server.vbs" echo sh.Run "cmd /c %PY% app.py >> server.log 2>&1", 0, False
wscript "%TEMP%\fa_server.vbs"

set /a tries=0
:wait
ping -n 3 127.0.0.1 >nul
netstat -ano -p tcp | findstr ":8300" | findstr "LISTENING" >nul
if %errorlevel%==0 goto :assistant
set /a tries+=1
if %tries% lss 15 goto :wait

:assistant
rem ---- 桌面助手（pythonw 本身无窗口）----
powershell -NoProfile -Command "if (Get-Process pythonw -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle -eq '散户之盾'}) { exit 0 } else { exit 1 }"
if %errorlevel%==0 goto :open
start "" "%~dp0.venv\Scripts\pythonw.exe" "%~dp0desktop_assistant.pyw"

:open
rem ---- 直接打开网页 ----
start "" "http://127.0.0.1:8300"
exit /b 0
