@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   期货实时分析助手
echo   启动后请用浏览器打开 http://127.0.0.1:8300
echo   关闭窗口或按 Ctrl+C 退出
echo ============================================
python app.py
pause
