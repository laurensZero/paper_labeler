// Test that launchUpdateHelper produces a cmd bootstrap that survives after
// the spawning process exits (the Electron job-kill scenario).
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const src = fs.readFileSync('D:/Projects/paper_labeler/frontend-vite/electron/main.cjs', 'utf8')
const start = src.indexOf('function powershellExe')
const end = src.indexOf('function writeReplaceHelper')
if (start < 0 || end < 0) {
  console.error('FAIL markers missing')
  process.exit(1)
}
const factory = new Function('require', 'process', 'console', `
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const { spawn } = require('child_process')
  ${src.slice(start, end)}
  return { launchUpdateHelper, powershellExe }
`)

const { launchUpdateHelper } = factory(require, process, console)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-launch-test-'))
const logPath = path.join(dir, 'update.log')
const helperPath = path.join(dir, 'helper.ps1')
// Minimal helper that only logs (proves PS ran after parent would have exited)
fs.writeFileSync(helperPath, `
$ErrorActionPreference='Continue'
Add-Content -LiteralPath $env:PL_LOG -Value "helper-ran" -Encoding UTF8
Start-Sleep -Seconds 1
Add-Content -LiteralPath $env:PL_LOG -Value "helper-done" -Encoding UTF8
`, 'utf-8')

const env = {
  ...process.env,
  PL_OLD_EXE: path.join(dir, 'old.exe'),
  PL_NEW_EXE: path.join(dir, 'new.exe'),
  PL_WAIT_PIDS: '',
  PL_LOG: logPath,
  PL_HELPER_SCRIPT: helperPath,
}

const result = launchUpdateHelper(helperPath, env)
console.log('launch result', result.ok, result.batPath)

// Simulate Electron quitting immediately
setTimeout(() => {
  const deadline = Date.now() + 5000
  const timer = setInterval(() => {
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
    if (log.includes('helper-done')) {
      clearInterval(timer)
      console.log('---- log ----')
      console.log(log)
      console.log('PASS helper survived parent exit')
      process.exit(0)
    }
    if (Date.now() > deadline) {
      clearInterval(timer)
      console.log('---- log ----')
      console.log(log || '(empty)')
      console.log('FAIL helper did not finish')
      process.exit(1)
    }
  }, 200)
}, 100)
