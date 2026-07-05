const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onMaximizeChange: (cb) => ipcRenderer.on('maximize-change', (_, val) => cb(val)),

  // App lifecycle
  restartApp: () => ipcRenderer.send('app-restart'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  setTheme: (theme) => ipcRenderer.send('set-theme', theme),

  // Auto-updater (electron-updater)
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterDownload: () => ipcRenderer.invoke('updater:download'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  updaterIsDownloaded: () => ipcRenderer.invoke('updater:is-downloaded'),
  onUpdaterAvailable: (cb) => ipcRenderer.on('updater:available', (_, info) => cb(info)),
  onUpdaterProgress: (cb) => ipcRenderer.on('updater:progress', (_, progress) => cb(progress)),
  onUpdaterDownloaded: (cb) => ipcRenderer.on('updater:downloaded', (_, info) => cb(info)),
  onUpdaterError: (cb) => ipcRenderer.on('updater:error', (_, msg) => cb(msg)),
  onUpdaterNotAvailable: (cb) => ipcRenderer.on('updater:not-available', () => cb()),
})
