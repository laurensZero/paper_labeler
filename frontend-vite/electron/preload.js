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

  // Portable EXE updater
  updaterDownloadPortable: (opts) => ipcRenderer.invoke('updater:download-portable', opts),
  updaterFetchRelease: (url, headers) => ipcRenderer.invoke('updater:fetch-release', { url, headers }),
  updaterApplyPortable: () => ipcRenderer.invoke('updater:apply-portable'),
  updaterIsPortable: () => ipcRenderer.invoke('updater:is-portable'),
  updaterOpenReleases: (url) => ipcRenderer.invoke('updater:open-releases', { url }),
  onUpdaterPortableProgress: (cb) => ipcRenderer.on('updater:portable-progress', (_, progress) => cb(progress)),
  onUpdaterPortableDownloaded: (cb) => ipcRenderer.on('updater:portable-downloaded', (_, info) => cb(info)),
  onUpdaterPortableError: (cb) => ipcRenderer.on('updater:portable-error', (_, msg) => cb(msg)),

  // Desktop / Start Menu shortcuts
  shortcutCreate: () => ipcRenderer.invoke('shortcut:create'),
  shortcutStatus: () => ipcRenderer.invoke('shortcut:status'),
})
