# Puts the machine-level scripts and scheduled tasks kept in this folder onto THIS machine (safe to re-run).
#   .\install.ps1                       copy the scripts to %USERPROFILE%\.cloudflared
#   .\install.ps1 -RegisterTasks        ...and (re)create every scheduled task from tasks\*.xml
#   .\install.ps1 -ScriptsDir <dir>     put the scripts somewhere else (used by the tests)
# Secrets are NEVER kept here. Two files must be made by hand and are listed in README.md.
param(
  [string]$ScriptsDir = (Join-Path $env:USERPROFILE '.cloudflared'),
  [switch]$RegisterTasks,
  [string]$TaskNamePrefix = ''
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $ScriptsDir | Out-Null
foreach ($f in 'watchdog-desk-local-services.ps1', 'boot-recovery-trigger-deploys.ps1', 'run-tunnel.cmd', 'start-desk-local-services.ps1') {
  Copy-Item (Join-Path $PSScriptRoot $f) (Join-Path $ScriptsDir $f) -Force
  Write-Output "copied $f"
}
if ($RegisterTasks) {
  $me = "$env:USERDOMAIN\$env:USERNAME"
  $failed = @()
  foreach ($file in Get-ChildItem (Join-Path $PSScriptRoot 'tasks') -Filter *.xml) {
    $xml = (Get-Content $file.FullName -Raw).Replace('@@CURRENT_USER@@', $me)
    $uri = ([xml]$xml).Task.RegistrationInfo.URI
    $name = $TaskNamePrefix + ($uri.TrimStart('\'))
    try {
      Register-ScheduledTask -TaskName $name -Xml $xml -Force -ErrorAction Stop | Out-Null
      Write-Output "registered task: $name"
    } catch {
      # Tasks that run at start-up or with elevated rights can only be created from an Administrator PowerShell.
      Write-Warning "could not register '$name' ($($_.Exception.Message.Trim())). Run this script from an elevated (Administrator) PowerShell to register it."
      $failed += $name
    }
  }
  if ($failed.Count -gt 0) { Write-Output ("NOT registered (need Administrator): " + ($failed -join ', ')) }
}
