const fs = require('fs')
const src = fs.readFileSync('D:/Projects/paper_labeler/frontend-vite/electron/main.cjs', 'utf8')
new Function(src)
console.log('main.cjs syntax OK')
const checks = [
  ['env paths', src.includes('PL_OLD_EXE') && src.includes('PL_NEW_EXE') && src.includes('PL_WAIT_PIDS')],
  ['wait ppid', src.includes('process.ppid')],
  ['log path', src.includes('updateLogPath')],
  ['same-volume download', src.includes('path.dirname(portableExePath)')],
  ['writable fallback', src.includes('W_OK')],
  ['always relaunch', src.includes('Restore-BackupAndLaunch')],
  ['health by pid/path', src.includes('ParentProcessId') && src.includes('ExecutablePath -ieq')],
  ['no legacy args[0]', !src.includes('$args[0]')],
  ['health wait env', src.includes('PL_HEALTH_WAIT_SEC')],
  ['replace attempts env', src.includes('PL_REPLACE_ATTEMPTS')],
  ['cmd bootstrap', src.includes('cmd-bootstrap')],
  ['job breakaway start', src.includes('launchUpdateHelper') && src.includes("start', '\"\"'")],
  ['confirm bootstrap before quit', src.includes('cmd-bootstrap') && src.includes('updater did not start')],
]
let failed = 0
for (const [n, ok] of checks) {
  console.log(ok ? 'PASS' : 'FAIL', n)
  if (!ok) failed++
}
process.exit(failed ? 1 : 0)
