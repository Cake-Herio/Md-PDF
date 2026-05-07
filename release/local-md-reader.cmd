@echo off
setlocal
cd /d "%~dp0.."
title Local Markdown Reader
echo Local Markdown Reader
echo.
echo 启动后请输入要监听的 Markdown 文件夹路径。
echo 示例: C:\Users\wenxiang\Desktop
echo.
node dist\index.js
echo.
echo 程序已退出，按任意键关闭窗口。
pause >nul
