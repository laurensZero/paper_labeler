# Simulation tests for the portable replace-and-relaunch helper.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File test-replace-helper.ps1
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ("pl-updater-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$logPath = Join-Path $root 'update.log'
$failed = 0

function Assert([bool]$cond, [string]$msg) {
  if ($cond) { Write-Host "PASS $msg" }
  else { Write-Host "FAIL $msg"; $script:failed++ }
}

# Build a minimal helper script mirroring production writeReplaceHelper()
function New-HelpScript {
  $p = Join-Path $root 'helper.ps1'
  @'
$ErrorActionPreference = 'Continue'
$old = $env:PL_OLD_EXE
$new = $env:PL_NEW_EXE
$logPath = $env:PL_LOG
$helperScript = $env:PL_HELPER_SCRIPT
$waitPids = @()
if ($env:PL_WAIT_PIDS) {
  $waitPids = @($env:PL_WAIT_PIDS -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ } | ForEach-Object { [int]$_ })
}
function Log([string]$msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $msg
  try { Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 } catch {}
}
function Start-App([string]$exePath) {
  if (-not $exePath -or -not (Test-Path -LiteralPath $exePath)) { return $null }
  $workDir = Split-Path -Parent $exePath
  # Use cmd so tests can "run" a fake exe text file without execution policy issues.
  return Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', 'ping', '-n', '20', '127.0.0.1', '>', 'nul') -WorkingDirectory $workDir -PassThru -WindowStyle Hidden
}
Log ('updater start old={0} new={1} pids={2}' -f $old, $new, ($waitPids -join ','))
$deadline = (Get-Date).AddSeconds(120)
foreach ($procId in $waitPids) {
  while ((Get-Date) -lt $deadline) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { break }
    Start-Sleep -Milliseconds 200
  }
}
Start-Sleep -Milliseconds 200
if (-not $old -or -not (Test-Path -LiteralPath $old)) { Log 'old exe missing'; exit 1 }
if (-not $new -or -not (Test-Path -LiteralPath $new)) { Log 'update file missing'; [void](Start-App $old); exit 1 }
$backup = ($old + '.bak')
$replaced = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
  try {
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force -ErrorAction Stop }
    if (Test-Path -LiteralPath $old) { Move-Item -LiteralPath $old -Destination $backup -Force -ErrorAction Stop }
    try {
      Move-Item -LiteralPath $new -Destination $old -Force -ErrorAction Stop
    } catch {
      Copy-Item -LiteralPath $new -Destination $old -Force -ErrorAction Stop
      Remove-Item -LiteralPath $new -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath $old)) { throw 'replace produced no exe at target path' }
    $replaced = $true
    Log ('replaced ok (attempt {0})' -f $attempt)
    break
  } catch {
    Log ('replace failed (attempt {0}): {1}' -f $attempt, $_.Exception.Message)
    if (Test-Path -LiteralPath $backup) {
      try {
        if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue }
        Move-Item -LiteralPath $backup -Destination $old -Force -ErrorAction Stop
      } catch { Log ('rollback failed: {0}' -f $_.Exception.Message) }
    }
    Start-Sleep -Milliseconds 50
  }
}
if (-not $replaced) { Log 'replace abandoned'; [void](Start-App $old); exit 2 }
$launched = Start-App $old
Log ('relaunched pid={0}' -f $launched.Id)
if (Test-Path -LiteralPath $backup) {
  Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
}
exit 0
'@ | Set-Content -LiteralPath $p -Encoding UTF8
  return $p
}

function Invoke-Helper([string]$oldExe, [string]$newExe, [string[]]$pids) {
  $helper = New-HelpScript
  $env:PL_OLD_EXE = $oldExe
  $env:PL_NEW_EXE = $newExe
  $env:PL_WAIT_PIDS = ($pids -join ',')
  $env:PL_LOG = $logPath
  $env:PL_HELPER_SCRIPT = $helper
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper | Out-Null
  return $LASTEXITCODE
}

# --- Case 1: path with spaces, successful replace ---
$dir1 = Join-Path $root 'Paper Labeler'
New-Item -ItemType Directory -Path $dir1 | Out-Null
$old1 = Join-Path $dir1 'Paper Labeler-1.0.0-portable.exe'
$new1 = Join-Path $dir1 'paper-labeler-update.exe'
Set-Content -LiteralPath $old1 -Value 'OLD-CONTENT' -Encoding ascii
Set-Content -LiteralPath $new1 -Value 'NEW-CONTENT-LONGER' -Encoding ascii
$code = Invoke-Helper $old1 $new1 @()
Assert ($code -eq 0) "case1 exit=0 (got $code)"
Assert ((Get-Content -LiteralPath $old1 -Raw).Trim() -eq 'NEW-CONTENT-LONGER') 'case1 content replaced'
Assert (-not (Test-Path -LiteralPath ($old1 + '.bak'))) 'case1 backup cleaned'

# --- Case 2: missing update file relaunches current (does not delete app) ---
$dir2 = Join-Path $root 'case2'
New-Item -ItemType Directory -Path $dir2 | Out-Null
$old2 = Join-Path $dir2 'app.exe'
Set-Content -LiteralPath $old2 -Value 'OLD2' -Encoding ascii
$code = Invoke-Helper $old2 (Join-Path $dir2 'missing-update.exe') @()
Assert ($code -eq 1) "case2 exit=1 (got $code)"
Assert ((Test-Path $old2)) 'case2 old exe still present'
Assert ((Get-Content -LiteralPath $old2 -Raw).Trim() -eq 'OLD2') 'case2 content unchanged'

# --- Case 3: spaces + wait pid that exits quickly ---
$dir3 = Join-Path $root 'dir with spaces'
New-Item -ItemType Directory -Path $dir3 | Out-Null
$old3 = Join-Path $dir3 'Paper Labeler-1.0.1-portable.exe'
$new3 = Join-Path $dir3 'update file.exe'
Set-Content -LiteralPath $old3 -Value 'OLD3' -Encoding ascii
Set-Content -LiteralPath $new3 -Value 'NEW3' -Encoding ascii
$job = Start-Job -ScriptBlock { Start-Sleep -Milliseconds 300 }
$code = Invoke-Helper $old3 $new3 @($job.Id)
Wait-Job $job | Out-Null
Remove-Job $job -Force | Out-Null
Assert ($code -eq 0) "case3 exit=0 (got $code)"
Assert ((Get-Content -LiteralPath $old3 -Raw).Trim() -eq 'NEW3') 'case3 replaced after waiting for pid'

Write-Host "----"
if ($failed -eq 0) { Write-Host "ALL PASSED"; exit 0 }
Write-Host "$failed FAILED"; exit 1
