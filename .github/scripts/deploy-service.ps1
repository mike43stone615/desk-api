# Deploy helper for this repo's native (non-Docker) backend service.
# Invoked by .github/workflows/deploy.yml on the self-hosted runner, AFTER
# actions/checkout has already placed the right commit at $RepoPath.
#
# This script lives inside the repo (checked out alongside the code) rather
# than under C:\Users\User\.cloudflared\ on the host: the runner service
# account (NT AUTHORITY\NetworkService) has no access to the interactive
# user's home directory at all, so a script invoked from there fails with
# CommandNotFoundException no matter how the code itself gets fetched.
# Keeping this copy under version control means it travels with checkout
# into a location the runner's own service account already owns.
param(
  [Parameter(Mandatory = $true)][string]$RepoPath,
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$StartCommand,   # e.g. "start" or "dev"
  [switch]$Build                                          # run `npm run build` after install
)

$ErrorActionPreference = 'Stop'
Set-Location $RepoPath

Write-Output "=== Deploying $RepoPath (port $Port) ==="

npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

if ($Build) {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
}

$owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)
if ($owner) {
  Write-Output "Stopping current process on port $Port (PID $owner)"
  Stop-Process -Id $owner -Force
  Start-Sleep -Seconds 2
}

$temp = [System.IO.Path]::GetTempPath()
Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', $StartCommand) -WorkingDirectory $RepoPath `
  -RedirectStandardOutput (Join-Path $temp "$(Split-Path $RepoPath -Leaf).out.log") `
  -RedirectStandardError (Join-Path $temp "$(Split-Path $RepoPath -Leaf).err.log") `
  -WindowStyle Hidden

# 30s was too tight: confirmed live that a service started right after a
# fresh `npm ci` under this account can take well over 30s to bind (likely
# Windows Defender scanning the just-written node_modules) even though the
# same code starts in ~12s from a warm directory — the process was healthy
# and serving fine within minutes, the deploy just gave up on it too early.
$deadline = (Get-Date).AddSeconds(90)
do {
  Start-Sleep -Seconds 2
  try {
    $health = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 3
    if ($health.StatusCode -eq 200) {
      Write-Output "Healthy: $($health.Content)"
      exit 0
    }
  } catch {}
} while ((Get-Date) -lt $deadline)

throw "Service did not report healthy on port $Port within 90s of restart."
