# Nightly backup of Thuso's data (.data: the workspace, agents, leads, students,
# gradebooks, settings and the sign-in key). Keeps the last 14 copies.
# Scheduled daily at 02:00 by install.ps1. Copy the backups folder off the
# VPS from time to time (OneDrive, Google Drive or another server).

param(
  [string]$AppDir = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [string]$BackupDir = (Join-Path (Resolve-Path "$PSScriptRoot\..\..").Path 'backups'),
  [int]$Keep = 14
)

$data = Join-Path $AppDir '.data'
if (-not (Test-Path $data)) { Write-Output 'No .data folder yet: nothing to back up.'; exit 0 }
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$zip = Join-Path $BackupDir ("thuso-data-{0}.zip" -f (Get-Date -Format 'yyyy-MM-dd_HHmm'))
Compress-Archive -Path (Join-Path $data '*') -DestinationPath $zip -CompressionLevel Optimal -Force
Write-Output "Backed up to $zip"

Get-ChildItem $BackupDir -Filter 'thuso-data-*.zip' | Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep | Remove-Item -Force
