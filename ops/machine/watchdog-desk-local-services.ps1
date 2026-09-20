# Tunnel-only watchdog. Restarts ONLY the Cloudflare Tunnel connecting
# *.deskbusiness.co to this host's local services if it dies -- it does
# NOT touch desk-api/registry-api/compliance-os/market-validation-api.
#
# This used to also restart those 4 backend services (via
# start-desk-local-services.ps1) if their port was down. That was removed
# 2026-09-01: it started them as the interactive Windows user, which
# permanently blocks the GitHub Actions deploy pipeline from ever
# replacing them afterward (NT AUTHORITY\NetworkService, the pipeline's
# identity, can't stop a process owned by a different account) -- that
# was the real cause of a full day of intermittent deploy failures.
#
# The tunnel itself has no such conflict: it isn't managed by the deploy
# pipeline, so restarting it as the interactive user is fine. Splitting
# this out keeps that legitimate recovery behavior without reintroducing
# the part that broke deploys.
while ($true) {
  try {
    $tokenPath = "C:\Users\User\.cloudflared\desk-local-services.token"
    $token = (Get-Content $tokenPath -Raw).Trim()
    $cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
    $running = Get-CimInstance Win32_Process -Filter "name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*desk-local-services*' -or $_.CommandLine -like '*tunnel*run*token*' }
    if (-not $running) {
      $temp = [System.IO.Path]::GetTempPath()
      Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--no-autoupdate', 'run', '--token', $token) `
        -RedirectStandardOutput (Join-Path $temp 'desk-local-services-cloudflared.out.log') `
        -RedirectStandardError (Join-Path $temp 'desk-local-services-cloudflared.err.log') `
        -WindowStyle Hidden
    }
  } catch {}
  Start-Sleep -Seconds 300
}
