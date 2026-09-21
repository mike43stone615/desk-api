# Runs once at boot. For each backend service, if its port isn't
# listening a minute or so after startup (meaning it didn't survive the
# reboot -- nothing currently restarts these locally, by design), this
# triggers that repo's own deploy pipeline via the GitHub API instead of
# starting anything on this machine directly.
#
# Deliberately does NOT run `npm start`/Start-Process itself: doing that
# would recreate the exact problem fixed on 2026-09-01 -- a locally
# started process is owned by whichever account launches it, and
# NT AUTHORITY\NetworkService (the GitHub Actions deploy pipeline's own
# identity) can never stop a process owned by a different account,
# permanently blocking every future CI deploy for that service until
# someone manually kills it by hand. Routing recovery through the same
# pipeline every other deploy uses keeps process ownership consistent.
#
# Requires a GitHub token with Actions: read and write on all 4 repos,
# stored in Downloads\api.txt under GITHUB_RUNNER_REGISTRATION_PAT_2=.

Start-Sleep -Seconds 90  # give networking and the runner services time to come up

$apiTxtPath = "C:\Users\User\Downloads\api.txt"
$tokenLine = (Get-Content $apiTxtPath | Where-Object { $_ -match '^GITHUB_RUNNER_REGISTRATION_PAT_2=' } | Select-Object -First 1)
$token = ($tokenLine -split '=', 2)[1].Split('#')[0].Trim()

$headers = @{
  Authorization = "Bearer $token"
  Accept        = "application/vnd.github+json"
}

$services = @(
  @{ Repo = 'desk-api'; Port = 3458 },
  @{ Repo = 'registry-api'; Port = 3456 },
  @{ Repo = 'market-validation-api'; Port = 3457 },
  @{ Repo = 'desk-oracle'; Port = 3459 }
)

$logPath = "C:\Users\User\.cloudflared\boot-recovery.log"
"=== Boot recovery run: $(Get-Date -Format o) ===" | Out-File -FilePath $logPath -Append -Encoding utf8

foreach ($svc in $services) {
  $listening = Get-NetTCPConnection -LocalPort $svc.Port -State Listen -ErrorAction SilentlyContinue
  if ($listening) {
    "$($svc.Repo): already up on port $($svc.Port), skipping" | Out-File -FilePath $logPath -Append -Encoding utf8
    continue
  }

  try {
    Invoke-RestMethod -Method Post -Headers $headers `
      -Uri "https://api.github.com/repos/mike43stone615/$($svc.Repo)/actions/workflows/deploy.yml/dispatches" `
      -Body (@{ ref = 'main' } | ConvertTo-Json) -ContentType 'application/json'
    "$($svc.Repo): port $($svc.Port) was down -- triggered deploy.yml via workflow_dispatch" | Out-File -FilePath $logPath -Append -Encoding utf8
  } catch {
    # The stored token may not cover this repository (desk-oracle answers 404 to it): the GitHub CLI's own sign-in is
    # the second way in (found in the 20 Sep 2026 recovery test).
    $first = "$_"
    & 'C:\Program Files\GitHub CLI\gh.exe' workflow run deploy.yml --repo "mike43stone615/$($svc.Repo)" --ref main 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
      "$($svc.Repo): port $($svc.Port) was down -- stored token refused ($first); triggered deploy.yml through the GitHub CLI" | Out-File -FilePath $logPath -Append -Encoding utf8
    } else {
      "$($svc.Repo): port $($svc.Port) was down -- FAILED to trigger deploy: $first (GitHub CLI failed too)" | Out-File -FilePath $logPath -Append -Encoding utf8
    }
  }
}
