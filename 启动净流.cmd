@echo off
chcp 65001 >nul
title 净流 · 本地视频导出
cd /d "%~dp0"

if not exist "node_modules" (
  echo [净流] 正在安装应用依赖...
  call npm ci
  if errorlevel 1 goto :failed
)

if not exist ".engine\engine.json" (
  echo [净流] 首次运行，正在安装解析引擎...
  call yarn run setup:engine
  if errorlevel 1 goto :failed
)

if not exist "dist\client\index.html" (
  echo [净流] 正在构建页面...
  call yarn run build
  if errorlevel 1 goto :failed
)

echo [净流] 正在启动，浏览器将在 2 秒后打开...
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8787'"
call yarn run start
goto :eof

:failed
echo.
echo [净流] 启动失败，请保留此窗口并检查上方提示。
pause
