@echo off
setlocal
cd /d "%~dp0"
title Local Markdown Reader
echo Local Markdown Reader
echo.
echo 启动后会提示输入监听根目录和自定义 CSS 文件路径。
echo 根目录直接回车默认使用桌面；CSS 直接回车使用默认样式。
echo.
if exist "%~dp0md-pdf-agent.exe" (
  "%~dp0md-pdf-agent.exe"
) else (
  cd /d "%~dp0.."
  npm run dev
)
echo.
echo 程序已退出，按任意键关闭窗口。
pause >nul
