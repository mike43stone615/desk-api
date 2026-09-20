# Wrapper for the scheduled backup task (Task Scheduler can't easily run
# "npm run backup" directly with a correct working directory + PATH, so
# this pins both explicitly, mirroring the same wrapper-script pattern
# desk_app's resync_registry.ps1 scheduled task already uses).
$ErrorActionPreference = "Stop"
Set-Location "C:\Users\User\desk-api"
$env:Path = "C:\Program Files\nodejs;$env:Path"

# The repo's own .env points at the development database. The backup must always be of the REAL one, so take
# DATABASE_URL from the deployed service's settings (the file the live service itself runs with). It is read into the
# process environment only and never printed.
$deployedEnv = "C:\actions-runners\desk-api\_work\desk-api\desk-api\.env"
if (-not (Test-Path $deployedEnv)) { throw "Deployed settings not found at $deployedEnv" }
$line = Select-String -Path $deployedEnv -Pattern '^DATABASE_URL\s*=' | Select-Object -First 1
if (-not $line) { throw "DATABASE_URL is not set in the deployed settings" }
$env:DATABASE_URL = ($line.Line -replace '^DATABASE_URL\s*=\s*', '').Trim().Trim('"').Trim("'")

npm run backup
if ($LASTEXITCODE -ne 0) {
  Write-Host "Backup failed with exit code $LASTEXITCODE"
  exit $LASTEXITCODE
}
Write-Host "Backup completed successfully."
