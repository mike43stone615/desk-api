# Wrapper for the scheduled backup task (Task Scheduler can't easily run
# "npm run backup" directly with a correct working directory + PATH, so
# this pins both explicitly, mirroring the same wrapper-script pattern
# desk_app's resync_registry.ps1 scheduled task already uses).
$ErrorActionPreference = "Stop"
Set-Location "C:\Users\User\desk-api"
$env:Path = "C:\Program Files\nodejs;$env:Path"
npm run backup
if ($LASTEXITCODE -ne 0) {
  Write-Host "Backup failed with exit code $LASTEXITCODE"
  exit $LASTEXITCODE
}
Write-Host "Backup completed successfully."
