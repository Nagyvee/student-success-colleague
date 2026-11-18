# Update Thuso on the VPS to the latest code on GitHub: back up, pull, install,
# build, restart. Run in PowerShell as Administrator from the app folder:
#   .\deploy\windows\update.ps1

param([string]$AppDir = (Resolve-Path "$PSScriptRoot\..\..").Path)
$ErrorActionPreference = 'Stop'
Set-Location $AppDir

& "$PSScriptRoot\backup.ps1" -AppDir $AppDir
git pull --ff-only
npm ci
npm run build

# Restart: the task's loop starts the new build.
Stop-ScheduledTask -TaskName 'Thuso' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*$AppDir*next*start*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName 'Thuso'
Write-Output 'Thuso updated and restarted. Check logs\ for the start-up line.'
