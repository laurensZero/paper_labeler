# Production-style live test with the Updater.exe that ships in Paper Labeler 2.1.5.
$ErrorActionPreference = 'Stop'
$failed = 0
function Assert([bool]$c, [string]$m) {
  if ($c) { Write-Host "PASS $m" } else { Write-Host "FAIL $m"; $script:failed++ }
}

$pkg = "C:\Users\laurens_zero\Downloads\Compressed\Paper Labeler-2.1.5-portable.exe"
$upd = "C:\Users\laurens_zero\AppData\Local\Temp\pl-215-real\asar\electron\PaperLabelerUpdater.exe"
if (-not (Test-Path $upd)) {
  # re-extract if needed
  $7z = "C:\ProgramData\chocolatey\tools\7z.exe"
  $ex = Join-Path $env:TEMP "pl-215-real"
  if (-not (Test-Path "$ex\app\resources\app.asar")) {
    New-Item -ItemType Directory -Force $ex | Out-Null
    & $7z x $pkg -o"$ex" -y | Out-Null
    & $7z x "$ex\`$PLUGINSDIR\app-64.7z" -o"$ex\app" -y | Out-Null
  }
  Set-Location "D:\Projects\paper_labeler\frontend-vite"
  node -e "require('@electron/asar').extractAll(process.argv[1],process.argv[2])" "$ex\app\resources\app.asar" "$ex\asar"
  $upd = "$ex\asar\electron\PaperLabelerUpdater.exe"
}
Assert (Test-Path $pkg) "2.1.5 package"
Assert (Test-Path $upd) "Updater.exe from 2.1.5"

$inst = Join-Path $env:TEMP ("pl-215-prod-" + [guid]::NewGuid().ToString('N') + "\Paper Labeler")
New-Item -ItemType Directory -Path $inst -Force | Out-Null
$oldExe = Join-Path $inst "Paper Labeler-2.1.5-portable.exe"
$newExe = Join-Path $inst "paper-labeler-update-live.exe"
Copy-Item $pkg $oldExe
Copy-Item $pkg $newExe

# locker: hold exe open (NSIS stub RMDir stand-in)
$cs = Join-Path $inst "locker.cs"
Set-Content -LiteralPath $cs -Encoding UTF8 -Value @'
using System; using System.IO; using System.Threading;
class L {
  static void Main(string[] a) {
    using (var fs = new FileStream(a[0], FileMode.Open, FileAccess.Read, FileShare.Read)) {
      Thread.Sleep(int.Parse(a[1]));
    }
  }
}
'@
$locker = Join-Path $inst "locker.exe"
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /out:"$locker" "$cs"
if (-not (Test-Path $locker)) { Write-Host "FAIL locker compile"; exit 1 }
$lockProc = Start-Process -FilePath $locker -ArgumentList @($oldExe, "3000") -PassThru -WindowStyle Hidden
Write-Host "locker pid=$($lockProc.Id)"

$log = Join-Path $inst "update.log"
$bat = Join-Path $inst "run.cmd"
# same shape as main.cjs launchUpdater: cmd-bootstrap then Updater.exe with --pids
$lines = @(
  '@echo off',
  "echo [%date% %time%] cmd-bootstrap updater=`"$upd`">>`"$log`"",
  "`"$upd`" --old `"$oldExe`" --new `"$newExe`" --log `"$log`" --pids $($lockProc.Id),12345",
  "echo [%date% %time%] updater-exit=%errorlevel%>>`"$log`""
)
Set-Content -LiteralPath $bat -Value ($lines -join "`r`n") -Encoding ASCII

Write-Host "starting via cmd /c start (detached)..."
Start-Process -FilePath "cmd.exe" -ArgumentList @('/c', 'start', '""', '/b', "`"$bat`"") -WindowStyle Hidden | Out-Null

$deadline = (Get-Date).AddSeconds(45)
$done = $false
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $log) {
    $t = Get-Content -LiteralPath $log -Raw
    if ($t -match 'updater-exit=|startup looks healthy') { $done = $true; break }
  }
  Start-Sleep -Milliseconds 300
}

Write-Host "---- update.log ----"
if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log } else { Write-Host "(no log)" }
Write-Host "---- dir ----"
Get-ChildItem -LiteralPath $inst | Format-Table Name, Length

$logText = if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Raw } else { '' }
Assert $done "updater finished"
Assert ($logText -match 'cmd-bootstrap') "cmd-bootstrap"
Assert ($logText -match 'replaced ok') "replaced ok"
Assert ($logText -match 'startup looks healthy') "healthy"
Assert (Test-Path -LiteralPath $oldExe) "app exe present"
Assert (-not (Test-Path -LiteralPath $newExe)) "update package consumed"
Assert (-not (Test-Path -LiteralPath ($oldExe + '.bak'))) "no .bak leftover"

Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'locker.exe' -or ($_.ExecutablePath -and $_.ExecutablePath -eq $oldExe)
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "===="
if ($failed -eq 0) { Write-Host "ALL PASSED"; exit 0 }
Write-Host "$failed FAILED"; exit 1
