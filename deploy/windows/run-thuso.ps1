# Keeps Thuso running on the VPS: starts the production server and starts it
# again if it ever stops. Started at boot by the "Thuso" scheduled task
# (install.ps1). Logs go to logs\thuso-<date>.log next to the app.

param(
  [string]$AppDir = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [int]$Port = 3200
)

Set-Location $AppDir
$logDir = Join-Path $AppDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$env:NODE_ENV = 'production'
$next = Join-Path $AppDir 'node_modules\next\dist\bin\next'

while ($true) {
  $log = Join-Path $logDir ("thuso-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
  Add-Content -Path $log -Value ("[{0}] starting Thuso on port {1}" -f (Get-Date -Format s), $Port)
  & node $next start -p $Port *>> $log
  Add-Content -Path $log -Value ("[{0}] Thuso stopped (exit {1}); restarting in 5 seconds" -f (Get-Date -Format s), $LASTEXITCODE)
  Start-Sleep -Seconds 5
}
