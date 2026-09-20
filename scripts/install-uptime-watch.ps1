# Registers (or updates) the "Desk Uptime Watch" scheduled task: runs scripts/uptime-watch.ps1 every 2 minutes as the
# current user (so its Windows notification is visible), whether or not anyone is at the keyboard. Safe to re-run.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'uptime-watch.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $script)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Desk Uptime Watch' -Action $action -Trigger $trigger -Settings $settings -Description 'Checks that the Desk platform is up and alerts when it is not (see scripts/uptime-watch.ps1).' -Force | Out-Null
Write-Host 'Desk Uptime Watch registered: every 2 minutes.'
