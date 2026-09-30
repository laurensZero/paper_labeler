# Simulates electron-builder portable NSIS stub:
#   parent starts child, child exits, parent still holds the exe lock while "RMDir cleanup",
# then runs the production helper and asserts replace succeeds after the stub is done.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-updater-stub-race.ps1
$ErrorActionPreference = 'Stop'
$failed = 0
$root = Join-Path $env:TEMP ('pl-stub-race-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null

function Assert([bool]$cond, [string]$msg) {
  if ($cond) { Write-Host "PASS $msg" }
  else { Write-Host "FAIL $msg"; $script:failed++ }
}

function New-MiniExe {
  param([string]$OutPath, [int]$SleepMs, [string]$Marker)
  $src = "$OutPath.cs"
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
  Add-Type -TypeDefinition (Get-Content -LiteralPath $src -Raw) -OutputAssembly $OutPath -OutputType ConsoleApplication | Out-Null
}

function Get-ProductionHelper {
  $node = $env:MIMO_NODE
  $js = @'
const fs = require('fs');
const path = require('path');
const os = require('os');
const src = fs.readFileSync('D:/Projects/paper_labeler/frontend-vite/electron/main.cjs', 'utf8');
const start = src.indexOf('function writeReplaceHelper');
const end = src.indexOf('function resolveShortcutTarget');
const fn = new Function('os', 'fs', 'path', src.slice(start, end) + '; return writeReplaceHelper')(os, fs, path);
process.stdout.write(fn());
'@
  $jsPath = Join-Path $root 'extract.js'
  Set-Content -LiteralPath $jsPath -Value $js -Encoding ASCII
  $out = & $node $jsPath
  return $out.Trim()
}

# Mini "NSIS stub": Start child, wait for child, then hold a lock on stubExe for N seconds
# (stand-in for RMDir of the extract dir while the portable exe stays mapped).
$stubSrc = Join-Path $root 'Stub.cs'
@"
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
class Stub {
  static void Main(string[] args) {
    string childExe = args[0];
    string holdPath = args[1];
    int holdMs = int.Parse(args[2]);
    var psi = new ProcessStartInfo(childExe) { UseShellExecute = false };
    var child = Process.Start(psi);
    if (child != null) child.WaitForExit();
    // Keep the portable exe "busy" like NSIS does during cleanup.
    using (var fs = new FileStream(holdPath, FileMode.Open, FileAccess.Read, FileShare.None)) {
      Thread.Sleep(holdMs);
    }
  }
}
"@ | Set-Content -LiteralPath $stubSrc -Encoding UTF8
$stubExe = Join-Path $root 'Paper Labeler-stub.exe'
Add-Type -TypeDefinition (Get-Content -LiteralPath $stubSrc -Raw) -OutputAssembly $stubExe -OutputType ConsoleApplication | Out-Null

# App under test: path with spaces, like production artifact names.
$appDir = Join-Path $root 'Paper Labeler'
New-Item -ItemType Directory -Path $appDir | Out-Null
$oldExe = Join-Path $appDir 'Paper Labeler-2.1.1-portable.exe'
$newExe = Join-Path $appDir 'paper-labeler-update-9.exe'
$childExe = Join-Path $appDir 'child-app.exe'
New-MiniExe -OutPath $childExe -SleepMs 30 -Marker 'CHILD'
New-MiniExe -OutPath $oldExe -SleepMs 20000 -Marker 'OLD'
New-MiniExe -OutPath $newExe -SleepMs 20000 -Marker 'NEW'
$oldHash = (Get-FileHash $oldExe -Algorithm SHA256).Hash
$newHash = (Get-FileHash $newExe -Algorithm SHA256).Hash

# Launch stub that will hold a lock on $oldExe for 4s after the child exits.
$holdMs = 4000
$stubProc = Start-Process -FilePath $stubExe -ArgumentList @($childExe, $oldExe, "$holdMs") -PassThru -WindowStyle Hidden
Write-Host "stub pid=$($stubProc.Id) holdMs=$holdMs"

# While stub is alive (even after its child exited), helper must NOT finish replace.
$helper = Get-ProductionHelper
$logPath = Join-Path $appDir 'update.log'
$job = Start-Job -ScriptBlock {
  param($helper, $old, $new, $log, $pids)
  $env:PL_OLD_EXE = $old
  $env:PL_NEW_EXE = $new
  $env:PL_WAIT_PIDS = ($pids -join ',')
  $env:PL_LOG = $log
  $env:PL_HELPER_SCRIPT = $helper
  $env:PL_HEALTH_WAIT_SEC = '2'
  $env:PL_REPLACE_ATTEMPTS = '40'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper
  $LASTEXITCODE
} -ArgumentList $helper, $oldExe, $newExe, $logPath, @($stubProc.Id)

Start-Sleep -Seconds 1
$midHash = (Get-FileHash $oldExe -Algorithm SHA256).Hash
Assert ($midHash -eq $oldHash) 'still OLD while stub holds lock (not replaced early)'

# Wait for helper to finish (it should wait out the stub lock).
$code = Receive-Job $job -Wait
Remove-Job $job -Force
$null = Wait-Process -Id $stubProc.Id -ErrorAction SilentlyContinue

Assert ($code -eq 0) "helper exit=0 (got $code)"
Assert ((Test-Path $oldExe)) 'app exe still present'
$finalHash = (Get-FileHash $oldExe -Algorithm SHA256).Hash
Assert ($finalHash -eq $newHash) 'exe replaced with NEW after stub released lock'
$log = if (Test-Path $logPath) { Get-Content $logPath -Raw } else { '' }
Assert ($log -match 'replaced ok') 'log contains replaced ok'
Assert ($log -match 'startup looks healthy') 'log contains healthy'
Assert ($log -match 'updater start') 'log contains start line with pids'
Write-Host "---- log ----"
Write-Host $log

# Cleanup any launched app from health check
Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and ($_.ExecutablePath -eq $oldExe -or $_.ExecutablePath -like '*pl-stub-race*')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "----"
if ($failed -eq 0) { Write-Host 'ALL PASSED'; exit 0 }
Write-Host "$failed FAILED"; exit 1
