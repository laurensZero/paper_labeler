import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { i18n } from '@/i18n'
import { compareVersions, getLatestRelease, getLatestReleaseFromGitee, parseUpdateLevel, resolvePortableAsset, type UpdateLevel } from '@/utils/release'

function t(key: string) { return i18n.global.t(key) }

const REPO_OWNER = 'laurensZero'
const REPO_REPO = 'paper_labeler'

export const useAppUpdateStore = defineStore('appUpdate', () => {
  // ── Core state ──
  const currentVersion = ref('')
  const latestVersion = ref('')
  const updateLevel = ref<UpdateLevel>('prompt')
  const releaseNotes = ref('')
  const checking = ref(false)
  const downloading = ref(false)
  const downloadProgress = ref(0)
  const applying = ref(false)
  const dialogVisible = ref(false)
  const error = ref('')
  const source = ref<'github' | 'gitee'>('github')
  const upToDate = ref(false)

  // Portable EXE download
  const downloadUrl = ref('')
  const expectedSha256 = ref('')
  const downloadReady = ref(false)

  const isElectron = computed(() => !!window.electronAPI?.updaterDownloadPortable)

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

    if (isElectron.value) {
      window.electronAPI!.onUpdaterPortableProgress?.((progress) => {
        downloadProgress.value = progress.percent
      })
      window.electronAPI!.onUpdaterPortableDownloaded?.((info) => {
        downloadReady.value = true
        downloading.value = false
        if (info.sha256) expectedSha256.value = info.sha256
        dialogVisible.value = true
      })
      window.electronAPI!.onUpdaterPortableError?.((msg) => {
        downloading.value = false
        applying.value = false
        error.value = msg
      })
    }
  }

  // ── Check for updates ──
  async function checkForUpdates(_opts?: { source?: 'startup' | 'manual' }) {
    if (checking.value) return
    checking.value = true
    error.value = ''
    upToDate.value = false
    dialogVisible.value = false
    downloadReady.value = false

    try {
      await checkRelease()
      if (!dialogVisible.value) {
        upToDate.value = true
      }
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : t('update.checkFailed')
    } finally {
      checking.value = false
    }
  }

  async function checkRelease() {
    const order = source.value === 'gitee' ? ['gitee', 'github'] : ['github', 'gitee']
    const errors: string[] = []

    for (const src of order) {
      try {
        const release = src === 'gitee'
          ? await getLatestReleaseFromGitee(REPO_OWNER, REPO_REPO)
          : await getLatestRelease(REPO_OWNER, REPO_REPO)
        const tag = release.tag_name.replace(/^v/i, '')
        if (compareVersions(tag, currentVersion.value) <= 0) return

        const asset = resolvePortableAsset(release)
        if (!asset) {
          errors.push(src + ': no portable exe asset')
          continue
        }

        latestVersion.value = tag
        releaseNotes.value = release.body
        updateLevel.value = parseUpdateLevel(release.body)
        downloadUrl.value = asset.browser_download_url
        expectedSha256.value = asset.sha256 || ''
        source.value = src as 'github' | 'gitee'
        dialogVisible.value = true
        return
      } catch (e: unknown) {
        errors.push(src + ': ' + (e instanceof Error ? e.message : String(e)))
      }
    }

    if (errors.length) {
      throw new Error(errors.join('; '))
    }
  }

  // ── Download portable EXE ──
  async function downloadAndApply() {
    if (!isElectron.value) {
      openReleasePage()
      return
    }
    if (downloadReady.value) {
      await applyUpdate()
      return
    }
    if (!downloadUrl.value) {
      openReleasePage()
      return
    }

    downloading.value = true
    downloadProgress.value = 0
    error.value = ''

    try {
      const result = await window.electronAPI!.updaterDownloadPortable!({
        url: downloadUrl.value,
        sha256: expectedSha256.value || undefined,
      })
      if (result?.error) {
        throw new Error(result.error)
      }
      downloadReady.value = true
      downloading.value = false
    } catch (e: unknown) {
      downloading.value = false
      error.value = e instanceof Error ? e.message : t('update.downloadFailed')
    }
  }

  // ── Apply: helper process replaces portable exe and relaunches ──
  async function applyUpdate() {
    if (!isElectron.value) return
    applying.value = true
    error.value = ''

    try {
      const result = await window.electronAPI!.updaterApplyPortable!()
      if (result?.error) {
        throw new Error(result.error)
      }
      // App is quitting; helper will replace and relaunch
    } catch (e: unknown) {
      applying.value = false
      error.value = e instanceof Error ? e.message : t('update.applyFailed')
    }
  }

  function openReleasePage() {
    if (window.electronAPI?.updaterOpenReleases) {
      window.electronAPI.updaterOpenReleases()
      return
    }
    const url = `https://github.com/${REPO_OWNER}/${REPO_REPO}/releases/latest`
    window.open(url, '_blank')
  }

  function dismiss() {
    if (updateLevel.value === 'force') return
    dialogVisible.value = false
  }

  const dialogState = computed(() => {
    if (applying.value) return 'applying'
    if (downloadReady.value) return 'ready-to-install'
    if (downloading.value) return 'downloading'
    return 'ready'
  })

  return {
    // State
    currentVersion, latestVersion, updateLevel, releaseNotes,
    checking, downloading, downloadProgress, applying, downloadReady,
    dialogVisible, error, source, upToDate, dialogState,
    // Actions
    init, checkForUpdates, downloadAndApply, applyUpdate, openReleasePage, dismiss,
  }
})
