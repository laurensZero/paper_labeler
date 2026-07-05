import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { i18n } from '@/i18n'
import { compareVersions, getLatestRelease, getLatestReleaseFromGitee, parseUpdateLevel, type UpdateLevel } from '@/utils/release'

function t(key: string) { return i18n.global.t(key) }

const REPO_OWNER = 'laurensZero'
const REPO_REPO = 'paper_labeler'
const MANIFEST_BASE: Record<string, string> = {
  gitee: 'https://gitee.com/laurenszero/paper_labeler/raw/gh-pages',
  github: 'https://laurenszero.github.io/paper_labeler',
}

interface Manifest {
  version: string
  url: string
  hash?: string
  notes?: string
  updateLevel?: UpdateLevel
  publishedAt?: string
}

// Update source: 'hot' = ZIP code update, 'full' = electron-updater EXE update
type UpdateSource = 'hot' | 'full'

export const useAppUpdateStore = defineStore('appUpdate', () => {
  // ── Core state ──
  const currentVersion = ref('')
  const latestVersion = ref('')
  const updateLevel = ref<UpdateLevel>('prompt')
  const releaseNotes = ref('')
  const updateSource = ref<UpdateSource | null>(null)
  const checking = ref(false)
  const downloading = ref(false)
  const downloadProgress = ref(0)
  const dialogVisible = ref(false)
  const error = ref('')
  const source = ref<'github' | 'gitee'>('github')
  const upToDate = ref(false)

  // Hot-update specific
  const hotDownloadUrl = ref('')
  const hotExpectedHash = ref('')

  // Full-update specific (electron-updater)
  const fullUpdateReady = ref(false)  // downloaded and ready to install
  const fullUpdateVersion = ref('')

  // Whether we're running inside Electron
  const isElectron = computed(() => !!window.electronAPI?.updaterCheck)

  // ── Init ──
  async function init() {
    try {
      const res = await fetch('/version')
      if (res.ok) {
        const data = await res.json()
        currentVersion.value = data.version || '0.0.0'
      }
    } catch {
      currentVersion.value = '0.0.0'
    }

    // Wire up electron-updater events (fire-and-forget from main process)
    if (isElectron.value) {
      const api = window.electronAPI!
      api.onUpdaterAvailable?.((info) => {
        console.log('[updater:full] available', info.version)
        fullUpdateVersion.value = info.version
        // Don't show dialog yet — hot update takes priority
      })

      api.onUpdaterProgress?.((progress) => {
        if (updateSource.value === 'full') {
          downloadProgress.value = progress.percent
        }
      })

      api.onUpdaterDownloaded?.((info) => {
        console.log('[updater:full] downloaded', info.version)
        fullUpdateReady.value = true
        downloading.value = false
        if (updateSource.value === 'full') {
          // Show "restart to install" state
          dialogVisible.value = true
        }
      })

      api.onUpdaterError?.((msg) => {
        console.error('[updater:full] error', msg)
        if (updateSource.value === 'full') {
          downloading.value = false
          error.value = msg
        }
      })

      api.onUpdaterNotAvailable?.(() => {
        // Only mark up-to-date if we already checked hot update and found nothing
        if (checking.value) return  // still in the middle of checkForUpdates
      })

      // Check if a full update was already downloaded from a previous session
      const alreadyDownloaded = await api.updaterIsDownloaded?.()
      if (alreadyDownloaded) {
        fullUpdateReady.value = true
        fullUpdateVersion.value = ''  // will be filled on next check
      }
    }
  }

  // ── Check for updates ──
  async function checkForUpdates(_opts?: { source?: 'startup' | 'manual' }) {
    if (checking.value) return
    checking.value = true
    error.value = ''
    upToDate.value = false
    updateSource.value = null
    dialogVisible.value = false

    try {
      // 1) Check hot update first (faster, smaller, preferred for code changes)
      const hotFound = await checkHotBundle()

      // 2) If no hot update, check full release via electron-updater or GitHub API
      if (!hotFound) {
        await checkFullRelease()
      }

      if (!dialogVisible.value && !fullUpdateReady.value) {
        upToDate.value = true
      }
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : t('update.checkFailed')
    } finally {
      checking.value = false
    }
  }

  // ── Hot update (ZIP-based code update) ──
  async function checkHotBundle(): Promise<boolean> {
    const order = source.value === 'github' ? ['github', 'gitee'] : ['gitee', 'github']
    const errors: string[] = []
    for (const src of order) {
      const base = MANIFEST_BASE[src]
      if (!base) continue
      try {
        const url = base + '/manifest.json'
        console.log('[update:hot] fetching', url)
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
        if (!res.ok) { errors.push(src + ': HTTP ' + res.status); continue }
        const m: Manifest = await res.json()
        console.log('[update:hot] manifest', m.version, 'current', currentVersion.value)
        if (compareVersions(m.version, currentVersion.value) > 0) {
          latestVersion.value = m.version
          hotDownloadUrl.value = base + '/' + m.url
          hotExpectedHash.value = m.hash || ''
          releaseNotes.value = m.notes || ''
          updateLevel.value = m.updateLevel || 'prompt'
          updateSource.value = 'hot'
          dialogVisible.value = true
          return true
        }
      } catch (e: unknown) {
        errors.push(src + ': ' + (e instanceof Error ? e.message : String(e)))
        continue
      }
    }
    if (errors.length) console.log('[update:hot] errors:', errors)
    return false
  }

  // ── Full release check ──
  async function checkFullRelease() {
    // If electron-updater is available, it already auto-checks on startup.
    // We just need to check if it found something.
    if (isElectron.value) {
      try {
        const result = await window.electronAPI!.updaterCheck!()
        if (result.error) {
          console.log('[update:full] electron-updater error, falling back to API:', result.error)
          await checkFullReleaseViaApi()
          return
        }
        if (result.hasUpdate && fullUpdateVersion.value) {
          latestVersion.value = fullUpdateVersion.value
          updateSource.value = 'full'
          updateLevel.value = 'prompt'
          // If already downloaded, show "restart to install"
          if (fullUpdateReady.value) {
            dialogVisible.value = true
          } else {
            // Auto-start download silently (VS Code style)
            startFullDownload()
          }
          return
        }
      } catch {
        // Fall through to API check
      }
    }

    // Browser mode or electron-updater failed — check via GitHub/Gitee API
    await checkFullReleaseViaApi()
  }

  async function checkFullReleaseViaApi() {
    try {
      const release = source.value === 'gitee'
        ? await getLatestReleaseFromGitee(REPO_OWNER, REPO_REPO)
        : await getLatestRelease(REPO_OWNER, REPO_REPO)
      const tag = release.tag_name.replace(/^v/i, '')
      if (compareVersions(tag, currentVersion.value) > 0) {
        latestVersion.value = tag
        releaseNotes.value = release.body
        updateLevel.value = parseUpdateLevel(release.body)
        updateSource.value = 'full'
        dialogVisible.value = true
      }
    } catch {
      // ignore
    }
  }

  // ── Download & apply ──
  async function downloadAndApply() {
    if (updateSource.value === 'hot') {
      await downloadAndApplyHot()
    } else if (updateSource.value === 'full') {
      if (fullUpdateReady.value) {
        // Already downloaded — just install
        await installFullUpdate()
      } else if (isElectron.value) {
        await startFullDownload()
      } else {
        // Browser mode — open release page
        openReleasePage()
      }
    }
  }

  async function downloadAndApplyHot() {
    if (!hotDownloadUrl.value) return
    downloading.value = true
    downloadProgress.value = 0
    error.value = ''

    try {
      const res = await fetch(hotDownloadUrl.value)
      if (!res.ok) throw new Error(t('update.downloadFailed') + ': ' + res.status)
      const total = Number(res.headers.get('content-length')) || 0
      const reader = res.body?.getReader()
      if (!reader) throw new Error('无法读取响应流')
      const chunks: BlobPart[] = []
      let received = 0

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        if (total) downloadProgress.value = Math.round(received / total * 100)
      }

      const blob = new Blob(chunks)

      if (hotExpectedHash.value) {
        const buf = await blob.arrayBuffer()
        const hashBuf = await crypto.subtle.digest('SHA-256', buf)
        const hash = Array.from(new Uint8Array(hashBuf))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')
        if (hash !== hotExpectedHash.value.replace(/^sha256:/i, '')) {
          throw new Error(t('update.hashMismatch'))
        }
      }

      const applyRes = await fetch('/admin/apply-update?version=' + encodeURIComponent(latestVersion.value), { method: 'POST', body: blob })
      if (!applyRes.ok) throw new Error(t('update.applyFailed'))

      dialogVisible.value = false
      restartApp()
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : t('update.downloadFailed')
    } finally {
      downloading.value = false
    }
  }

  async function startFullDownload() {
    if (!isElectron.value) return
    downloading.value = true
    downloadProgress.value = 0
    error.value = ''

    const result = await window.electronAPI!.updaterDownload!()
    if (result.error) {
      downloading.value = false
      error.value = result.error
    }
    // Progress and completion are handled by the onUpdaterProgress/onUpdaterDownloaded listeners
  }

  async function installFullUpdate() {
    if (!isElectron.value) return
    await window.electronAPI!.updaterInstall!()
  }

  function restartApp() {
    if (window.electronAPI?.restartApp) {
      window.electronAPI.restartApp()
    } else {
      setTimeout(() => {
        try { window.location.reload() } catch { window.location.href = '/' }
      }, 200)
    }
  }

  function openReleasePage() {
    // Fallback for browser mode — open GitHub releases
    const url = `https://github.com/${REPO_OWNER}/${REPO_REPO}/releases/latest`
    window.open(url, '_blank')
  }

  function dismiss() {
    if (updateLevel.value === 'force') return
    dialogVisible.value = false
  }

  // Computed: what to show in the dialog
  const dialogState = computed(() => {
    if (updateSource.value === 'hot') {
      if (downloading.value) return 'downloading-hot'
      return 'ready-hot'
    }
    if (updateSource.value === 'full') {
      if (fullUpdateReady.value) return 'ready-to-install'
      if (downloading.value) return 'downloading-full'
      return 'ready-full'
    }
    return 'idle'
  })

  return {
    // State
    currentVersion, latestVersion, updateLevel, releaseNotes,
    updateSource, checking, downloading, downloadProgress,
    dialogVisible, error, source, upToDate, fullUpdateReady,
    dialogState,
    // Actions
    init, checkForUpdates, downloadAndApply, openReleasePage, dismiss,
    installFullUpdate,
  }
})
