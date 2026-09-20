<#
  Uptime watch: checks that everything the platform needs is answering, and raises an alert when something has been
  down for a few checks in a row (and again when it recovers). Run every 2 minutes by the "Desk Uptime Watch"
  scheduled task (scripts/install-uptime-watch.ps1). One failed check is ignored (a blip); alerts need
  "failuresBeforeAlert" in a row (default 2, so about 4 minutes).

  Where an alert goes:
    - always: a line in logs/uptime-watch.log, and a Windows notification on this machine;
    - if scripts/alerts.json exists (git-ignored; see alerts.example.json): a webhook (Slack / Discord / anything that
      takes JSON) and/or an email through Resend.
  Nothing secret is ever written to the log or sent in an alert.

  Parameters exist so the script can be tested against fake targets:
    -TargetsFile  what to check (default: uptime-targets.json beside this script)
    -AlertsFile   where alerts go (default: alerts.json beside this script)
    -StateFile    remembered results between runs (default: logs/uptime-state.json)
    -LogFile      the log (default: logs/uptime-watch.log)
    -NoToast      do not show the Windows notification
#>
param(
  [string]$TargetsFile = (Join-Path $PSScriptRoot 'uptime-targets.json'),
  [string]$AlertsFile = (Join-Path $PSScriptRoot 'alerts.json'),
  [string]$StateFile = (Join-Path (Split-Path $PSScriptRoot -Parent) 'logs\uptime-state.json'),
  [string]$LogFile = (Join-Path (Split-Path $PSScriptRoot -Parent) 'logs\uptime-watch.log'),
  [switch]$NoToast
)
$ErrorActionPreference = 'Stop'
foreach ($f in @($StateFile, $LogFile)) { $d = Split-Path $f -Parent; if ($d -and -not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } }

function Write-Log([string]$message) {
  Add-Content -Path $LogFile -Value ("{0} {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $message) -Encoding utf8
  # Keep the log small: once it passes ~1 MB, keep only the newest 3000 lines.
  if ((Get-Item $LogFile).Length -gt 1MB) { Get-Content $LogFile -Tail 3000 | Set-Content $LogFile -Encoding utf8 }
}

function Show-Toast([string]$title, [string]$message) {
  if ($NoToast) { return }
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $text = $xml.GetElementsByTagName('text')
    $text.Item(0).AppendChild($xml.CreateTextNode($title)) | Out-Null
    $text.Item(1).AppendChild($xml.CreateTextNode($message)) | Out-Null
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  } catch { Write-Log "toast failed: $($_.Exception.Message)" }
}

function Get-DeployedSetting([string]$name) {
  $envFile = 'C:\actions-runners\desk-api\_work\desk-api\desk-api\.env'
  if (-not (Test-Path $envFile)) { return $null }
  $line = Select-String -Path $envFile -Pattern ("^{0}\s*=" -f [regex]::Escape($name)) | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line.Line -replace ("^{0}\s*=\s*" -f [regex]::Escape($name)), '').Trim().Trim('"').Trim("'")
}

function Send-Alert([string]$title, [string]$message) {
  Write-Log "ALERT: $title - $message"
  Show-Toast $title $message
  if (-not (Test-Path $AlertsFile)) { return }
  try { $cfg = Get-Content $AlertsFile -Raw | ConvertFrom-Json } catch { Write-Log "alerts file unreadable: $($_.Exception.Message)"; return }
  if ($cfg.webhookUrl) {
    try {
      $body = @{ text = "$title`n$message"; content = "$title`n$message"; title = $title; message = $message } | ConvertTo-Json -Compress
      Invoke-RestMethod -Uri $cfg.webhookUrl -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 15 | Out-Null
    } catch { Write-Log "webhook failed: $($_.Exception.Message)" }
  }
  if ($cfg.emailTo) {
    try {
      $key = if ($cfg.resendApiKey) { $cfg.resendApiKey } else { Get-DeployedSetting 'RESEND_API_KEY' }
      $from = if ($cfg.emailFrom) { $cfg.emailFrom } else { Get-DeployedSetting 'EMAIL_FROM' }
      if ($key -and $from) {
        $mail = @{ from = $from; to = @($cfg.emailTo); subject = "[Desk] $title"; text = $message } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri 'https://api.resend.com/emails' -Method Post -ContentType 'application/json' -Headers @{ Authorization = "Bearer $key" } -Body $mail -TimeoutSec 15 | Out-Null
      } else { Write-Log 'email not sent: no Resend key / sender available' }
    } catch { Write-Log "email failed: $($_.Exception.Message)" }
  }
}

function Test-Json($actual, $expected) {
  foreach ($p in $expected.PSObject.Properties) {
    if ($null -eq $actual -or $actual.PSObject.Properties.Name -notcontains $p.Name) { return "missing '$($p.Name)'" }
    if ($actual.($p.Name) -ne $p.Value) { return "'$($p.Name)' is $($actual.($p.Name))" }
  }
  return $null
}

# Each check returns $null when fine, or a short reason.
function Invoke-UrlCheck($check) {
  try {
    $res = Invoke-WebRequest -Uri $check.url -UseBasicParsing -TimeoutSec ([int]$check.timeoutSec) -MaximumRedirection 0
    $status = [int]$res.StatusCode
  } catch {
    $r = $_.Exception.Response
    if ($null -ne $r) { $status = [int]$r.StatusCode; $res = $null }
    else { return "no answer ($($_.Exception.Message.Split("`n")[0]))" }
  }
  if ($check.expectStatus -and $status -ne [int]$check.expectStatus) { return "answered $status" }
  if ($check.expectJson) {
    try { $json = $res.Content | ConvertFrom-Json } catch { return 'answer was not JSON' }
    $why = Test-Json $json $check.expectJson
    if ($why) { return $why }
  }
  return $null
}

function Invoke-ProcessCheck($proc) {
  $found = Get-CimInstance Win32_Process -Filter ("name = '{0}'" -f $proc.processName) -ErrorAction SilentlyContinue |
    Where-Object { -not $proc.commandLineLike -or $_.CommandLine -like ('*' + $proc.commandLineLike + '*') }
  if (-not $found) { return "$($proc.processName) is not running" }
  return $null
}

function Invoke-DiskCheck($disk) {
  $d = Get-PSDrive -Name $disk.drive -ErrorAction SilentlyContinue
  if (-not $d) { return "drive $($disk.drive) not found" }
  $total = $d.Used + $d.Free
  $pct = [math]::Round(100 * $d.Free / $total, 1)
  if ($pct -lt [double]$disk.minFreePercent) { return "only $pct% free" }
  return $null
}

function Invoke-BackupCheck($b) {
  if (-not (Test-Path $b.dir)) { return "backup folder missing" }
  $latest = Get-ChildItem $b.dir -Filter *.gz -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { return 'no backups found' }
  $age = ((Get-Date) - $latest.LastWriteTime).TotalHours
  if ($age -gt [double]$b.maxAgeHours) { return ("newest backup is {0:N0} hours old" -f $age) }
  return $null
}

$targets = Get-Content $TargetsFile -Raw | ConvertFrom-Json
$need = if ($targets.failuresBeforeAlert) { [int]$targets.failuresBeforeAlert } else { 2 }
$state = @{}
if (Test-Path $StateFile) {
  try { (Get-Content $StateFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = @{ failures = [int]$_.Value.failures; alerted = [bool]$_.Value.alerted } } } catch { $state = @{} }
}

$all = @()
foreach ($c in $targets.checks) { $all += [pscustomobject]@{ name = $c.name; what = $c.what; run = { Invoke-UrlCheck $c }.GetNewClosure() } }
foreach ($pr in $targets.processes) { $all += [pscustomobject]@{ name = $pr.name; what = $pr.what; run = { Invoke-ProcessCheck $pr }.GetNewClosure() } }
if ($targets.disk) { $all += [pscustomobject]@{ name = 'disk-space'; what = $targets.disk.what; run = { Invoke-DiskCheck $targets.disk }.GetNewClosure() } }
if ($targets.backups) { $all += [pscustomobject]@{ name = 'backup-fresh'; what = $targets.backups.what; run = { Invoke-BackupCheck $targets.backups }.GetNewClosure() } }

$summary = @()
foreach ($check in $all) {
  $reason = & $check.run
  if (-not $state.ContainsKey($check.name)) { $state[$check.name] = @{ failures = 0; alerted = $false } }
  $st = $state[$check.name]
  if ($reason) {
    $st.failures++
    $summary += "$($check.name)=DOWN($reason)"
    if ($st.failures -ge $need -and -not $st.alerted) {
      $st.alerted = $true
      Send-Alert "DOWN: $($check.name)" "$($check.what): $reason (failed $($st.failures) checks in a row)"
    }
  } else {
    if ($st.alerted) { Send-Alert "RECOVERED: $($check.name)" "$($check.what) is answering again." }
    $st.failures = 0
    $st.alerted = $false
    $summary += "$($check.name)=ok"
  }
}
($state | ConvertTo-Json -Depth 4) | Set-Content -Path $StateFile -Encoding utf8
Write-Log ("checked: " + ($summary -join ' '))
