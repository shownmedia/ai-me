# Windows version of bin/install.sh: runs the bot in the background at every login and
# restarts it if it exits. Uses a hidden Startup-folder launcher, so no admin rights needed.
# Usage: powershell -ExecutionPolicy Bypass -File bin\install.ps1             install + start
#        powershell -ExecutionPolicy Bypass -File bin\install.ps1 restart     restart (interrupted work resumes)
#        powershell -ExecutionPolicy Bypass -File bin\install.ps1 uninstall   stop + remove
param([string]$Action = 'install')
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Name = Split-Path -Leaf $Root
$Launcher = Join-Path ([Environment]::GetFolderPath('Startup')) "$Name.vbs"
$PidFile = Join-Path $Root 'data\runner.pid'
$Log = Join-Path $Root 'logs\bot.log'

function Stop-Bot {
  if (Test-Path $PidFile) {
    $id = (Get-Content $PidFile -Raw).Trim()
    if ($id) { & taskkill.exe /PID $id /T /F 2>$null | Out-Null }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }
}

function Start-Bot {
  & wscript.exe $Launcher
  Start-Sleep -Seconds 6
  if (Test-Path $Log) { Get-Content $Log -Tail 5 }
}

if ($Action -eq 'uninstall') {
  Stop-Bot
  Remove-Item $Launcher -Force -ErrorAction SilentlyContinue
  Write-Host "Removed $Name"
  exit 0
}
if ($Action -eq 'restart') { Stop-Bot; Start-Bot; exit 0 }

if (-not (Test-Path (Join-Path $Root '.env'))) { throw "Missing $Root\.env (copy .env.example and fill it in)" }
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { throw 'node not found on PATH (install Node 20.6 or newer)' }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw 'claude not found on PATH (install Claude Code first)' }

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs'), (Join-Path $Root 'data') | Out-Null
Push-Location $Root
try { & npm ci --omit=dev --silent; if ($LASTEXITCODE) { & npm install --omit=dev --silent } } finally { Pop-Location }

# The runner loop: start node, append its output to bot.log, wait 10s, repeat.
$Runner = Join-Path $Root 'data\run.ps1'
@"
`$PID | Set-Content -Encoding ascii '$PidFile'
Set-Location '$Root'
while (`$true) {
  & '$Node' --env-file=.env src\index.js 2>&1 | ForEach-Object { "`$_" } | Add-Content -Encoding utf8 logs\bot.log
  Start-Sleep -Seconds 10
}
"@ | Set-Content -Encoding utf8 $Runner

# Window style 0 = hidden, so nothing pops up at login.
"CreateObject(""WScript.Shell"").Run ""powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """"$Runner"""""", 0, False" |
  Set-Content -Encoding ascii $Launcher

Stop-Bot
Start-Bot
Write-Host "Installed $Name (starts at login). Logs: $Log"
