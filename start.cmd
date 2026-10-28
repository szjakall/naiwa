@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
	echo.
	echo   [regedit] 未找到 node.exe
	echo   请先安装 Node.js 20 或更高版本：https://nodejs.org/
	echo.
	pause
	exit /b 1
)

echo.
echo   regedit 正在启动，控制台地址会打印在下面（默认 http://127.0.0.1:8848/）
echo   关闭这个窗口即停止服务。
echo.

node server\index.mjs
echo.
echo   [regedit] 已退出。
pause