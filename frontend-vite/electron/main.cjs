const { app, BrowserWindow, ipcMain, nativeTheme, dialog, shell } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const net = require('net')
const http = require('http')
const https = require('https')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

let backendProcess = null
let backendPort = 0
let mainWindow = null
let depsInstallError = ''
let portableExePath = null
let pendingUpdateFile = null

// Directory next to the executable (portable dir when applicable), dev root otherwise.
function getExeDir() {
  if (app.isPackaged) {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
    if (portableDir && fs.existsSync(portableDir)) {
      return portableDir
    }
    return path.dirname(app.getPath('exe'))
  }
  return path.resolve(__dirname, '..', '..')
}

// ROOT: where backend/ lives (for Python import).
function getRoot() {
  if (app.isPackaged) {
    const exeDir = getExeDir()
    if (fs.existsSync(path.join(exeDir, 'backend', 'main.py'))) {
      return exeDir
    }
    return process.resourcesPath
  }
  return path.resolve(__dirname, '..', '..')
}

// DATA_ROOT: where data/ lives.
function getDataRoot() {
  const markerPath = path.join(app.getPath('userData'), 'data-root.txt')
  if (fs.existsSync(markerPath)) {
    const stored = fs.readFileSync(markerPath, 'utf-8').trim()
    if (stored && fs.existsSync(path.join(stored, 'data'))) return stored
  }

  const exeDir = getExeDir()

  const dataDir = path.join(exeDir, 'data')
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(markerPath, exeDir, 'utf-8')
  } catch {}

  return exeDir
}

// Find a free port
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

// Cache file for Python path
function getPythonCachePath() {
  return path.join(app.getPath('userData'), 'python-cache.txt')
}

function findPython() {
  const cachePath = getPythonCachePath()
  try {
    if (fs.existsSync(cachePath)) {
      const cached = fs.readFileSync(cachePath, 'utf-8').trim()
      if (cached) {
        const { execSync } = require('child_process')
        try {
          execSync(`"${cached}" --version`, { stdio: 'ignore', timeout: 1500 })
          return cached
        } catch {}
      }
    }
  } catch {}

  const candidates = ['python', 'python3', 'py']
  const { execSync } = require('child_process')
  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore', timeout: 1500 })
      try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true })
        fs.writeFileSync(cachePath, cmd, 'utf-8')
      } catch {}
      return cmd
    } catch {}
  }
  return null
}

function getDepsHashCachePath() {
  return path.join(app.getPath('userData'), 'deps-hash.txt')
}

async function ensureDependencies(python) {
  const root = getRoot()
  const reqFile = path.join(root, 'requirements.txt')
  if (!fs.existsSync(reqFile)) {
    console.log('[deps] requirements.txt not found, skipping install')
    return
  }

  const reqHash = crypto.createHash('sha256').update(fs.readFileSync(reqFile)).digest('hex')
  const hashCachePath = getDepsHashCachePath()
  try {
    if (fs.existsSync(hashCachePath) && fs.readFileSync(hashCachePath, 'utf-8').trim() === reqHash) {
      console.log('[deps] requirements unchanged, skipping install')
      return
    }
  } catch {}

  console.log('[deps] Installing Python dependencies...')
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-m', 'pip', 'install', '-r', reqFile, '--quiet', '--disable-pip-version-check', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (d) => process.stdout.write(`[deps] ${d}`))
    child.stderr?.on('data', (d) => process.stderr.write(`[deps] ${d}`))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        console.log('[deps] Dependencies OK')
        try {
          fs.mkdirSync(path.dirname(hashCachePath), { recursive: true })
          fs.writeFileSync(hashCachePath, reqHash, 'utf-8')
        } catch {}
        resolve()
      } else {
        reject(new Error(`pip install exited with code ${code}`))
      }
    })
  })
}

async function startBackend() {
  const [python, port] = await Promise.all([
    Promise.resolve().then(() => findPython()),
    getFreePort(),
  ])
  if (!python) {
    throw new Error('未找到 Python，请安装 Python 3.8+ 并添加到 PATH')
  }

  try {
    await ensureDependencies(python)
  } catch (err) {
    depsInstallError = err.message
    console.error('[deps] Failed to install dependencies:', err.message)
  }

  backendPort = port
  const root = getRoot()
  const dataRoot = getDataRoot()
  console.log(`Starting backend: ${python} on port ${backendPort}, cwd: ${root}, dataRoot: ${dataRoot}`)

  backendProcess = spawn(python, [
    '-X', 'utf8',
    '-m', 'uvicorn', 'backend.main:app',
    '--host', '127.0.0.1',
    '--port', String(backendPort),
    '--log-level', 'warning',
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PAPER_LABELER_PORT: String(backendPort),
      PAPER_LABELER_ROOT: dataRoot,
      PAPER_LABELER_BUNDLE_DIR: dataRoot,
      PAPER_LABELER_RESOURCES_DIR: root,
      PAPER_LABELER_APP_VERSION: app.getVersion(),
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
  })

  backendProcess.stdout.setEncoding('utf-8')
  backendProcess.stderr.setEncoding('utf-8')
  backendProcess.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`))
  backendProcess.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`))
  backendProcess.on('error', (err) => {
    console.error('Failed to start backend:', err)
  })
  backendProcess.on('exit', (code) => {
    console.log(`Backend exited with code ${code}`)
    backendProcess = null
  })
}

function waitForBackend(retries = 250) {
  return new Promise((resolve, reject) => {
    let attempt = 0
    const check = () => {
      const req = http.get(`http://127.0.0.1:${backendPort}/health`, (res) => {
        // Drain body so the socket can close promptly
        res.resume()
        if (res.statusCode === 200) {
          resolve()
        } else {
          retry()
        }
      })
      req.on('error', retry)
      req.setTimeout(150)
    }
    const retry = () => {
      attempt++
      if (attempt >= retries) {
        reject(new Error('后端服务未在预期时间内启动'))
        return
      }
      // Tight poll: backend is usually ready within 1-3s on warm Python
      setTimeout(check, attempt < 25 ? 50 : 150)
    }
    check()
  })
}

// --- Theme persistence (saved by frontend, read for splash) ---
function getThemeCachePath() {
  return path.join(app.getPath('userData'), 'theme-cache.txt')
}

function readSavedTheme() {
  try {
    const f = getThemeCachePath()
    if (fs.existsSync(f)) {
      const v = fs.readFileSync(f, 'utf-8').trim()
      if (v === 'dark' || v === 'light') return v
    }
  } catch {}
  // Fall back to system preference
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

function saveTheme(theme) {
  try {
    fs.mkdirSync(path.dirname(getThemeCachePath()), { recursive: true })
    fs.writeFileSync(getThemeCachePath(), theme, 'utf-8')
  } catch {}
}

// Generate splash HTML for given theme
function makeSplashHtml(isDark) {
  const bg = isDark ? '#18181b' : '#ffffff'
  const text = isDark ? '#e4e4e7' : '#18181b'
  const sub = isDark ? '#a1a1aa' : '#71717a'
  const spinnerTrack = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)'
  const spinnerAccent = isDark ? '#a78bfa' : '#7c3aed'
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: ${bg};
    color: ${text};
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    -webkit-app-region: drag;
    user-select: none;
  }
  .container { text-align: center; }
  h1 { font-size: 28px; font-weight: 600; margin-bottom: 8px; }
  .sub { color: ${sub}; font-size: 14px; margin-bottom: 32px; }
  .spinner {
    width: 36px; height: 36px;
    border: 3px solid ${spinnerTrack};
    border-top-color: ${spinnerAccent};
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin: 0 auto;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="container">
  <h1>Paper Labeler</h1>
  <p class="sub">正在启动后端服务…</p>
  <div class="spinner"></div>
</div>
</body>
</html>`
}

function makeErrorHtml(isDark, detail) {
  const bg = isDark ? '#18181b' : '#ffffff'
  const text = isDark ? '#ef4444' : '#dc2626'
  const sub = isDark ? '#a1a1aa' : '#71717a'
  const btnBg = isDark ? '#27272a' : '#f4f4f5'
  const btnText = isDark ? '#e4e4e7' : '#18181b'
  const btnHover = isDark ? '#3f3f46' : '#e4e4e7'
  const msg = String(detail || '请确认已安装 Python 3.8+ 并添加到 PATH')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body{font-family:sans-serif;background:${bg};color:${text};display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column}
  h1{font-size:20px;margin-bottom:12px} p{color:${sub};font-size:14px;max-width:80%;text-align:center;word-break:break-all}
  button{margin-top:20px;padding:8px 24px;background:${btnBg};color:${btnText};border:none;border-radius:6px;cursor:pointer;font-size:14px}
  button:hover{background:${btnHover}}
  </style></head><body><h1>后端启动失败</h1><p>${msg}</p>
  <button onclick="window.electronAPI.restartApp()">重试</button></body></html>`
}

// ── Portable EXE updater (download + helper replace) ──
function detectPortableExe() {
  if (!app.isPackaged) return null
  const envFile = process.env.PORTABLE_EXECUTABLE_FILE
  if (envFile && fs.existsSync(envFile)) return envFile
  const dir = process.env.PORTABLE_EXECUTABLE_DIR
  if (dir && fs.existsSync(dir)) {
    try {
      const names = fs.readdirSync(dir).filter((n) => /\.exe$/i.test(n))
      const hit = names.find((n) => /portable\.exe$/i.test(n))
        || names.find((n) => /paper.?labeler/i.test(n))
        || names[0]
      if (hit) return path.join(dir, hit)
    } catch {}
  }
  return null
}

function downloadFile(url, dest, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http
    const request = mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume()
        downloadFile(res.headers.location, dest, onProgress, redirectsLeft - 1).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error('HTTP ' + res.statusCode))
        return
      }
      const total = Number(res.headers['content-length']) || 0
      let received = 0
      const file = fs.createWriteStream(dest)
      res.on('data', (chunk) => {
        received += chunk.length
        if (total && onProgress) {
          onProgress(Math.min(100, Math.round((received / total) * 100)), received, total)
        }
      })
      res.pipe(file)
      file.on('finish', () => {
        file.close(() => resolve({ path: dest, size: received }))
      })
      file.on('error', (err) => {
        try { fs.unlinkSync(dest) } catch {}
        reject(err)
      })
      res.on('error', (err) => {
        try { file.close() } catch {}
        try { fs.unlinkSync(dest) } catch {}
        reject(err)
      })
    })
    request.on('error', reject)
  })
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function writeReplaceHelper(oldExe, newExe, pidToWait) {
  const scriptPath = path.join(os.tmpdir(), `paper-labeler-update-${Date.now()}.ps1`)
  const script = `
$ErrorActionPreference = 'Stop'
$old = $args[0]
$new = $args[1]
$pidWait = [int]$args[2]
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  $p = Get-Process -Id $pidWait -ErrorAction SilentlyContinue
  if (-not $p) { break }
  Start-Sleep -Milliseconds 250
}
Start-Sleep -Milliseconds 500
if (Test-Path -LiteralPath $new) {
  if (Test-Path -LiteralPath $old) {
    Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
  }
  Move-Item -LiteralPath $new -Destination $old -Force
  Start-Process -FilePath $old
}
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
`
  fs.writeFileSync(scriptPath, script, 'utf-8')
  return scriptPath
}

function setupPortableUpdater() {
  portableExePath = detectPortableExe()
  if (portableExePath) {
    console.log('[updater] portable exe:', portableExePath)
  }

  ipcMain.handle('updater:is-portable', () => !!portableExePath || !!process.env.PORTABLE_EXECUTABLE_DIR)

  ipcMain.handle('updater:open-releases', () => {
    shell.openExternal('https://github.com/laurensZero/paper_labeler/releases/latest')
  })

  ipcMain.handle('updater:download-portable', async (_event, opts) => {
    const url = String(opts?.url || '')
    const expected = String(opts?.sha256 || '').replace(/^sha256:/i, '').toLowerCase()
    if (!url) return { error: 'missing url' }
    if (!app.isPackaged || !portableExePath) {
      return { error: 'not a portable build' }
    }

    const dest = path.join(os.tmpdir(), `paper-labeler-${Date.now()}-update.exe`)
    try {
      await downloadFile(url, dest, (percent) => {
        if (mainWindow) {
          mainWindow.webContents.send('updater:portable-progress', { percent })
        }
      })

      if (expected) {
        const actual = await sha256File(dest)
        if (actual !== expected) {
          try { fs.unlinkSync(dest) } catch {}
          return { error: 'SHA-256 mismatch' }
        }
      }

      pendingUpdateFile = dest
      if (mainWindow) {
        mainWindow.webContents.send('updater:portable-downloaded', {
          path: dest,
          sha256: expected || '',
        })
      }
      return { ok: true, path: dest }
    } catch (e) {
      try { if (fs.existsSync(dest)) fs.unlinkSync(dest) } catch {}
      return { error: e.message || String(e) }
    }
  })

  ipcMain.handle('updater:apply-portable', async () => {
    if (!pendingUpdateFile || !fs.existsSync(pendingUpdateFile)) {
      return { error: 'update file not ready' }
    }
    if (!portableExePath) {
      return { error: 'portable exe path unknown' }
    }

    try {
      const helper = writeReplaceHelper(portableExePath, pendingUpdateFile, process.pid)
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', helper,
        portableExePath,
        pendingUpdateFile,
        String(process.pid),
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      console.log('[updater] helper launched, quitting app')
      pendingUpdateFile = null
      setTimeout(() => {
        killBackend()
        app.quit()
      }, 300)
      return { ok: true }
    } catch (e) {
      return { error: e.message || String(e) }
    }
  })
}

function createWindow() {
  const isDark = readSavedTheme() === 'dark'

  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    title: 'Paper Labeler',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    frame: false,
    backgroundColor: isDark ? '#18181b' : '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  // Open external links (window.open / target=_blank) in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Show splash immediately
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(makeSplashHtml(isDark))}`)
  win.once('ready-to-show', () => win.show())

  mainWindow = win

  // IPC: window controls
  ipcMain.on('window-minimize', () => win.minimize())
  ipcMain.on('window-maximize', () => {
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window-close', () => win.close())
  ipcMain.on('app-restart', () => {
    killBackend()
    app.relaunch()
    app.quit()
  })
  ipcMain.handle('select-folder', async () => {
    const { dialog } = require('electron')
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择旧数据文件夹',
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })
  ipcMain.handle('window-is-maximized', () => win.isMaximized())
  win.on('maximize', () => win.webContents.send('maximize-change', true))
  win.on('unmaximize', () => win.webContents.send('maximize-change', false))

  // IPC: theme sync — frontend calls this when theme changes
  ipcMain.on('set-theme', (_, theme) => {
    saveTheme(theme)
  })

  return win
}

function navigateToApp() {
  if (!mainWindow) return
  const devUrl = process.env.ELECTRON_DEV_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadURL(`http://127.0.0.1:${backendPort}/ui/`)
  }
}

function killBackend() {
  if (!backendProcess) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(backendProcess.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      backendProcess.kill('SIGTERM')
    }
  } catch {}
  backendProcess = null
}

app.whenReady().then(async () => {
  createWindow()
  setupPortableUpdater()

  try {
    await startBackend()
    await waitForBackend()
    navigateToApp()
  } catch (err) {
    console.error(err)
    if (mainWindow) {
      const isDark = readSavedTheme() === 'dark'
      const detail = depsInstallError
        ? `依赖安装失败：${depsInstallError}`
        : (err && err.message) || ''
      mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(makeErrorHtml(isDark, detail))}`)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  killBackend()
  app.quit()
})

app.on('before-quit', () => {
  killBackend()
})
