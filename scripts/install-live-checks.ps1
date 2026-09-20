# Registers (or updates) the "Desk Live Checks" scheduled task: runs scripts/run-live-checks.ps1 once a day (05:40) as the
# current user. Safe to re-run.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'run-live-checks.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $script)
$trigger = New-ScheduledTaskTrigger -Daily -At 5:40am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Desk Live Checks' -Action $action -Trigger $trigger -Settings $settings -Description 'Daily end-to-end and contract check of the live API (see scripts/live-checks/).' -Force | Out-Null
Write-Host 'Desk Live Checks registered: daily at 05:40.'
