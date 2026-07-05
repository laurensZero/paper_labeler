interface ElectronAPI {
  // Window controls
  minimize(): void
  maximize(): void
  close(): void
  isMaximized(): Promise<boolean>
  onMaximizeChange(callback: (maximized: boolean) => void): void

  // App lifecycle
  restartApp(): void
  selectFolder(): Promise<string | null>
  setTheme(theme: 'dark' | 'light'): void

  // Auto-updater (electron-updater)
  updaterCheck(): Promise<{ hasUpdate?: boolean; error?: string }>
  updaterDownload(): Promise<{ ok?: boolean; error?: string }>
  updaterInstall(): Promise<void>
  updaterIsDownloaded(): Promise<boolean>
  onUpdaterAvailable(callback: (info: { version: string; releaseNotes: string; releaseDate: string }) => void): void
  onUpdaterProgress(callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void): void
  onUpdaterDownloaded(callback: (info: { version: string }) => void): void
  onUpdaterError(callback: (message: string) => void): void
  onUpdaterNotAvailable(callback: () => void): void
}

declare interface Window {
  electronAPI?: ElectronAPI
}
