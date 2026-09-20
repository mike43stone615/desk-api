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
  [string]$BuildCommand = 'build'                         # npm script that compiles (used with -Build)
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

function Stop-CurrentService {
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

if ($LivePath) {
  New-Item -ItemType Directory -Force -Path $LivePath | Out-Null
  # Everything the running service needs, and nothing else (no sources, tests, git history or dev tooling output).
  # node_modules is only replaced when the lockfile changed: its native files are locked while the service runs, and
  # copying it is the slow part, so an unchanged lockfile means a much shorter gap.
  $lockNow = (Get-FileHash (Join-Path $RepoPath 'package-lock.json')).Hash
  $liveLock = Join-Path $LivePath 'package-lock.json'
  $lockThen = if (Test-Path $liveLock) { (Get-FileHash $liveLock).Hash } else { '' }
  $depsChanged = ($lockNow -ne $lockThen) -or -not (Test-Path (Join-Path $LivePath 'node_modules'))
  if ($depsChanged) {
    Write-Output "Dependencies changed: stopping the service before replacing node_modules"
    Stop-CurrentService
    Copy-Tree (Join-Path $RepoPath 'node_modules') (Join-Path $LivePath 'node_modules')
  }
  foreach ($dir in @('dist', 'library-ui', 'migrations')) {
    if (Test-Path (Join-Path $RepoPath $dir)) { Copy-Tree (Join-Path $RepoPath $dir) (Join-Path $LivePath $dir) }
  }
  foreach ($file in @('package.json', 'package-lock.json', '.env')) {
    Copy-Item -Force (Join-Path $RepoPath $file) (Join-Path $LivePath $file)
  }
  $RepoPath = $LivePath
  Set-Location $RepoPath
  Write-Output "Prepared live copy at $LivePath"
}

Stop-CurrentService

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
$cmdLine = "cmd.exe /c `"npm run $StartCommand > `"$outLog`" 2> `"$errLog`"`""
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine      = $cmdLine
  CurrentDirectory = $RepoPath
}
if ($created.ReturnValue -ne 0) { throw "Failed to launch service via WMI (Win32_Process.Create returned $($created.ReturnValue))" }
Write-Output "Launched via WMI, new PID $($created.ProcessId)"

# 30s, then 90s, both proved too tight: confirmed live multiple times that
# a service started right after a fresh `npm ci` under this account can
# take well over 90s to bind (likely Windows Defender scanning the
# just-written node_modules under this service account specifically --
# the same code starts in ~12-25s interactively from a warm directory).
# Each time, the process was actually healthy and serving fine when
# checked minutes later; the deploy just gave up on it too early. 180s
# gives real headroom over the worst case observed so far.
$deadline = (Get-Date).AddSeconds(180)
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

throw "Service did not report healthy on port $Port within 180s of restart."
