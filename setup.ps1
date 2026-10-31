# AI <You>: your own Claude Code in Slack. One command in Windows PowerShell:
#
#   irm https://raw.githubusercontent.com/shownmedia/ai-me/main/setup.ps1 | iex
#
# Installs what's missing (Git, Node, Claude Code) for your user only, downloads the bot to ~\ai-me,
# then opens Claude Code, which builds your Slack bot with you (SETUP.md). No GitHub account needed.
# Safe to run again: it skips what's done, and on an existing bot it updates and re-checks it.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Repo = if ($env:AI_ME_REPO) { $env:AI_ME_REPO } else { 'https://github.com/shownmedia/ai-me.git' }
$Dir = Join-Path $HOME 'ai-me'
$Tools = Join-Path $HOME '.ai-me'
function Say($t) { Write-Host "`n$t" -ForegroundColor Cyan }
function Has($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Add-UserPath($p) {
  $cur = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($cur -split ';') -contains $p)) { [Environment]::SetEnvironmentVariable('Path', "$p;$cur", 'User') }
  if (-not (($env:Path -split ';') -contains $p)) { $env:Path = "$p;$env:Path" }
}
New-Item -ItemType Directory -Force -Path $Tools | Out-Null

Say 'Setting up your AI bot for Slack. About 10 minutes, most of it Claude doing the work.'

# 1. Git for Windows (Claude Code needs its bash; the bot uses git for updates)
if (-not (Has git)) {
  Say 'Installing Git'
  $rel = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'ai-me' }
  $asset = $rel.assets | Where-Object { $_.name -match '^Git-.*-64-bit\.exe$' } | Select-Object -First 1
  $exe = Join-Path $env:TEMP $asset.name
  Invoke-WebRequest $asset.browser_download_url -OutFile $exe
  Start-Process $exe -ArgumentList '/VERYSILENT', '/NORESTART', '/CURRENTUSER', '/NOCANCEL', '/SP-' -Wait
  foreach ($p in "$env:LOCALAPPDATA\Programs\Git\cmd", "$env:ProgramFiles\Git\cmd") { if (Test-Path $p) { Add-UserPath $p } }
  if (-not (Has git)) { throw 'Git did not install. Install it from https://git-scm.com/download/win and run this again.' }
}

# 2. Node 20.6+ (a private copy in ~\.ai-me\node when there isn't one, so no admin rights are needed)
$nodeOk = (Has node) -and ((node -e "const [a,b]=process.versions.node.split('.').map(Number); console.log(a>20||(a===20&&b>=6))") -eq 'true')
if (-not $nodeOk) {
  Say 'Installing Node'
  $ver = (Invoke-RestMethod 'https://nodejs.org/dist/index.json' | Where-Object { $_.lts } | Select-Object -First 1).version
  $zip = Join-Path $env:TEMP "node-$ver.zip"
  Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip
  Remove-Item (Join-Path $Tools 'node') -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $zip -DestinationPath $Tools -Force
  Rename-Item (Join-Path $Tools "node-$ver-win-x64") 'node'
  Add-UserPath (Join-Path $Tools 'node')
}

# 3. Claude Code (native installer, updates itself)
if (-not (Has claude)) {
  Say 'Installing Claude Code'
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  Add-UserPath (Join-Path $HOME '.local\bin')
}

# 4. The bot itself
if ((Test-Path $Dir) -and -not (Test-Path (Join-Path $Dir '.git'))) {
  Rename-Item $Dir "ai-me.broken-$([DateTimeOffset]::Now.ToUnixTimeSeconds())"   # a half-finished earlier download: start over
}
if (Test-Path (Join-Path $Dir '.git')) {
  Say 'Updating the bot in ~\ai-me'
  git -C $Dir pull --ff-only --quiet
  if ($LASTEXITCODE) { Write-Host "(couldn't update ~\ai-me, Claude will look at it)" }
} else {
  Say 'Downloading the bot to ~\ai-me'
  git clone --quiet $Repo $Dir
  if ($LASTEXITCODE) { throw 'Could not download the bot (git clone failed).' }
}
Push-Location $Dir
try { & npm ci --omit=dev --silent; if ($LASTEXITCODE) { throw 'npm ci failed' } } finally { Pop-Location }

# 5. Shown's Claude Code default: no permission prompt before every step (same as Shown setup).
$sp = Join-Path $HOME '.claude\settings.json'
New-Item -ItemType Directory -Force -Path (Split-Path $sp) | Out-Null
$s = if ((Test-Path $sp) -and (Get-Item $sp).Length) { Get-Content $sp -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
if (-not $s.permissions) { $s | Add-Member -NotePropertyName permissions -NotePropertyValue ([pscustomobject]@{}) -Force }
$s.permissions | Add-Member -NotePropertyName defaultMode -NotePropertyValue 'bypassPermissions' -Force
$s | Add-Member -NotePropertyName skipDangerousModePermissionPrompt -NotePropertyValue $true -Force
# No BOM: Windows PowerShell's utf8 adds one, and Claude Code can't read settings.json with it.
[IO.File]::WriteAllText($sp, ($s | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))

if ($env:AI_ME_NO_CLAUDE) { Write-Host 'setup.ps1: done (AI_ME_NO_CLAUDE set, not opening Claude)'; return }
Say 'Claude Code opens next. If it asks you to log in, use your Shown Claude account (ask Dylan Crispin if you do not have one).'
Write-Host 'Then just answer its questions. It makes the Slack app, connects your tools and tests the bot with you.'
Start-Sleep -Seconds 2
Set-Location $Dir
claude 'Set up my AI bot.'
