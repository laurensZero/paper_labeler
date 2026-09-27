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

  // Portable EXE updater
  updaterDownloadPortable(opts: { url: string; sha256?: string }): Promise<{ ok?: boolean; path?: string; error?: string }>
  updaterFetchRelease?(url: string, headers?: Record<string, string>): Promise<{ status: number; url: string; body: string }>
  updaterApplyPortable(): Promise<{ ok?: boolean; error?: string }>
  updaterIsPortable?(): Promise<boolean>
  updaterOpenReleases?(): Promise<void>
  onUpdaterPortableProgress?(callback: (progress: { percent: number }) => void): void
  onUpdaterPortableDownloaded?(callback: (info: { path: string; sha256: string }) => void): void
  onUpdaterPortableError?(callback: (message: string) => void): void

  // Desktop / Start Menu shortcuts
  shortcutCreate?(): Promise<{ ok?: boolean; created?: string[]; error?: string }>
  shortcutStatus?(): Promise<{ desktop: boolean; startMenu: boolean; canCreate: boolean; error?: string }>
}

declare interface Window {
  electronAPI?: ElectronAPI
}
