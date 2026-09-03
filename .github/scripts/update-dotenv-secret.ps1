# Safely updates this repo's DOTENV_CONTENT deploy secret from the local
# .env file.
#
# Real incident #1: piping a raw .env straight into `gh secret set` (shell
# redirection, `< file`) corrupted its leading UTF-8 BOM into a literal "?"
# character, turning DATABASE_URL into ?DATABASE_URL and crashing this
# service (and the other three, hit the same way at the same time) on
# their next restart. "Fixed" at the time by stripping a BOM from the
# source bytes before upload, and switching to `Get-Content -Raw | gh
# secret set` instead of redirection.
#
# Real incident #2, confirmed live: that fix was itself unsafe. Piping a
# decoded .NET string through PowerShell's pipeline into a native
# executable's stdin goes through PowerShell's own encoding for output to
# native commands ($OutputEncoding, a UTF8Encoding that emits a BOM by
# default in Windows PowerShell 5.1) - so `Get-Content -Raw | gh secret
# set` reintroduces the exact same leading "?" corruption on its own,
# regardless of whether the source file has a BOM. This caused a second,
# near-identical full-platform outage.
#
# The only path confirmed not to touch that encoding layer at all: pass
# the content as a `--body` argument (a process argument, not stdin) built
# directly from the source file via .NET's own BOM-aware UTF8 reader.
#
# Usage: run from this repo's root: .github\scripts\update-dotenv-secret.ps1
$ErrorActionPreference = "Stop"
$env:Path = "C:\Program Files\GitHub CLI;$env:Path"
$envPath = Join-Path $PSScriptRoot "..\..\.env"
$envPath = (Resolve-Path $envPath).Path

# File.ReadAllText(path, encoding) still auto-detects and strips a leading
# BOM on read (StreamReader's default detectEncodingFromByteOrderMarks
# behavior) even with an explicit encoding given - it's used only as the
# fallback when no BOM is present. Handles a BOM'd source file correctly,
# and - unlike the pipe above - never adds one back.
$content = [System.IO.File]::ReadAllText($envPath, [System.Text.UTF8Encoding]::new($false))

gh secret set DOTENV_CONTENT --repo mike43stone615/desk-api --body $content
Write-Host "DOTENV_CONTENT updated for mike43stone615/desk-api."
