@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude-gemini-menu.ps1" %*
