// Dev mode: start backend + Vite dev server + Electron.
// Frontend hot-reloads automatically via Vite HMR.
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')

const ROOT = path.resolve(__dirname, '..')
const isWin = process.platform === 'win32'
let backendProc = null
let electronProc = null

function findPython() {
  const candidates = ['python', 'python3', 'py']
  for (const cmd of candidates) {
    try {
      const { execSync } = require('child_process')
      execSync(`${cmd} --version`, { stdio: 'ignore' })
      return cmd
    } catch {}
  }
  return null
}

// 1. Start backend on port 8000
const python = findPython()
if (!python) {
  console.error('Python not found.')
  process.exit(1)
}

console.log('[watch] Starting backend...')
backendProc = spawn(python, ['-X', 'utf8', '-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', '8000'], {
  cwd: path.resolve(ROOT, '..'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  shell: isWin,
})
backendProc.stdout.setEncoding('utf-8')
backendProc.stderr.setEncoding('utf-8')
backendProc.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`))
backendProc.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`))

// 2. Start Vite dev server
console.log('[watch] Starting Vite...')
const viteBin = path.join(ROOT, 'node_modules', '.bin', isWin ? 'vite.cmd' : 'vite')
const vite = spawn(viteBin, ['--port', '5174'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: isWin,
})
vite.stdout.setEncoding('utf-8')
vite.stderr.setEncoding('utf-8')
vite.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`))
vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))

// 3. Wait for Vite, then start Electron
function waitForUrl(url, retries = 60) {
  return new Promise((resolve, reject) => {
    let attempt = 0
    const check = () => {
      const req = http.get(url, () => resolve())
      req.on('error', retry)
      req.setTimeout(1000)
    }
    const retry = () => {
      attempt++
      if (attempt >= retries) return reject(new Error('Timeout'))
      setTimeout(check, 500)
    }
    check()
  })
}

Promise.all([
  waitForUrl('http://127.0.0.1:8000/health'),
  waitForUrl('http://127.0.0.1:5174/ui/'),
]).then(() => {
  console.log('[watch] Backend + Vite ready, starting Electron...')
  const electronBin = path.join(ROOT, 'node_modules', '.bin', isWin ? 'electron.cmd' : 'electron')
  electronProc = spawn(electronBin, ['.'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWin,
    env: {
      ...process.env,
      ELECTRON_DEV_URL: 'http://127.0.0.1:5174/ui/',
    },
  })
  electronProc.on('exit', () => cleanup())
}).catch((err) => {
  console.error('[watch]', err)
  cleanup()
})

function cleanup() {
  if (backendProc) backendProc.kill()
  vite.kill()
  process.exit()
}

process.on('SIGINT', cleanup)
