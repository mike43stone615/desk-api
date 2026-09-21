# Puts the PREVIOUS version of desk-api back (the one that was running before the last deploy) and restarts it.
# Use when a release turns out to be bad in a way the deploy's own health check could not see. Swaps current and
# previous, so running it twice returns to where you started. Database migrations are NOT undone (they are additive by
# rule, see docs/ROLLBACK.md).
param(
  [string]$LivePath = 'C:\actions-runners\desk-api\_work\live',
  [int]$Port = 3458,
  [int]$ControlPort = 3468
)
$ErrorActionPreference = 'Stop'
foreach ($dir in @('dist', 'library-ui')) {
  if (-not (Test-Path (Join-Path $LivePath "$dir.prev"))) { throw "No previous version to roll back to ($dir.prev is missing)." }
}
function Swap([string]$name) {
  $cur = Join-Path $LivePath $name; $prev = Join-Path $LivePath "$name.prev"; $tmp = Join-Path $LivePath "$name.swap"
  robocopy $cur $tmp /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  robocopy $prev $cur /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  robocopy $tmp $prev /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  Remove-Item -Recurse -Force $tmp
}
# With a supervisor running (src/supervisor.ts) the previous version is swapped in with no gap: the files are put back
# and the supervisor starts a worker from them beside the current one. Without one, the service is stopped and started.
$supervisor = $null
try { $supervisor = (Invoke-WebRequest "http://127.0.0.1:$ControlPort/status" -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json } catch {}
if (-not $supervisor) {
  $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)
  if ($owner) { Write-Output "Stopping PID $owner"; Stop-Process -Id $owner -Force; Start-Sleep -Seconds 1 }
}
Swap 'dist'; Swap 'library-ui'
# The dependencies go back too: node_modules is a link to the set the release used (deploy-service.ps1), so swap the link with
# the one before it. (Only when a previous set is recorded; the files themselves are never copied or deleted here.)
$nm = Join-Path $LivePath 'node_modules'; $prevFile = Join-Path $LivePath 'node_modules.prevtarget'
if ((Test-Path $prevFile) -and (Test-Path $nm) -and (((Get-Item $nm -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
  $prevTarget = (Get-Content $prevFile -Raw).Trim(); $curTarget = ((Get-Item $nm -Force).Target | Select-Object -First 1)
  if ($prevTarget -and (Test-Path $prevTarget) -and $prevTarget -ne $curTarget) {
    cmd /c rmdir "`"$nm`"" | Out-Null
    New-Item -ItemType Junction -Path $nm -Target $prevTarget | Out-Null
    Set-Content -Path $prevFile -Value $curTarget
  }
}
# The start command and settings go back with the code (see deploy-service.ps1).
foreach ($file in @('package.json', 'package-lock.json', '.env')) {
  $cur = Join-Path $LivePath $file; $prev = "$cur.prev"
  if (Test-Path $prev) {
    $tmp = "$cur.swap"; Copy-Item -Force $cur $tmp; Copy-Item -Force $prev $cur; Move-Item -Force $tmp $prev
  }
}
if ($supervisor) {
  try { $r = Invoke-WebRequest "http://127.0.0.1:$ControlPort/reload" -Method Post -UseBasicParsing -TimeoutSec 120; Write-Output "Reload: $($r.Content)" }
  catch { throw "The previous version did not become ready ($($_.Exception.Message)). The version that was serving is still serving." }
  for ($i = 0; $i -lt 15; $i++) {
    try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { Write-Output 'Rolled back with no gap, and healthy.'; exit 0 } } catch {}
    Start-Sleep -Seconds 2
  }
  throw 'Rolled back, but the service is not healthy.'
}
$out = Join-Path $LivePath 'deploy.out.log'; $err = Join-Path $LivePath 'deploy.err.log'
$cmd = "cmd.exe /c `"npm run start:prod > `"$out`" 2> `"$err`"`""
$c = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $LivePath }
if ($c.ReturnValue -ne 0) { throw "Could not start the service ($($c.ReturnValue))" }
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { Write-Output 'Rolled back and healthy.'; exit 0 } } catch {}
}
throw 'Rolled back, but the service did not become healthy. Check deploy.err.log.'
