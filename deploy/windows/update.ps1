# Deploys the latest code from GitHub the way Vercel does, without taking Thuso down:
#
#   1. fetch from GitHub (with -Auto: stop here if nothing is new),
#   2. back up .data, move to the new code,
#   3. build it into a second folder (.next-a / .next-b) while the running
#      version keeps serving: a failed build changes nothing,
#   4. switch: the server restarts on the new build (a few seconds; Caddy
#      holds visitors' requests meanwhile, so they wait instead of an error),
#   5. check it answers; if it does not, go back to the previous build.
#
# Only when the packages change (package-lock.json) does the app stop for the
# install, because the running app holds some package files open.
#
# By hand, in an Administrator window:   .\deploy\windows\update.ps1
# Every 5 minutes, the "Thuso Auto-update" task runs it with -Auto (install.ps1).
# Log: logs\deploy-<date>.log

param(
  [string]$AppDir = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [string]$Node = '',
  [string]$Git = '',
  [int]$Port = 3200,
  # From the scheduled task: only deploy when GitHub has something new, quietly otherwise.
  [switch]$Auto,
  # Rebuild and switch even when the code is already up to date.
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
Set-Location $AppDir
$logDir = Join-Path $AppDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("deploy-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
function Say([string]$t) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format s), $t); Write-Output $t }

# A program's own output goes to the log; its exit code comes back.
function Run([string]$exe, [string[]]$arguments) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $exe @arguments *>> $log; return $LASTEXITCODE } finally { $ErrorActionPreference = $old }
}
function GitOut([string[]]$arguments) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { return ((& $script:GitExe @arguments 2>$null) | Out-String).Trim() } finally { $ErrorActionPreference = $old }
}

# The running server: the "Thuso" task's run-thuso.ps1 loop starts it again within seconds when it stops.
function Stop-Server {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*$AppDir*next*start*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Restart-Server {
  $task = Get-ScheduledTask -TaskName 'Thuso' -ErrorAction SilentlyContinue
  Stop-Server
  if ($task -and $task.State -ne 'Running') { Start-ScheduledTask -TaskName 'Thuso' }
}
function Wait-Healthy([int]$seconds) {
  Start-Sleep -Seconds 3
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) {
    try {
      $r = Invoke-WebRequest "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}

# One deploy at a time (a stale lock from a crashed run expires after 40 minutes).
$lock = Join-Path $AppDir '.deploy.lock'
if ((Test-Path $lock) -and (Get-Item $lock).LastWriteTime -gt (Get-Date).AddMinutes(-40)) {
  if (-not $Auto) { Say 'Another deploy is running. Try again in a few minutes.' }
  exit 0
}
Set-Content -Path $lock -Value (Get-Date -Format s)

try {
  # The exact node.exe and git.exe (the task runs as SYSTEM, which may not have them on its PATH).
  if (-not $Node -or -not (Test-Path $Node)) { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $Node = $c.Source } }
  if (-not $Node) { throw 'node.exe not found. Run deploy\windows\install.ps1 -SkipBuild again in an Administrator window.' }
  if (-not $Git -or -not (Test-Path $Git)) { $c = Get-Command git -ErrorAction SilentlyContinue; if ($c) { $Git = $c.Source } }
  if (-not $Git) { throw 'git.exe not found. Run deploy\windows\install.ps1 -SkipBuild again in an Administrator window.' }
  $script:GitExe = $Git
  $npmCli = Join-Path (Split-Path $Node) 'node_modules\npm\bin\npm-cli.js'
  $nextBin = Join-Path $AppDir 'node_modules\next\dist\bin\next'

  if ((Run $Git @('fetch', '--quiet', 'origin')) -ne 0) { throw 'Could not reach GitHub (git fetch failed).' }
  $head = GitOut @('rev-parse', 'HEAD')
  $remote = GitOut @('rev-parse', '@{u}')
  if (-not $remote) { throw 'This folder does not track a GitHub branch.' }
  if ($head -eq $remote -and -not $Force) {
    if (-not $Auto) { Say 'Already up to date. (Use -Force to rebuild anyway.)' }
    exit 0
  }

  Say ("Deploying {0}: {1}" -f $remote.Substring(0, 7), (GitOut @('log', '-1', '--format=%s', $remote)))
  & "$PSScriptRoot\backup.ps1" -AppDir $AppDir | Out-Null
  $lockBefore = (Get-FileHash (Join-Path $AppDir 'package-lock.json')).Hash
  if ($head -ne $remote) {
    if ((Run $Git @('merge', '--ff-only', '--quiet', '@{u}')) -ne 0) { throw 'git could not move to the new code (are there local changes on the server? See git status).' }
  }
  $depsChanged = (Get-FileHash (Join-Path $AppDir 'package-lock.json')).Hash -ne $lockBefore -or -not (Test-Path $nextBin)

  $distFile = Join-Path $AppDir '.thuso-dist'
  $active = if (Test-Path $distFile) { (Get-Content $distFile -Raw).Trim() } else { '.next' }
  $target = if ($active -eq '.next-a') { '.next-b' } else { '.next-a' }

  if ($depsChanged) {
    Say 'The packages changed: Thuso stops for the install (a minute or two).'
    Stop-ScheduledTask -TaskName 'Thuso' -ErrorAction SilentlyContinue
    Stop-Server
    Start-Sleep -Seconds 2
    if ((Run $Node @($npmCli, 'ci', '--no-audit', '--no-fund')) -ne 0) {
      Start-ScheduledTask -TaskName 'Thuso' -ErrorAction SilentlyContinue
      throw 'npm ci failed (see this log). Thuso was restarted on its previous build; if it does not come up, run: npm ci; npm run build.'
    }
  }

  Say "Building into $target while $active keeps serving..."
  $targetPath = Join-Path $AppDir $target
  if (Test-Path $targetPath) { Remove-Item -Recurse -Force $targetPath }
  $env:CZ_DIST = $target
  $built = (Run $Node @($nextBin, 'build')) -eq 0
  Remove-Item Env:CZ_DIST -ErrorAction SilentlyContinue
  if (-not $built) {
    if ($depsChanged) { Start-ScheduledTask -TaskName 'Thuso' -ErrorAction SilentlyContinue }
    throw "The build failed (see this log). Nothing changed: $active is still live."
  }

  Say "Switching to $target..."
  Set-Content -Path $distFile -Value $target -NoNewline
  if ($depsChanged) { Start-ScheduledTask -TaskName 'Thuso' } else { Restart-Server }
  if (Wait-Healthy 150) {
    Say ("Live: {0} ({1})." -f $remote.Substring(0, 7), $target)
    # The very first build lived in .next; it is not needed once a/b take over.
    if ($active -eq '.next' -and (Test-Path (Join-Path $AppDir '.next'))) { Remove-Item -Recurse -Force (Join-Path $AppDir '.next') -ErrorAction SilentlyContinue }
  } else {
    Say "The new build did not answer within 150 seconds: going back to $active."
    Set-Content -Path $distFile -Value $active -NoNewline
    Restart-Server
    if (Wait-Healthy 150) { throw "Rolled back: $active is live again. The new build is in $target; see logs\thuso-<date>.log for why it did not start." }
    throw 'Rolled back, but Thuso is not answering. See logs\thuso-<date>.log.'
  }
} catch {
  Say ("Deploy stopped: {0}" -f $_.Exception.Message)
  if (-not $Auto) { throw }
} finally {
  Remove-Item $lock -ErrorAction SilentlyContinue
}
