@echo off
rem Lanzador WA Bridge para Windows
cd /d "%~dp0"
title WA Bridge
where node >nul 2>nul
if errorlevel 1 (
  echo No encuentro Node. Instalalo desde https://nodejs.org ^(version 22 o mas^) y vuelve a abrir este archivo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo Node %%v
where pnpm >nul 2>nul
if errorlevel 1 (
  echo Instalando pnpm ^(una sola vez^)...
  call npm install -g pnpm@10
  if errorlevel 1 ( echo Fallo instalar pnpm & pause & exit /b 1 )
)
call pnpm install
if errorlevel 1 ( echo Fallo pnpm install & pause & exit /b 1 )
start "" cmd /c "timeout /t 10 /nobreak >nul & start http://localhost:5190"
call pnpm dev
echo El servidor se detuvo.
pause
