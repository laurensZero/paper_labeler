# End-to-end tests for the portable replace-and-relaunch updater helper.
# Uses real PE executables (compiled on the fly) so Start-Process works.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-updater-e2e.ps1
$ErrorActionPreference = 'Stop'
$failed = 0
$root = Join-Path $env:TEMP ('pl-updater-e2e-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null

function Assert([bool]$cond, [string]$msg) {
  if ($cond) { Write-Host "PASS $msg" }
  else { Write-Host "FAIL $msg"; $script:failed++ }
}

function New-MiniExe {
  param([string]$OutPath, [int]$SleepMs, [string]$Marker)
  $src = Join-Path ($root) ((Split-Path -Leaf $OutPath) + '.cs')
  @"
using System;
using System.IO;
using System.Threading;
class App {
  static void Main() {
    try { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "$Marker.ran"), "$Marker"); } catch {}
    Thread.Sleep($SleepMs);
  }
}
"@ | Set-Content -LiteralPath $src -Encoding UTF8
  $dir = Split-Path -Parent $OutPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  Add-Type -TypeDefinition (Get-Content -LiteralPath $src -Raw) -OutputAssembly $OutPath -OutputType ConsoleApplication | Out-Null
  if (-not (Test-Path -LiteralPath $OutPath)) { throw "failed to build $OutPath" }
}

function Get-ProductionHelper {
  $node = $env:MIMO_NODE
  if (-not $node) { throw 'MIMO_NODE not set' }
  $js = @'
const fs = require('fs');
const path = require('path');
const os = require('os');
const src = fs.readFileSync('D:/Projects/paper_labeler/frontend-vite/electron/main.cjs', 'utf8');
const start = src.indexOf('function writeReplaceHelper');
const end = src.indexOf('function resolveShortcutTarget');
if (start < 0 || end < 0) { console.error('markers missing'); process.exit(1); }
const fn = new Function('os', 'fs', 'path', src.slice(start, end) + '; return writeReplaceHelper')(os, fs, path);
process.stdout.write(fn());
'@
  $jsPath = Join-Path $root 'extract-helper.js'
  Set-Content -LiteralPath $jsPath -Value $js -Encoding UTF8
  $out = & $node $jsPath
  if ($LASTEXITCODE -ne 0 -or -not $out) { throw 'failed to extract production helper' }
  return $out.Trim()
}

function Invoke-ProductionHelper {
  param(
    [string]$OldExe,
    [string]$NewExe,
    [string[]]$WaitPids = @(),
    [int]$HealthWaitSec = 2,
    [int]$ReplaceAttempts = 30
  )
  $helper = Get-ProductionHelper
  $logPath = Join-Path (Split-Path -Parent $OldExe) 'update.log'
  $env:PL_OLD_EXE = $OldExe
  $env:PL_NEW_EXE = $NewExe
  $env:PL_WAIT_PIDS = ($WaitPids -join ',')
  $env:PL_LOG = $logPath
  $env:PL_HELPER_SCRIPT = $helper
  $env:PL_HEALTH_WAIT_SEC = "$HealthWaitSec"
  $env:PL_REPLACE_ATTEMPTS = "$ReplaceAttempts"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper
  $code = $LASTEXITCODE
  $sw.Stop()
  return [pscustomobject]@{ ExitCode = $code; LogPath = $logPath; ElapsedMs = $sw.ElapsedMilliseconds; Helper = $helper }
}

function Get-Hash([string]$p) {
  (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
}

function Read-Log([string]$p) {
  if (Test-Path -LiteralPath $p) { Get-Content -LiteralPath $p -Raw } else { '' }
}

Write-Host "== building fixtures =="
$sleeperOld = Join-Path $root 'sleeper-old.exe'
$sleeperNew = Join-Path $root 'sleeper-new.exe'
$quitter = Join-Path $root 'quitter.exe'
New-MiniExe -OutPath $sleeperOld -SleepMs 25000 -Marker 'OLD'
New-MiniExe -OutPath $sleeperNew -SleepMs 25000 -Marker 'NEW'
New-MiniExe -OutPath $quitter -SleepMs 50 -Marker 'QUIT'
$hashOld = Get-Hash $sleeperOld
$hashNew = Get-Hash $sleeperNew
Assert ($hashOld -ne $hashNew) 'fixture exes have different hashes'

# ── Case 1: path with spaces, successful replace + relaunch stays alive ──
Write-Host "`n== case1 spaces + success =="
$dir1 = Join-Path $root 'Paper Labeler App'
New-Item -ItemType Directory -Path $dir1 | Out-Null
$old1 = Join-Path $dir1 'Paper Labeler-1.0.0-portable.exe'
$new1 = Join-Path $dir1 'paper-labeler-update-1.exe'
Copy-Item $sleeperOld $old1 -Force
Copy-Item $sleeperNew $new1 -Force
$r = Invoke-ProductionHelper -OldExe $old1 -NewExe $new1 -HealthWaitSec 2
Assert ($r.ExitCode -eq 0) "case1 exit=0 (got $($r.ExitCode))"
Assert ((Get-Hash $old1) -eq $hashNew) 'case1 exe content is NEW'
Assert (-not (Test-Path ($old1 + '.bak'))) 'case1 backup removed'
Assert (Test-Path $old1) 'case1 app still present'
Assert ((Read-Log $r.LogPath) -match 'startup looks healthy') 'case1 log healthy'
Assert ((Read-Log $r.LogPath) -match 'replaced ok') 'case1 log replaced'
# cleanup running sleeper
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -eq $old1 } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# ── Case 2: missing update package → relaunch old, do not delete app ──
Write-Host "`n== case2 missing update =="
$dir2 = Join-Path $root 'case2'
New-Item -ItemType Directory -Path $dir2 | Out-Null
$old2 = Join-Path $dir2 'app.exe'
Copy-Item $sleeperOld $old2 -Force
$r = Invoke-ProductionHelper -OldExe $old2 -NewExe (Join-Path $dir2 'nope.exe') -HealthWaitSec 1
Assert ($r.ExitCode -eq 1) "case2 exit=1 (got $($r.ExitCode))"
Assert (Test-Path $old2) 'case2 app still present'
Assert ((Get-Hash $old2) -eq $hashOld) 'case2 content unchanged'
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -eq $old2 } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# ── Case 3: new exe exits immediately → rollback to old and relaunch ──
Write-Host "`n== case3 crash-on-start rollback =="
$dir3 = Join-Path $root 'case3'
New-Item -ItemType Directory -Path $dir3 | Out-Null
$old3 = Join-Path $dir3 'app.exe'
$new3 = Join-Path $dir3 'update.exe'
Copy-Item $sleeperOld $old3 -Force
Copy-Item $quitter $new3 -Force
$r = Invoke-ProductionHelper -OldExe $old3 -NewExe $new3 -HealthWaitSec 2
Assert ($r.ExitCode -eq 3) "case3 exit=3 (got $($r.ExitCode))"
Assert (Test-Path $old3) 'case3 app still present after rollback'
Assert ((Get-Hash $old3) -eq $hashOld) 'case3 rolled back to OLD'
Assert ((Read-Log $r.LogPath) -match 'exited quickly') 'case3 log rollback reason'
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -eq $old3 } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# ── Case 4: exe locked by another process (NSIS-stub-like) then unlocked ──
Write-Host "`n== case4 locked then unlocked =="
$dir4 = Join-Path $root 'case4'
New-Item -ItemType Directory -Path $dir4 | Out-Null
$old4 = Join-Path $dir4 'app.exe'
$new4 = Join-Path $dir4 'update.exe'
Copy-Item $sleeperOld $old4 -Force
Copy-Item $sleeperNew $new4 -Force
# Hold the file open without FileShare.Delete so rename/replace is blocked.
$hold = [System.IO.File]::Open($old4, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
$job = Start-Job -ScriptBlock {
  param($helper, $old, $new, $log)
  $env:PL_OLD_EXE = $old
  $env:PL_NEW_EXE = $new
  $env:PL_WAIT_PIDS = ''
  $env:PL_LOG = $log
  $env:PL_HELPER_SCRIPT = $helper
  $env:PL_HEALTH_WAIT_SEC = '2'
  $env:PL_REPLACE_ATTEMPTS = '8'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper
  $LASTEXITCODE
} -ArgumentList (Get-ProductionHelper), $old4, $new4, (Join-Path $dir4 'update.log')
Start-Sleep -Seconds 2
$hold.Close()
$hold.Dispose()
$code = Receive-Job $job -Wait
Remove-Job $job -Force
Assert ($code -eq 0) "case4 exit=0 after unlock (got $code)"
Assert ((Get-Hash $old4) -eq $hashNew) 'case4 eventually replaced after lock released'
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -eq $old4 } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# ── Case 5: waits for a still-running pid (portable stub) before replace ──
Write-Host "`n== case5 waits for pids =="
$dir5 = Join-Path $root 'case5'
New-Item -ItemType Directory -Path $dir5 | Out-Null
$old5 = Join-Path $dir5 'app.exe'
$new5 = Join-Path $dir5 'update.exe'
Copy-Item $sleeperOld $old5 -Force
Copy-Item $sleeperNew $new5 -Force
$stub = Start-Process -FilePath $sleeperOld -PassThru
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$job = Start-Job -ScriptBlock {
  param($helper, $old, $new, $log, $stubPid)
  $env:PL_OLD_EXE = $old
  $env:PL_NEW_EXE = $new
  $env:PL_WAIT_PIDS = "$stubPid"
  $env:PL_LOG = $log
  $env:PL_HELPER_SCRIPT = $helper
  $env:PL_HEALTH_WAIT_SEC = '2'
  $env:PL_REPLACE_ATTEMPTS = '5'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper
  $LASTEXITCODE
} -ArgumentList (Get-ProductionHelper), $old5, $new5, (Join-Path $dir5 'update.log'), $stub.Id
Start-Sleep -Seconds 1
# Replace must not have finished while stub pid is alive.
$midHash = Get-Hash $old5
Assert ($midHash -eq $hashOld) 'case5 still OLD while wait-pid alive'
Stop-Process -Id $stub.Id -Force -ErrorAction SilentlyContinue
$code = Receive-Job $job -Wait
Remove-Job $job -Force
$sw.Stop()
Assert ($code -eq 0) "case5 exit=0 (got $code)"
Assert ((Get-Hash $old5) -eq $hashNew) 'case5 replaced after pid exited'
Assert ($sw.ElapsedMilliseconds -ge 1000) "case5 waited for pid (elapsed $($sw.ElapsedMilliseconds)ms)"
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -eq $old5 } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# ── Case 6: env-var path with spaces + unicode-free production extract ──
Write-Host "`n== case6 extract + parse production helper =="
$helper = Get-ProductionHelper
Assert (Test-Path $helper) 'case6 helper file exists'
$parseErr = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($helper, [ref]$null, [ref]$parseErr)
Assert ((-not $parseErr) -or ($parseErr.Count -eq 0)) 'case6 production helper parses'

Write-Host "`n== summary =="
if ($failed -eq 0) { Write-Host 'ALL PASSED'; exit 0 }
Write-Host "$failed FAILED"
exit 1
