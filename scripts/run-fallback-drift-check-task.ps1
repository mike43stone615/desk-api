# Wrapper for the scheduled fallback-drift-check task -- pins working
# directory and PATH the same way run-backup-task.ps1 does. Output is
# logged to a rotating file since there's no dashboard for this yet;
# check the log after each run for real drift to act on.
$ErrorActionPreference = "Stop"
Set-Location "C:\Users\User\desk-api"
$env:Path = "C:\Program Files\nodejs;$env:Path"
$logDir = "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "fallback-drift-$(Get-Date -Format 'yyyy-MM-dd').log"
npm run check-fallback-drift *> $logFile
Get-Content $logFile
if ($LASTEXITCODE -ne 0) {
  Write-Host "Fallback drift check failed (a live service was unreachable) -- see $logFile"
  exit $LASTEXITCODE
}
Write-Host "Fallback drift check completed -- see $logFile for the report."
