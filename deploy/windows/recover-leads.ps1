# Repairs lead activity lost to the restart rollbacks of 19 Nov 2026 (fixed in 6856aa1).
#
# Each deploy backed up .data just before restarting; those backups hold each lead's activity
# from just before a rollback. This takes, for every lead in the list now, the most advanced
# state found in the recent backups (score, engagement, emails, opens, clicks, quiz, video,
# qualification, dialer status, replies). Leads no longer in the list are not brought back.
#
# Run once, in an Administrator window, AFTER the fix is deployed (logs\deploy-<date>.log
# shows 6856aa1 or later as Live):
#   .\deploy\windows\recover-leads.ps1
# Thuso is stopped for a few seconds while the leads are repaired, and a backup is taken first.

param(
  [string]$AppDir = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [int]$Days = 2
)
$ErrorActionPreference = 'Stop'
Set-Location $AppDir
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $elevated) { throw 'Run this in PowerShell opened with "Run as administrator".' }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe not found.' }

$zips = @(Get-ChildItem (Join-Path $AppDir 'backups') -Filter 'thuso-data-*.zip' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-$Days) } | Sort-Object LastWriteTime)
if (-not $zips.Count) { Write-Output "No backups from the last $Days days: nothing to repair from."; exit 0 }

$tmp = Join-Path $env:TEMP ("thuso-recover-" + (Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$dirs = @()
$i = 0
foreach ($z in $zips) {
  $d = Join-Path $tmp ("b{0}" -f $i)
  $i++
  Expand-Archive -Path $z.FullName -DestinationPath $d -Force
  $dirs += $d
}
Write-Output ("Read {0} backup(s). Stopping Thuso for a moment..." -f $zips.Count)

# No deploy while this runs.
$lock = Join-Path $AppDir '.deploy.lock'
Set-Content -Path $lock -Value (Get-Date -Format s)
try {
  Stop-ScheduledTask -TaskName 'Thuso' -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*$AppDir*next*start*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  & "$PSScriptRoot\backup.ps1" -AppDir $AppDir
  & $node "$PSScriptRoot\merge-records.mjs" (Join-Path $AppDir '.data') @dirs
  if ($LASTEXITCODE -ne 0) { throw 'The repair failed (see above); nothing was changed.' }
} finally {
  Start-ScheduledTask -TaskName 'Thuso'
  Remove-Item $lock -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
Write-Output 'Thuso is starting again. Reload Lead Nurturing in a minute.'
