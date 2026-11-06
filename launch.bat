@echo off
title 散户之盾 · 一键启动
cd /d "C:\Users\10166\.agents\skills\futures-analyzer"

rem ① 检查服务是否已在运行
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8300 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if %errorlevel%==0 (
    echo [1/3] 服务已在运行
) else (
    echo [1/3] 启动服务...
    start /min "" ".venv\Scripts\python.exe" "app.py"
    timeout /t 5 /nobreak >nul
)

rem ② 检查桌面助手是否已在运行
powershell -NoProfile -Command "if (Get-Process pythonw -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle -eq '散户之盾'}) { exit 0 } else { exit 1 }"
if %errorlevel%==0 (
    echo [2/3] 助手已在运行
) else (
    echo [2/3] 启动桌面助手...
    start "" ".venv\Scripts\pythonw.exe" "desktop_assistant.pyw"
    timeout /t 2 /nobreak >nul
)

rem ③ 打开浏览器
echo [3/3] 打开主界面...
start "" "http://127.0.0.1:8300"

echo.
echo  ♜ 散户之盾已启动
echo  主界面: http://127.0.0.1:8300
echo  桌面助手: 屏幕左上角置顶迷你窗
echo.
timeout /t 3 >nul
