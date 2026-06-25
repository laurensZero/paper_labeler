interface ElectronAPI {
  minimize(): void
  maximize(): void
  close(): void
  isMaximized(): Promise<boolean>
  onMaximizeChange(callback: (maximized: boolean) => void): void
  setTheme(theme: 'dark' | 'light'): void
  getVersion(): Promise<string>
  checkForUpdates(): Promise<void>
  quitAndInstall(): Promise<void>
  onUpdateAvailable(callback: (info: unknown) => void): void
  onUpdateDownloaded(callback: (info: unknown) => void): void
  onUpdateError(callback: (error: unknown) => void): void
  onUpdateProgress(callback: (progress: unknown) => void): void
  openPath(path: string): Promise<void>
  showItemInFolder(path: string): Promise<void>
}

declare interface Window {
  electronAPI?: ElectronAPI
}
