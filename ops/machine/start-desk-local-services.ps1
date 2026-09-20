$ErrorActionPreference = 'Continue'

function Test-LocalPort($port) {
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $async = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne(1000, $false)
    if ($ok) { $client.EndConnect($async) }
    $client.Close()
    return $ok
  } catch {
    return $false
  }
}

$npm = 'npm.cmd'
$temp = [System.IO.Path]::GetTempPath()

# Live copies now run from the GitHub Actions runner's own checkout
# workspace (populated by actions/checkout in each repo's deploy.yml), not
# from $env:USERPROFILE\<repo> — those are the dev/editing copies. Launching
# from the old location here would silently resurrect the pre-deploy code on
# every reboot, undoing every deploy.
function RunnerWorkspace($repo) { "C:\actions-runners\$repo\_work\$repo\$repo" }

if (-not (Test-LocalPort 3000)) {
  Start-Process -FilePath $npm -ArgumentList @('run','dev') -WorkingDirectory (RunnerWorkspace 'compliance-os') -RedirectStandardOutput (Join-Path $temp 'compliance-os.out.log') -RedirectStandardError (Join-Path $temp 'compliance-os.err.log') -WindowStyle Hidden
}

if (-not (Test-LocalPort 3456)) {
  Start-Process -FilePath $npm -ArgumentList @('start') -WorkingDirectory (RunnerWorkspace 'registry-api') -RedirectStandardOutput (Join-Path $temp 'registry-api.out.log') -RedirectStandardError (Join-Path $temp 'registry-api.err.log') -WindowStyle Hidden
}

if (-not (Test-LocalPort 6379)) {
  # market-validation-api's rate limiting and fetch cache are Redis-backed by
  # default now (see market-validation-api/src/config.ts) — try to bring the
  # existing 'market-api-redis' container (restart policy: unless-stopped)
  # back up if Docker Desktop is running; both features still degrade
  # gracefully on their own if this silently no-ops (Docker Desktop down).
  try { docker start market-api-redis 2>$null | Out-Null } catch {}
}

if (-not (Test-LocalPort 3457)) {
  Start-Process -FilePath $npm -ArgumentList @('start') -WorkingDirectory (RunnerWorkspace 'market-validation-api') -RedirectStandardOutput (Join-Path $temp 'market-validation-api.out.log') -RedirectStandardError (Join-Path $temp 'market-validation-api.err.log') -WindowStyle Hidden
}

if (-not (Test-LocalPort 3458)) {
  Start-Process -FilePath $npm -ArgumentList @('start') -WorkingDirectory (RunnerWorkspace 'desk-api') -RedirectStandardOutput (Join-Path $temp 'desk-api.out.log') -RedirectStandardError (Join-Path $temp 'desk-api.err.log') -WindowStyle Hidden
}

Start-Sleep -Seconds 10

$tokenPath = Join-Path $env:USERPROFILE '.cloudflared\desk-local-services.token'
$token = (Get-Content $tokenPath -Raw).Trim()
$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$running = Get-CimInstance Win32_Process -Filter "name = 'cloudflared.exe'" | Where-Object { $_.CommandLine -like '*desk-local-services*' -or $_.CommandLine -like '*tunnel*run*token*' }
if (-not $running) {
  Start-Process -FilePath $cloudflared -ArgumentList @('tunnel','--no-autoupdate','run','--token',$token) -RedirectStandardOutput (Join-Path $temp 'desk-local-services-cloudflared.out.log') -RedirectStandardError (Join-Path $temp 'desk-local-services-cloudflared.err.log') -WindowStyle Hidden
}
