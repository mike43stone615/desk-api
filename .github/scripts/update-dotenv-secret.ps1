# Safely updates this repo's DOTENV_CONTENT deploy secret from the local
# .env file. Exists because of a real incident: piping a raw .env straight
# into `gh secret set` corrupted its leading UTF-8 BOM into a literal "?"
# character, turning DATABASE_URL into ?DATABASE_URL and crashing this
# service (and the other three, hit the same way at the same time) on
# their next scheduled restart -- a real, brief full-platform outage.
#
# The .env files themselves no longer carry a BOM (removed at the source
# after that incident), but this script strips one defensively anyway, in
# case a future editor or tool reintroduces one -- so this specific failure
# mode can't happen again regardless of how the file gets edited later.
#
# Usage: run from this repo's root: .github\scripts\update-dotenv-secret.ps1
$ErrorActionPreference = "Stop"
$env:Path = "C:\Program Files\GitHub CLI;$env:Path"
$envPath = Join-Path $PSScriptRoot "..\..\.env"
$envPath = (Resolve-Path $envPath).Path

$bytes = [System.IO.File]::ReadAllBytes($envPath)
$bom = [byte[]](0xEF, 0xBB, 0xBF)
if ($bytes.Length -ge 3 -and $bytes[0] -eq $bom[0] -and $bytes[1] -eq $bom[1] -and $bytes[2] -eq $bom[2]) {
  Write-Host "Stripping a leading UTF-8 BOM from $envPath before upload."
  $bytes = $bytes[3..($bytes.Length - 1)]
}

$tempFile = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllBytes($tempFile, $bytes)
  Get-Content $tempFile -Raw | gh secret set DOTENV_CONTENT --repo mike43stone615/desk-api
  Write-Host "DOTENV_CONTENT updated for mike43stone615/desk-api."
} finally {
  Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
}
