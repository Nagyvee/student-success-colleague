# Keeps Thuso running on the VPS: starts the production server and starts it
# again if it ever stops. Started at boot by the "Thuso" scheduled task
# (install.ps1). Logs go to logs\thuso-<date>.log next to the app.

param(
  [string]$AppDir = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [int]$Port = 3200,
  # node.exe. install.ps1 passes the one it found: the task runs as SYSTEM, which does not see a
  # Node.js installed only for one user (it is not on SYSTEM's PATH).
  [string]$Node = ''
)

Set-Location $AppDir
$logDir = Join-Path $AppDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$env:NODE_ENV = 'production'
$next = Join-Path $AppDir 'node_modules\next\dist\bin\next'

function Find-Node {
  if ($Node -and (Test-Path $Node)) { return $Node }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $guesses = @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", 'C:\Program Files\nodejs\node.exe')
  return ($guesses | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)
}

while ($true) {
  $log = Join-Path $logDir ("thuso-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
  $nodeExe = Find-Node
  if (-not $nodeExe) {
    Add-Content -Path $log -Value ("[{0}] node.exe not found. Run deploy\windows\install.ps1 again in an Administrator window (it records where Node.js is), or install Node.js for all users. Trying again in 60 seconds." -f (Get-Date -Format s))
    Start-Sleep -Seconds 60
    continue
  }
  Add-Content -Path $log -Value ("[{0}] starting Thuso on port {1} ({2})" -f (Get-Date -Format s), $Port, $nodeExe)
  try {
    & $nodeExe $next start -p $Port *>> $log
    $code = $LASTEXITCODE
  } catch {
    Add-Content -Path $log -Value ("[{0}] could not start: {1}" -f (Get-Date -Format s), $_.Exception.Message)
    $code = 'error'
  }
  Add-Content -Path $log -Value ("[{0}] Thuso stopped (exit {1}); restarting in 5 seconds" -f (Get-Date -Format s), $code)
  Start-Sleep -Seconds 5
}
