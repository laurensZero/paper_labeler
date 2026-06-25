const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onMaximizeChange: (cb) => ipcRenderer.on('maximize-change', (_, val) => cb(val)),
  restartApp: () => ipcRenderer.send('app-restart'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  setTheme: (theme) => ipcRenderer.send('set-theme', theme),
})
