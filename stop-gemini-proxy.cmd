@echo off
setlocal

if "%GEMINI_PROXY_PORT%"=="" set "GEMINI_PROXY_PORT=11435"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$conn = Get-NetTCPConnection -LocalPort %GEMINI_PROXY_PORT% -State Listen -ErrorAction SilentlyContinue; if ($conn) { Stop-Process -Id $conn.OwningProcess -Force; Write-Output ('Stopped Gemini proxy on port %GEMINI_PROXY_PORT%') } else { Write-Output ('No Gemini proxy is listening on port %GEMINI_PROXY_PORT%') }"
