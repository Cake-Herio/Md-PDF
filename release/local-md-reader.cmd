@echo off
setlocal
cd /d "%~dp0"
title Local Markdown Reader
echo Local Markdown Reader
echo.
echo 启动后会提示输入监听根目录和服务器地址。
echo 根目录直接回车默认使用桌面；服务器地址直接回车使用上次保存的地址或 http://localhost:50001。
echo.
if exist "%~dp0md-pdf-agent.exe" (
  "%~dp0md-pdf-agent.exe"
) else (
  cd /d "%~dp0.."
  npm run dev:agent
)
echo.
echo 程序已退出，按任意键关闭窗口。
pause >nul
