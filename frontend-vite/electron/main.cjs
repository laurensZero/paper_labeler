const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const net = require('net')
const http = require('http')

let backendProcess = null
let backendPort = 0

// In dev, ROOT is the project root. In packaged app, extraResources are next to the exe.
function getRoot() {
  if (app.isPackaged) {
    return process.resourcesPath
  }
  return path.resolve(__dirname, '..', '..')
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

async function startBackend() {
  const python = findPython()
  if (!python) {
    console.error('Python not found. Please install Python 3.8+ and add it to PATH.')
    app.quit()
    return
  }

  backendPort = await getFreePort()
  const root = getRoot()
  console.log(`Starting backend: ${python} on port ${backendPort}, cwd: ${root}`)

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

function waitForBackend(retries = 60) {
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
      req.setTimeout(500)
    }
    const retry = () => {
      attempt++
      if (attempt >= retries) {
        reject(new Error('Backend did not start in time'))
        return
      }
      setTimeout(check, 500)
    }
    check()
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    title: 'Paper Labeler',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  // In dev mode, load from Vite dev server; in production, load from built files
  const devUrl = process.env.ELECTRON_DEV_URL
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadURL(`http://127.0.0.1:${backendPort}/ui/`)
  }

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
  await startBackend()
  try {
    await waitForBackend()
    createWindow()
  } catch (err) {
    console.error(err)
    app.quit()
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
