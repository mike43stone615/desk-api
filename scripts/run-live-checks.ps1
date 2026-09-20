# Runs the live checks (scripts/live-checks/smoke.mts) and records the result in logs/live-checks.log. On any failure it
# shows a Windows notification and, if scripts/alerts.json exists, calls its webhook (same file the uptime watch uses).
# Run daily by the "Desk Live Checks" task (scripts/install-live-checks.ps1). Safe to run by hand.
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$env:Path = "C:\Program Files\nodejs;$env:Path"
$logDir = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'live-checks.log'
$out = & npx.cmd tsx scripts/live-checks/smoke.mts 2>&1 | Out-String
$summary = ($out -split "`r?`n" | Where-Object { $_ -match '^live checks:' } | Select-Object -Last 1)
$failures = @($out -split "`r?`n" | Where-Object { $_ -match '^\s+FAIL ' })
if (-not $summary) { $summary = 'live checks: did not finish'; $failures = @($out.Trim().Split("`n") | Select-Object -Last 3) }
$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
Add-Content -Path $log -Value "$stamp $summary" -Encoding utf8
foreach ($f in $failures) { Add-Content -Path $log -Value "$stamp   $($f.Trim())" -Encoding utf8 }
if ($failures.Count -gt 0 -or $summary -notmatch ' 0 failed' -or $summary -match ': 0 passed') {
  $message = "$summary`n" + (($failures | Select-Object -First 3 | ForEach-Object { $_.Trim() }) -join "`n")
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $t = $xml.GetElementsByTagName('text')
    $t.Item(0).AppendChild($xml.CreateTextNode('Desk live checks FAILED')) | Out-Null
    $t.Item(1).AppendChild($xml.CreateTextNode($message)) | Out-Null
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($xml))
  } catch {}
  $alerts = Join-Path $PSScriptRoot 'alerts.json'
  if (Test-Path $alerts) {
    try {
      $cfg = Get-Content $alerts -Raw | ConvertFrom-Json
      if ($cfg.webhookUrl) { Invoke-RestMethod -Uri $cfg.webhookUrl -Method Post -ContentType 'application/json' -Body (@{ text = "Desk live checks FAILED`n$message"; content = "Desk live checks FAILED`n$message" } | ConvertTo-Json -Compress) -TimeoutSec 15 | Out-Null }
    } catch {}
  }
  exit 1
}
