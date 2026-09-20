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
  $envFile = 'C:\actions-runners\desk-api\_work\live\.env'
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

# Self-recovery: if a service stays down for "afterFailures" checks in a row, ask GitHub to run that service's own deploy
# workflow (the same thing the boot-recovery task does after a reboot). A deploy starts it under the right account.
# At most once per "cooldownMinutes", so a service that will not start is not redeployed in a loop.
function Start-Recovery($recovery, [string]$checkName, $state) {
  if (-not $state.ContainsKey('_recovery')) { $state['_recovery'] = @{ lastAt = $null } }
  $rs = $state['_recovery']
  if ($rs.lastAt -and (((Get-Date) - [datetime]$rs.lastAt).TotalMinutes -lt [double]$recovery.cooldownMinutes)) { return }
  try {
    $tokenFile = if ($recovery.tokenFile) { $recovery.tokenFile } else { 'C:\Users\User\Downloads\api.txt' }
    $line = Get-Content $tokenFile | Where-Object { $_ -match '^GITHUB_RUNNER_REGISTRATION_PAT_2=' } | Select-Object -First 1
    $token = ($line -split '=', 2)[1].Split('#')[0].Trim()
    $base = if ($recovery.apiBase) { $recovery.apiBase } else { 'https://api.github.com' }
    Invoke-RestMethod -Method Post -Uri "$base/repos/$($recovery.repo)/actions/workflows/$($recovery.workflow)/dispatches" `
      -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -ContentType 'application/json' `
      -Body (@{ ref = 'main' } | ConvertTo-Json) -TimeoutSec 20 | Out-Null
    $rs.lastAt = (Get-Date).ToString('o')
    Send-Alert "RECOVERY STARTED: $checkName" "$checkName has been down for $($recovery.afterFailures) checks in a row, so its deploy workflow was started to bring it back."
  } catch { Write-Log "recovery for $checkName failed to start: $($_.Exception.Message)" }
}

function Test-Json($actual, $expected) {
  foreach ($p in $expected.PSObject.Properties) {
    if ($null -eq $actual -or $actual.PSObject.Properties.Name -notcontains $p.Name) { return "missing '$($p.Name)'" }
    if ($actual.($p.Name) -ne $p.Value) { return "'$($p.Name)' is $($actual.($p.Name))" }
  }
  return $null
}

# Header values written as "env:NAME" are read from the deployed service's settings (never stored in this file).
function Resolve-Headers($headers) {
  $out = @{}
  if ($null -eq $headers) { return $out }
  foreach ($p in $headers.PSObject.Properties) {
    $v = [string]$p.Value
    if ($v.StartsWith('env:')) { $v = Get-DeployedSetting $v.Substring(4); if (-not $v) { return $null } }
    # "file:<path>": the value is the first line of a file on this machine (used for the canary's key, which lives outside git).
    elseif ($v.StartsWith('file:')) { $f = $v.Substring(5); if (-not (Test-Path $f)) { return $null }; $v = (Get-Content $f -TotalCount 1).Trim(); if (-not $v) { return $null } }
    $out[$p.Name] = $v
  }
  return $out
}

function Get-Page($check) {
  $headers = Resolve-Headers $check.headers
  if ($null -eq $headers) { return @{ error = 'a setting this check needs is missing from the deployed settings' } }
  $req = @{ Uri = $check.url; UseBasicParsing = $true; TimeoutSec = [int]$check.timeoutSec; MaximumRedirection = 0; Headers = $headers }
  if ($check.method) { $req.Method = $check.method }
  if ($check.body) { $req.Body = ($check.body | ConvertTo-Json -Compress); $req.ContentType = 'application/json' }
  try {
    $res = Invoke-WebRequest @req
    return @{ status = [int]$res.StatusCode; content = $res.Content }
  } catch {
    $r = $_.Exception.Response
    if ($null -ne $r) { return @{ status = [int]$r.StatusCode; content = $null } }
    return @{ error = "no answer ($($_.Exception.Message.Split("`n")[0]))" }
  }
}

# Each check returns $null when fine, or a short reason.
function Invoke-UrlCheck($check) {
  $page = Get-Page $check
  if ($page.error) { return $page.error }
  if ($check.expectStatus -and $page.status -ne [int]$check.expectStatus) { return "answered $($page.status)" }
  if ($check.expectJson -or $check.expectKeys) {
    try { $json = $page.content | ConvertFrom-Json } catch { return 'answer was not JSON' }
    if ($check.expectJson) { $why = Test-Json $json $check.expectJson; if ($why) { return $why } }
    if ($check.expectKeys) { foreach ($k in $check.expectKeys) { if ($null -eq $json -or $json.PSObject.Properties.Name -notcontains $k) { return "answer has no '$k'" } } }
  }
  return $null
}

# Data freshness: every listed item's timestamp field must be newer than maxAgeHours.
function Invoke-FreshnessCheck($check) {
  $page = Get-Page $check
  if ($page.error) { return $page.error }
  if ($page.status -ne 200) { return "answered $($page.status)" }
  try { $json = $page.content | ConvertFrom-Json } catch { return 'answer was not JSON' }
  $items = $json
  foreach ($part in $check.path.Split('.')) { $items = $items.$part }
  $stale = @()
  foreach ($name in $check.only) {
    $stamp = $items.$name.($check.field)
    if (-not $stamp) { $stale += "$name (never)"; continue }
    $age = ((Get-Date).ToUniversalTime() - ([datetime]$stamp).ToUniversalTime()).TotalHours
    if ($age -gt [double]$check.maxAgeHours) { $stale += ("{0} ({1:N0} days old)" -f $name, ($age / 24)) }
  }
  # A sync that finishes but loaded only part of the file has a fresh timestamp and a shrunken count: `minCounts` catches that.
  if ($check.minCounts) {
    foreach ($prop in $check.minCounts.PSObject.Properties) {
      $count = $items.($prop.Name).recordCount
      if ($null -ne $count -and [double]$count -lt [double]$prop.Value) { $stale += ("{0} has only {1:N0} records (expected at least {2:N0})" -f $prop.Name, $count, $prop.Value) }
    }
  }
  if ($stale.Count -gt 0) { return ('problem with the imported data (stale for over {0:N0} days, or too few records): {1}' -f ([double]$check.maxAgeHours / 24), ($stale -join ', ')) }
  return $null
}

# A counter that must not rise: fails when the summed value of the matching /metrics lines grew since the last run.
function Invoke-CounterCheck($check, $st) {
  $page = Get-Page $check
  if ($page.error) { return $page.error }
  if ($page.status -ne 200) { return "answered $($page.status)" }
  $total = 0.0
  foreach ($line in ($page.content -split "`n")) {
    if (-not $line.StartsWith($check.metric + '{')) { continue }
    $ok = $true
    foreach ($m in $check.labels.PSObject.Properties) { if ($line -notmatch ('{0}="({1})"' -f $m.Name, $m.Value)) { $ok = $false } }
    if ($ok) { $total += [double](($line -split ' ')[-1]) }
  }
  $prev = $st.value
  $st.value = $total
  if ($null -eq $prev) { return $null }                  # first run: just remember the level
  if ($total -lt $prev) { return $null }                 # the service restarted: counters began again from zero
  $rise = $total - $prev
  if ($rise -gt [double]$check.maxIncrease) { return ('{0:N0} new {1}' -f $rise, $check.unit) }
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

# Memory: the machine runs every service plus the databases; when little is free, Windows starts swapping and everything slows.
function Invoke-MemoryCheck($m) {
  $os = Get-CimInstance Win32_OperatingSystem
  $freePct = [math]::Round(100 * $os.FreePhysicalMemory / $os.TotalVisibleMemorySize, 1)
  if ($freePct -lt [double]$m.minFreePercent) { return ("only {0}% of memory free ({1:N1} GB)" -f $freePct, ($os.FreePhysicalMemory / 1MB)) }
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
  try { (Get-Content $StateFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = @{ failures = [int]$_.Value.failures; alerted = [bool]$_.Value.alerted; lastRun = $_.Value.lastRun; value = $_.Value.value; lastAt = $_.Value.lastAt } } } catch { $state = @{} }
}

$all = @()
foreach ($c in $targets.checks) {
  $kind = if ($c.kind) { $c.kind } else { 'url' }
  $runner = switch ($kind) {
    'freshness' { { param($st) Invoke-FreshnessCheck $c }.GetNewClosure() }
    'counter'   { { param($st) Invoke-CounterCheck $c $st }.GetNewClosure() }
    default     { { param($st) Invoke-UrlCheck $c }.GetNewClosure() }
  }
  $all += [pscustomobject]@{ name = $c.name; what = $c.what; run = $runner; every = $c.everyMinutes; need = $c.failuresBeforeAlert }
}
foreach ($pr in $targets.processes) { $all += [pscustomobject]@{ name = $pr.name; what = $pr.what; run = { param($st) Invoke-ProcessCheck $pr }.GetNewClosure() } }
if ($targets.disk) { $all += [pscustomobject]@{ name = 'disk-space'; what = $targets.disk.what; run = { param($st) Invoke-DiskCheck $targets.disk }.GetNewClosure() } }
if ($targets.memory) { $all += [pscustomobject]@{ name = 'memory'; what = $targets.memory.what; run = { param($st) Invoke-MemoryCheck $targets.memory }.GetNewClosure(); need = $targets.memory.failuresBeforeAlert } }
if ($targets.backups) { $all += [pscustomobject]@{ name = 'backup-fresh'; what = $targets.backups.what; run = { param($st) Invoke-BackupCheck $targets.backups }.GetNewClosure() } }

$summary = @()
foreach ($check in $all) {
  if (-not $state.ContainsKey($check.name)) { $state[$check.name] = @{ failures = 0; alerted = $false; lastRun = $null; value = $null } }
  $st = $state[$check.name]
  # A check that talks to an outside service (or costs something) can ask to run only every N minutes; while it is
  # failing it is retried every time, so a recovery is noticed promptly.
  if ($check.every -and $st.lastRun -and $st.failures -eq 0 -and (((Get-Date) - [datetime]$st.lastRun).TotalMinutes -lt [double]$check.every)) {
    $summary += "$($check.name)=skipped"
    continue
  }
  $reason = & $check.run $st
  $st.lastRun = (Get-Date).ToString('o')
  $threshold = if ($check.need) { [int]$check.need } else { $need }
  if ($reason) {
    $st.failures++
    $summary += "$($check.name)=DOWN($reason)"
    if ($st.failures -ge $threshold -and -not $st.alerted) {
      $st.alerted = $true
      Send-Alert "DOWN: $($check.name)" "$($check.what): $reason (failed $($st.failures) checks in a row)"
    }
    if ($targets.recovery -and (@($targets.recovery.checks) -contains $check.name) -and $st.failures -ge [int]$targets.recovery.afterFailures) {
      Start-Recovery $targets.recovery $check.name $state
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
