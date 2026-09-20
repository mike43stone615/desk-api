@echo off
setlocal
set /p TOKEN=<"C:\Users\User\.cloudflared\desk-local-services.token"
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --no-autoupdate run --token %TOKEN% >> "%TEMP%\desk-local-services-cloudflared.out.log" 2>> "%TEMP%\desk-local-services-cloudflared.err.log"
