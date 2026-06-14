import { defineStore } from 'pinia'
import { ref } from 'vue'
import { i18n } from '@/i18n'
import { compareVersions, getLatestRelease, getLatestReleaseFromGitee, parseUpdateLevel, type UpdateLevel } from '@/utils/release'

function t(key: string) { return i18n.global.t(key) }

const REPO_OWNER = 'laurensZero'
const REPO_REPO = 'paper-labeler'
const MANIFEST_BASE: Record<string, string> = {
  gitee: 'https://gitee.com/laurenszero/paper-labeler/raw/gh-pages',
  github: 'https://laurenszero.github.io/paper-labeler',
}

interface Manifest {
  version: string
  url: string
  hash?: string
  notes?: string
  updateLevel?: UpdateLevel
  publishedAt?: string
}

declare global {
  interface Window {
    electronAPI?: { restartApp?: () => void; selectFolder?: () => Promise<string | null> }
  }
}

export const useAppUpdateStore = defineStore('appUpdate', () => {
  const currentVersion = ref('')
  const latestVersion = ref('')
  const updateLevel = ref<UpdateLevel>('prompt')
  const releaseNotes = ref('')
  const downloadUrl = ref('')
  const expectedHash = ref('')
  const releasePageUrl = ref('')
  const checking = ref(false)
  const downloading = ref(false)
  const downloadProgress = ref(0)
  const dialogVisible = ref(false)
  const error = ref('')
  const source = ref<'github' | 'gitee'>('github')

  async function init() {
    try {
      const res = await fetch('/data/version')
      if (res.ok) {
        const data = await res.json()
        currentVersion.value = data.version || '0.0.0'
      }
    } catch {
      currentVersion.value = '0.0.0'
    }
  }

  async function checkForUpdates(_opts?: { source?: 'startup' | 'manual' }) {
    if (checking.value) return
    checking.value = true
    error.value = ''
    try {
      await checkHotBundle()
      await checkFullRelease()
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : t('update.checkFailed')
    } finally {
      checking.value = false
    }
  }

  async function checkHotBundle() {
    const order = source.value === 'github' ? ['github', 'gitee'] : ['gitee', 'github']
    for (const src of order) {
      const base = MANIFEST_BASE[src]
      if (!base) continue
      try {
        const url = base + '/manifest.json'
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
        if (!res.ok) continue
        const m: Manifest = await res.json()
        if (compareVersions(m.version, currentVersion.value) > 0) {
          latestVersion.value = m.version
          downloadUrl.value = base + '/' + m.url
          expectedHash.value = m.hash || ''
          releaseNotes.value = m.notes || ''
          updateLevel.value = m.updateLevel || 'prompt'
          dialogVisible.value = true
          return
        }
      } catch {
        continue
      }
    }
  }

  async function checkFullRelease() {
    if (dialogVisible.value) return
    try {
      const release = source.value === 'gitee'
        ? await getLatestReleaseFromGitee(REPO_OWNER, REPO_REPO)
        : await getLatestRelease(REPO_OWNER, REPO_REPO)
      const tag = release.tag_name.replace(/^v/i, '')
      if (compareVersions(tag, currentVersion.value) > 0) {
        latestVersion.value = tag
        releaseNotes.value = release.body
        releasePageUrl.value = release.html_url
        updateLevel.value = parseUpdateLevel(release.body)
        dialogVisible.value = true
      }
    } catch {
      // ignore
    }
  }

  async function downloadAndApply() {
    if (!downloadUrl.value) return
    downloading.value = true
    downloadProgress.value = 0
    error.value = ''

    try {
      const res = await fetch(downloadUrl.value)
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

      if (expectedHash.value) {
        const buf = await blob.arrayBuffer()
        const hashBuf = await crypto.subtle.digest('SHA-256', buf)
        const hash = Array.from(new Uint8Array(hashBuf))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')
        if (hash !== expectedHash.value.replace(/^sha256:/i, '')) {
          throw new Error(t('update.hashMismatch'))
        }
      }

      const applyRes = await fetch('/admin/apply-update', { method: 'POST', body: blob })
      if (!applyRes.ok) throw new Error(t('update.applyFailed'))

      dialogVisible.value = false
      if (window.electronAPI?.restartApp) {
        window.electronAPI.restartApp()
      } else {
        window.location.reload()
      }
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : t('update.downloadFailed')
    } finally {
      downloading.value = false
    }
  }

  function openReleasePage() {
    if (releasePageUrl.value) window.open(releasePageUrl.value, '_blank')
  }

  function dismiss() {
    if (updateLevel.value === 'force') return
    dialogVisible.value = false
  }

  return {
    currentVersion, latestVersion, updateLevel, releaseNotes,
    downloadUrl, releasePageUrl, checking, downloading, downloadProgress,
    dialogVisible, error, source,
    init, checkForUpdates, downloadAndApply, openReleasePage, dismiss,
  }
})
