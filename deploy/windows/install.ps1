# One-time setup of Thuso on a Windows VPS. Run in PowerShell as Administrator
# from the app folder (after `git clone`):
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\deploy\windows\install.ps1 -Domain thuso.melsoft.org
#
# It installs the packages, builds the app, writes .env.local if there is none,
# and registers three things that run with no one logged in:
#   Thuso          the app, started at boot and restarted if it stops
#   Thuso Backup   a copy of .data every night at 02:00
#   Thuso HTTPS    Caddy, which serves https://<Domain> with a free certificate
#                  (only if caddy.exe is in deploy\windows\)

param(
  [Parameter(Mandatory = $true)][string]$Domain,
  [int]$Port = 3200,
  # Only register and start the tasks (the app is already installed and built).
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$AppDir = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $AppDir

# Registering tasks that run at boot needs an elevated window (signed in as Administrator is not enough).
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $elevated) { throw 'Run this in PowerShell opened with "Run as administrator" (right-click PowerShell in the Start menu). The title bar then starts with "Administrator:".' }

function Need($cmd, $hint) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd is not installed. $hint" } }
Need node 'Install Node.js 20 LTS or newer from https://nodejs.org, then open a new PowerShell window.'
Need git 'Install Git from https://git-scm.com/download/win.'
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw "Node.js $((node -v)) is too old; install Node.js 20 LTS or newer." }
# The task runs as SYSTEM, which may not have this Node.js on its PATH: give it the exact node.exe.
$NodeExe = (Get-Command node).Source

# Settings: secrets live only in .env.local on this machine (never in git).
$envFile = Join-Path $AppDir '.env.local'
if (-not (Test-Path $envFile)) {
  @"
# Thuso on the VPS. Fill in the keys, then run install.ps1 again (or update.ps1).
PUBLIC_BASE_URL=https://$Domain
ANTHROPIC_API_KEY=
DEEPGRAM_API_KEY=
# Keep sending locked until the team is happy with what the agents write.
SENDING_PAUSED=true
# The Postgres database on this VPS (student-success). No SSH tunnel here:
# the app and the database are on the same machine.
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=student-success
PGUSER=
PGPASSWORD=
"@ | Set-Content -Path $envFile -Encoding utf8
  Write-Output "Wrote $envFile. Add ANTHROPIC_API_KEY, DEEPGRAM_API_KEY and the database user and password (PGUSER, PGPASSWORD), then run this script again."
  exit 0
}

if (-not $SkipBuild) {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed (see above).' }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'The build failed (see above).' }
}

# The app: at boot, as SYSTEM, restarted by run-thuso.ps1 if it stops.
$run = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSScriptRoot\run-thuso.ps1`" -AppDir `"$AppDir`" -Port $Port -Node `"$NodeExe`"" -WorkingDirectory $AppDir
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$system = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'Thuso' -Action $run -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -Principal $system -Force | Out-Null

# Nightly backup of .data.
$bk = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\backup.ps1`" -AppDir `"$AppDir`"" -WorkingDirectory $AppDir
Register-ScheduledTask -TaskName 'Thuso Backup' -Action $bk -Trigger (New-ScheduledTaskTrigger -Daily -At 2am) -Principal $system -Force | Out-Null

# HTTPS with Caddy (download caddy.exe for Windows into deploy\windows\ first).
$caddy = Join-Path $PSScriptRoot 'caddy.exe'
if (Test-Path $caddy) {
  "$Domain {`n  encode gzip`n  reverse_proxy localhost:$Port`n}" | Set-Content -Path (Join-Path $PSScriptRoot 'Caddyfile') -Encoding ascii
  $cd = New-ScheduledTaskAction -Execute $caddy -Argument "run --config `"$PSScriptRoot\Caddyfile`" --adapter caddyfile" -WorkingDirectory $PSScriptRoot
  Register-ScheduledTask -TaskName 'Thuso HTTPS' -Action $cd -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -Principal $system -Force | Out-Null
  New-NetFirewallRule -DisplayName 'Thuso HTTP' -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow -ErrorAction SilentlyContinue | Out-Null
  New-NetFirewallRule -DisplayName 'Thuso HTTPS' -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -ErrorAction SilentlyContinue | Out-Null
  Start-ScheduledTask -TaskName 'Thuso HTTPS'
} else {
  Write-Output "caddy.exe not found in ${PSScriptRoot}, so HTTPS is skipped. Download it from https://caddyserver.com/download (Windows amd64), put it there, and run this again."
}

Start-ScheduledTask -TaskName 'Thuso'
Write-Output "Thuso is starting on port $Port. In a minute open https://$Domain (DNS: an A record for $Domain pointing at this VPS)."
