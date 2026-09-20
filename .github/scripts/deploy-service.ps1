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
  [switch]$Build,                                         # run `npm run build` after install
  # When given, the service runs from THIS folder (a copy of what was built), not from the checkout. That keeps the
  # old version serving while the new one is checked out, installed and built, so the only gap is the few seconds
  # between stopping the old process and the new one answering.
  [string]$LivePath = '',
  [string]$BuildCommand = 'build',                        # npm script that compiles (used with -Build)
  # Refuse to deploy while the code being deployed has database migrations that have not been applied yet (deploys
  # never run migrations; see scripts/check-migrations.ts). The old version keeps serving.
  [switch]$CheckMigrations,
  # Validate the settings file (.env written from the DOTENV_CONTENT secret) before anything is swapped.
  [switch]$ValidateEnv,
  # The supervisor's control port (src/supervisor.ts). When a supervisor is already running and only the compiled code
  # changed, the new version is swapped in with no gap at all ("hot reload"): a new worker starts, and only when it is
  # serving does the old one finish its requests and leave.
  [int]$ControlPort = 3468
)

$ErrorActionPreference = 'Stop'
Set-Location $RepoPath

Write-Output "=== Deploying $RepoPath (port $Port) ==="

npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

if ($Build) {
  npm run $BuildCommand
  if ($LASTEXITCODE -ne 0) { throw "npm run $BuildCommand failed" }
}

if ($ValidateEnv) {
  Write-Output "Validating the settings (.env) for a production deploy ..."
  npx tsx scripts/validate-env.ts .env
  if ($LASTEXITCODE -ne 0) { throw "Deploy refused: the settings (DOTENV_CONTENT secret) are not valid for production (listed above). Fix the secret and run the deploy again. The running version was not touched." }
}

if ($CheckMigrations) {
  Write-Output "Checking that every database migration in this version has been applied ..."
  npx tsx scripts/check-migrations.ts
  if ($LASTEXITCODE -ne 0) { throw "Deploy refused: there are unapplied migrations (listed above). Apply them first: npm run migrate -- --production --env-file <the deployed .env>  (--dry-run first). The running version was not touched." }
}

function Get-SupervisorStatus {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$ControlPort/status" -UseBasicParsing -TimeoutSec 3
    return ($r.Content | ConvertFrom-Json)
  } catch { return $null }
}

function Stop-CurrentService {
  # A running supervisor is asked to drain and exit (it would otherwise start its worker again).
  $sup = Get-SupervisorStatus
  if ($sup) {
    Write-Output "Asking the supervisor (PID $($sup.pid)) to stop"
    try { Invoke-WebRequest -Uri "http://127.0.0.1:$ControlPort/stop" -Method Post -UseBasicParsing -TimeoutSec 10 | Out-Null } catch {}
    for ($i = 0; $i -lt 40 -and (Get-Process -Id $sup.pid -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
    if (Get-Process -Id $sup.pid -ErrorAction SilentlyContinue) { Stop-Process -Id $sup.pid -Force }
  }
  $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)
  if ($owner) {
    Write-Output "Stopping current process on port $Port (PID $owner)"
    Stop-Process -Id $owner -Force
    Start-Sleep -Seconds 1
  }
}

function Copy-Tree([string]$from, [string]$to) {
  # robocopy: 0-7 are success codes (8+ is a failure). /MIR makes the copy identical; only changed files are written.
  robocopy $from $to /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $from -> $to failed ($LASTEXITCODE)" }
  $global:LASTEXITCODE = 0
}

# Can this release be swapped in without stopping anything? Yes when a supervisor is running, is the same supervisor
# code this release ships, and no dependencies changed (those are replaced with the service stopped).
$hot = $false
if ($LivePath) {
  $sup = Get-SupervisorStatus
  $newSup = Join-Path $RepoPath 'dist\supervisor.js'
  if ($sup -and (Test-Path $newSup) -and ((Get-FileHash $newSup -Algorithm SHA256).Hash.ToLower() -eq $sup.fingerprint)) { $hot = $true }
  elseif ($sup) { Write-Output "The supervisor itself changed: this release needs a full restart" }
  else { Write-Output "No supervisor is running (first deploy of this layout, or it was stopped): full start" }
}

if ($LivePath) {
  New-Item -ItemType Directory -Force -Path $LivePath | Out-Null
  # Everything the running service needs, and nothing else (no sources, tests, git history or dev tooling output).
  # node_modules is only replaced when the lockfile changed: its native files are locked while the service runs, and
  # copying it is the slow part, so an unchanged lockfile means a much shorter gap.
  $lockNow = (Get-FileHash (Join-Path $RepoPath 'package-lock.json')).Hash
  $liveLock = Join-Path $LivePath 'package-lock.json'
  $lockThen = if (Test-Path $liveLock) { (Get-FileHash $liveLock).Hash } else { '' }
  $depsChanged = ($lockNow -ne $lockThen) -or -not (Test-Path (Join-Path $LivePath 'node_modules'))
  if ($depsChanged) { $hot = $false }
  if ($depsChanged) {
    Write-Output "Dependencies changed: stopping the service before replacing node_modules"
    Stop-CurrentService
    Copy-Tree (Join-Path $RepoPath 'node_modules') (Join-Path $LivePath 'node_modules')
  }
  # Keep the version that is running now, so a bad release can be undone in seconds (see rollback below and
  # scripts/rollback.ps1).
  foreach ($dir in @('dist', 'library-ui')) {
    $current = Join-Path $LivePath $dir
    if (Test-Path $current) { Copy-Tree $current (Join-Path $LivePath "$dir.prev") }
  }
  foreach ($dir in @('dist', 'library-ui', 'migrations')) {
    if (Test-Path (Join-Path $RepoPath $dir)) { Copy-Tree (Join-Path $RepoPath $dir) (Join-Path $LivePath $dir) }
  }
  # The small files that decide HOW the code starts travel with it: the start command (package.json) and the settings
  # (.env) must roll back together with dist, or a restored dist would be started by the new release's command.
  foreach ($file in @('package.json', 'package-lock.json', '.env')) {
    $current = Join-Path $LivePath $file
    if (Test-Path $current) { Copy-Item -Force $current "$current.prev" }
    Copy-Item -Force (Join-Path $RepoPath $file) $current
  }
  $RepoPath = $LivePath
  Set-Location $RepoPath
  Write-Output "Prepared live copy at $LivePath"
}

# (Stop-CurrentService is called just before the new version is started, further down.)

# Start-Process's child is attached to the GitHub Actions runner's own
# Windows Job Object (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) unless explicitly
# detached -- confirmed live: the service reported healthy, then was killed
# within 20 seconds by the runner's own "Cleaning up orphan processes" step
# when THIS job finished. Every previous "successful" deploy was actually
# dying moments after reporting success. Launching via WMI's
# Win32_Process.Create instead routes creation through the WMI provider
# host (a separate service), which does not inherit the caller's job
# object, so the process survives the job's own completion.
# Logs go inside the checkout workspace, not $env:TEMP -- $env:TEMP for
# this script's own NetworkService context is NetworkService's own
# profile, which the interactive user has no read access to (same NTFS
# restriction documented above), making every failure here undebuggable
# after the fact without a manual reproduction. This location is readable
# by the interactive account, and next run's `git clean -ffdx` (already
# the first step of the next checkout) wipes it, so nothing accumulates.
$outLog = Join-Path $RepoPath "deploy.out.log"
$errLog = Join-Path $RepoPath "deploy.err.log"

function Start-Service {
  $cmdLine = "cmd.exe /c `"npm run $StartCommand > `"$outLog`" 2> `"$errLog`"`""
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = $cmdLine
    CurrentDirectory = $RepoPath
  }
  if ($created.ReturnValue -ne 0) { throw "Failed to launch service via WMI (Win32_Process.Create returned $($created.ReturnValue))" }
  Write-Output "Launched via WMI, new PID $($created.ProcessId)"
}

function Wait-Healthy([int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  do {
    Start-Sleep -Seconds 2
    try {
      $health = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 3
      if ($health.StatusCode -eq 200) {
        Write-Output "Healthy: $($health.Content)"
        return $true
      }
    } catch {}
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Restore-PreviousFiles {
  foreach ($dir in @('dist', 'library-ui')) {
    if (Test-Path (Join-Path $LivePath "$dir.prev")) { Copy-Tree (Join-Path $LivePath "$dir.prev") (Join-Path $LivePath $dir) }
  }
  foreach ($file in @('package.json', 'package-lock.json', '.env')) {
    $saved = Join-Path $LivePath "$file.prev"
    if (Test-Path $saved) { Copy-Item -Force $saved (Join-Path $LivePath $file) }
  }
}

if ($hot) {
  Write-Output "Hot reload: the running service keeps answering while the new version starts beside it"
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$ControlPort/reload" -Method Post -UseBasicParsing -TimeoutSec 120
    Write-Output "Reload: $($r.Content)"
  } catch {
    Write-Output "The new version did not become ready: $($_.Exception.Message)"
    # The old worker was never touched and is still serving. Put the old files back so a later restart starts the
    # same version that is running now.
    Restore-PreviousFiles
    throw "Deploy FAILED: the new version did not become ready. The previous version never stopped serving."
  }
  if (Wait-Healthy 30) { exit 0 }
  Write-Output "The new worker answered the reload but the service is not healthy. Restoring the previous version."
  Restore-PreviousFiles
  try { Invoke-WebRequest -Uri "http://127.0.0.1:$ControlPort/reload" -Method Post -UseBasicParsing -TimeoutSec 120 | Out-Null } catch {}
  if (Wait-Healthy 60) { throw "Deploy FAILED: the new version was not healthy. The previous version was restored and is serving." }
  throw "Deploy FAILED and the automatic rollback did not recover the service either. Check deploy.err.log in $LivePath."
}

Stop-CurrentService
Start-Service

# 30s, then 90s, both proved too tight for the old layout (started from a fresh `npm ci` under this account, likely
# Windows Defender scanning the just-written node_modules): confirmed live the process was healthy minutes later, the
# deploy had just given up too early. The compiled service in its live copy answers within seconds, so with a live
# copy a version that is not healthy after 60s is treated as broken and rolled back; otherwise the old 180s applies.
$patience = if ($LivePath) { 60 } else { 180 }
if (Wait-Healthy $patience) { exit 0 }

if ($LivePath -and (Test-Path (Join-Path $LivePath 'dist.prev'))) {
  Write-Output "The new version did not become healthy within ${patience}s. Rolling back to the previous version."
  Stop-CurrentService
  foreach ($dir in @('dist', 'library-ui')) {
    if (Test-Path (Join-Path $LivePath "$dir.prev")) { Copy-Tree (Join-Path $LivePath "$dir.prev") (Join-Path $LivePath $dir) }
  }
  foreach ($file in @('package.json', 'package-lock.json', '.env')) {
    $saved = Join-Path $LivePath "$file.prev"
    if (Test-Path $saved) { Copy-Item -Force $saved (Join-Path $LivePath $file) }
  }
  Start-Service
  if (Wait-Healthy 60) { throw "Deploy FAILED: the new version did not start. The previous version was restored and is serving." }
  throw "Deploy FAILED and the automatic rollback did not recover the service either. Check deploy.err.log in $LivePath."
}

throw "Service did not report healthy on port $Port within ${patience}s of restart."
