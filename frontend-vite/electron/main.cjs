const { app, BrowserWindow, ipcMain, nativeTheme, dialog } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const net = require('net')
const http = require('http')
const fs = require('fs')
const { autoUpdater } = require('electron-updater')

let backendProcess = null
let backendPort = 0
let mainWindow = null
let isUpdateDownloaded = false

// ROOT: where backend/ lives (for Python import).
function getRoot() {
  if (app.isPackaged) {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
    const exeDir = (portableDir && fs.existsSync(portableDir))
      ? portableDir
      : path.dirname(app.getPath('exe'))
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

  let exeDir
  if (app.isPackaged) {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
    if (portableDir && fs.existsSync(portableDir)) {
      exeDir = portableDir
    } else {
      exeDir = path.dirname(app.getPath('exe'))
    }
  } else {
    exeDir = path.resolve(__dirname, '..', '..')
  }

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
          execSync(`"${cached}" --version`, { stdio: 'ignore', timeout: 3000 })
          return cached
        } catch {}
      }
    }
  } catch {}

  const candidates = ['python', 'python3', 'py']
  const { execSync } = require('child_process')
  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore', timeout: 3000 })
      try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true })
        fs.writeFileSync(cachePath, cmd, 'utf-8')
      } catch {}
      return cmd
    } catch {}
  }
  return null
}

async function ensureDependencies(python) {
  const root = getRoot()
  const reqFile = path.join(root, 'requirements.txt')
  if (!fs.existsSync(reqFile)) {
    console.log('[deps] requirements.txt not found, skipping install')
    return
  }

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
        resolve()
      } else {
        reject(new Error(`pip install exited with code ${code}`))
      }
    })
  })
}

async function startBackend() {
  const python = findPython()
  if (!python) {
    console.error('Python not found. Please install Python 3.8+ and add it to PATH.')
    app.quit()
    return
  }

  try {
    await ensureDependencies(python)
  } catch (err) {
    console.error('[deps] Failed to install dependencies:', err.message)
  }

  backendPort = await getFreePort()
  const root = getRoot()
  const dataRoot = getDataRoot()
  console.log(`Starting backend: ${python} on port ${backendPort}, cwd: ${root}, dataRoot: ${dataRoot}`)

  backendProcess = spawn(python, [
    '-X', 'utf8',
    '-m', 'uvicorn', 'backend.main:app',
    '--host', '127.0.0.1',
    '--port', String(backendPort),
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PAPER_LABELER_PORT: String(backendPort),
      PAPER_LABELER_ROOT: dataRoot,
      PAPER_LABELER_BUNDLE_DIR: dataRoot,
      PAPER_LABELER_RESOURCES_DIR: root,
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

function waitForBackend(retries = 80) {
  return new Promise((resolve, reject) => {
    let attempt = 0
    const check = () => {
      const req = http.get(`http://127.0.0.1:${backendPort}/health`, (res) => {
        if (res.statusCode === 200) {
          resolve()
        } else {
          retry()
        }
      })
      req.on('error', retry)
      req.setTimeout(300)
    }
    const retry = () => {
      attempt++
      if (attempt >= retries) {
        reject(new Error('Backend did not start in time'))
        return
      }
      setTimeout(check, 200)
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

function makeErrorHtml(isDark) {
  const bg = isDark ? '#18181b' : '#ffffff'
  const text = isDark ? '#ef4444' : '#dc2626'
  const sub = isDark ? '#a1a1aa' : '#71717a'
  const btnBg = isDark ? '#27272a' : '#f4f4f5'
  const btnText = isDark ? '#e4e4e7' : '#18181b'
  const btnHover = isDark ? '#3f3f46' : '#e4e4e7'
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body{font-family:sans-serif;background:${bg};color:${text};display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column}
  h1{font-size:20px;margin-bottom:12px} p{color:${sub};font-size:14px}
  button{margin-top:20px;padding:8px 24px;background:${btnBg};color:${btnText};border:none;border-radius:6px;cursor:pointer;font-size:14px}
  button:hover{background:${btnHover}}
  </style></head><body><h1>后端启动失败</h1><p>请确认已安装 Python 3.8+ 并添加到 PATH</p>
  <button onclick="window.electronAPI.restartApp()">重试</button></body></html>`
}

// ── Auto-updater (electron-updater, VS Code style) ──
function setupAutoUpdater() {
  // Disable auto-download — we control it from the renderer via IPC
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for update...')
  })

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info.version)
    if (mainWindow) {
      mainWindow.webContents.send('updater:available', {
        version: info.version,
        releaseNotes: info.releaseNotes || '',
        releaseDate: info.releaseDate || '',
      })
    }
  })

  autoUpdater.on('update-not-available', (info) => {
    console.log('[updater] up to date:', info.version)
    if (mainWindow) {
      mainWindow.webContents.send('updater:not-available')
    }
  })

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) {
      mainWindow.webContents.send('updater:progress', {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      })
    }
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] downloaded:', info.version)
    isUpdateDownloaded = true
    if (mainWindow) {
      mainWindow.webContents.send('updater:downloaded', {
        version: info.version,
      })
    }
  })

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err.message)
    if (mainWindow) {
      mainWindow.webContents.send('updater:error', err.message)
    }
  })

  // IPC: renderer triggers
  ipcMain.handle('updater:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      return { hasUpdate: !!result?.updateInfo }
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('updater:install', () => {
    if (isUpdateDownloaded) {
      // Kill backend before installing
      killBackend()
      autoUpdater.quitAndInstall(false, true)
    }
  })

  ipcMain.handle('updater:is-downloaded', () => isUpdateDownloaded)

  // Check on startup (after window is shown)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => {
      console.log('[updater] startup check failed (non-fatal):', e.message)
    })
  }, 5000)
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
  setupAutoUpdater()
  startBackend()

  try {
    await waitForBackend()
    navigateToApp()
  } catch (err) {
    console.error(err)
    if (mainWindow) {
      const isDark = readSavedTheme() === 'dark'
      mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(makeErrorHtml(isDark))}`)
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
