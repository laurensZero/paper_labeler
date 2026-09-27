<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useSettingsStore } from '@/stores/settings'
import { useSectionsStore } from '@/stores/sections'
import { useExportStore } from '@/stores/export'
import { useAppStore } from '@/stores/app'
import { usePapersStore } from '@/stores/papers'
import { useMarkStore } from '@/stores/mark'
import { useAnswerStore } from '@/stores/answer'
import { useAppUpdateStore } from '@/stores/appUpdate'
import { i18n } from '@/i18n'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import { cloudApi } from '@/api/endpoints'
import { CLOUD_ADMIN_ENABLED } from '@/features'
import { ApiError } from '@/api/client'
import type { CloudConfigInfo, CloudSyncSummary } from '@/types'

const { t } = useI18n()

defineOptions({ name: 'SettingsView' })

const settingsStore = useSettingsStore()
const sectionsStore = useSectionsStore()
const exportStore = useExportStore()
const appStore = useAppStore()
const papersStore = usePapersStore()
const markStore = useMarkStore()
const answerStore = useAnswerStore()
const appUpdateStore = useAppUpdateStore()

const shortcutStatus = ref<{ desktop: boolean; startMenu: boolean; canCreate: boolean } | null>(null)
const shortcutBusy = ref(false)
const shortcutMsg = ref('')

async function refreshShortcutStatus() {
  if (!window.electronAPI?.shortcutStatus) {
    shortcutStatus.value = null
    return
  }
  try {
    shortcutStatus.value = await window.electronAPI.shortcutStatus()
  } catch {
    shortcutStatus.value = null
  }
}

async function onCreateShortcuts() {
  if (!window.electronAPI?.shortcutCreate) return
  shortcutBusy.value = true
  shortcutMsg.value = ''
  try {
    const res = await window.electronAPI.shortcutCreate()
    if (res?.error) {
      shortcutMsg.value = res.error
    } else {
      shortcutMsg.value = t('settings.shortcuts.created')
      await refreshShortcutStatus()
    }
  } catch (e) {
    shortcutMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    shortcutBusy.value = false
  }
}

const importing = ref(false)
const importResult = ref<{ ok: boolean; imported?: string[]; error?: string } | null>(null)

async function onImportData() {
  importResult.value = null
  let folderPath: string | null = null

  if (window.electronAPI?.selectFolder) {
    folderPath = await window.electronAPI.selectFolder()
  } else {
    // Fallback for non-Electron: prompt for path
    folderPath = prompt(t('settings.importData.enterPath'))
  }
  if (!folderPath) return

  importing.value = true
  try {
    const res = await fetch('/admin/import-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folderPath }),
    })
    const data = await res.json()
    if (res.ok) {
      importResult.value = { ok: true, imported: data.imported }
    } else {
      importResult.value = { ok: false, error: data.error || '导入失败' }
    }
  } catch (e: unknown) {
    importResult.value = { ok: false, error: e instanceof Error ? e.message : '导入失败' }
  } finally {
    importing.value = false
  }
}

// Alignment / OCR — use storeToRefs so v-model binds reactively
const {
  alignLeftEnabled,
  alignPaperFirstEnabled,
  answerAlignEnabled,
  ocrAutoEnabled,
  ocrMinHeightPx,
  ocrYPaddingPx,
  maintenanceBusy,
  maintenanceRemoveOrphanBoxes,
  maintenanceFillMissingQuestionNo,
  maintenanceRenumberQuestionNo,
  maintenanceIntegrityReport,
  maintenanceRepairReport,
  darkImageInvert,
  filmStripSectionDots,
} = storeToRefs(settingsStore)

// Export settings
const {
  exportDefaultSaveDir,
  exportCropWorkers,
} = storeToRefs(exportStore)

// Settings snapshot export / import + cloud token
const settingsSnapshotResult = ref('')
const cloudTokenInput = ref('')

function onExportSettings() {
  try {
    const snapshot = settingsStore.exportSettingsSnapshot()
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `paper-labeler-settings-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    settingsSnapshotResult.value = t('settings.snapshot.exportOk', { count: Object.keys(snapshot).length })
  } catch (e) {
    settingsSnapshotResult.value = t('settings.snapshot.exportFail', { error: String(e) })
  }
}

function onImportSettingsFile(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result || '{}'))
      const keys = settingsStore.importSettingsSnapshot(data)
      settingsSnapshotResult.value = t('settings.snapshot.importOk', { count: keys.length })
    } catch (e) {
      settingsSnapshotResult.value = t('settings.snapshot.importFail', { error: String(e) })
    }
  }
  reader.readAsText(file)
}

function onSaveCloudToken() {
  settingsStore.saveCloudToken(cloudTokenInput.value)
  settingsSnapshotResult.value = t('settings.snapshot.tokenSaved')
}

// Toggle handlers — call store actions to persist + enforce mutual exclusion
function onToggleAlignLeft() {
  const enabled = settingsStore.saveAlignLeft(!alignLeftEnabled.value)
  appStore.setStatus(enabled ? t('settings.alignment.multiBoxOn') : t('settings.alignment.multiBoxOff'), 'ok')
}

async function onToggleAlignPaperFirst() {
  const enabled = settingsStore.saveAlignPaperFirst(!alignPaperFirstEnabled.value)
  if (enabled && papersStore.currentPaperId != null) {
    await markStore.ensurePaperAlignRefFromFirstQuestion(papersStore.currentPaperId)
  }
  appStore.setStatus(enabled ? t('settings.alignment.paperFirstOn') : t('settings.alignment.paperFirstOff'), 'ok')
}

async function onToggleAnswerAlign() {
  const enabled = settingsStore.saveAnswerAlign(!answerAlignEnabled.value)
  if (enabled) {
    await answerStore.ensureAnswerAlignRefFromFirstQuestion()
  }
  appStore.setStatus(enabled ? t('settings.alignment.answerOn') : t('settings.alignment.answerOff'), 'ok')
}

function onToggleOcrAuto() {
  settingsStore.saveOcrAuto(!ocrAutoEnabled.value)
}

function onToggleFilmStripDots() {
  const next = !filmStripSectionDots.value
  settingsStore.saveFilmStripSectionDots(next)
  if (next) {
    // First time enabling: auto-assign colors to sections without one
    const alreadyDone = localStorage.getItem('setting:filmStripDotsAutoAssigned')
    if (!alreadyDone) {
      const PALETTE = [
        '#ef4444', '#f97316', '#f59e0b', '#eab308',
        '#84cc16', '#22c55e', '#10b981', '#14b8a6',
        '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
        '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
      ]
      const usedColors = new Set(sectionsStore.sectionDefs.map(s => s.color).filter(Boolean))
      const shuffled = [...PALETTE].sort(() => Math.random() - 0.5)
      let ci = 0
      for (const s of sectionsStore.sectionDefs) {
        if (s.color) continue
        for (let i = 0; i < shuffled.length; i++) {
          const idx = (ci + i) % shuffled.length
          if (!usedColors.has(shuffled[idx])) {
            s.color = shuffled[idx]
            usedColors.add(s.color)
            ci = idx + 1
            break
          }
        }
        if (!s.color) {
          s.color = shuffled[ci % shuffled.length]
          ci++
        }
        sectionsStore.updateSectionDef(s)
      }
      localStorage.setItem('setting:filmStripDotsAutoAssigned', '1')
    }
  }
}

const currentLocale = computed(() => i18n.global.locale.value)

function onLocaleChange(locale: string) {
  ;(i18n.global.locale as { value: string }).value = locale
  localStorage.setItem('setting:locale', locale)
}

function onOcrMinHeightChange() {
  settingsStore.saveOcrMinHeight(Number(ocrMinHeightPx.value))
}

function onOcrYPaddingChange() {
  settingsStore.saveOcrYPadding(Number(ocrYPaddingPx.value))
}


// Export handlers
async function pickExportSaveDir() {
  await exportStore.editExportSaveDir()
}

function onCropWorkersChange() {
  exportStore.saveExportSettings()
}

function clearExportSaveDir() {
  exportDefaultSaveDir.value = ''
  exportStore.saveExportSettings()
}


// Maintenance
function runIntegrityCheck() {
  settingsStore.runIntegrityCheck()
}

function runRepairDry() {
  settingsStore.runRepair(false)
}

function runRepairApply() {
  settingsStore.runRepair(true)
}

// ── 云端同步 ──────────────────────────────────────────────
const cloudConfig = ref<CloudConfigInfo | null>(null)
const cloudRunning = ref(false)
const cloudCurrent = ref<CloudSyncSummary | null>(null)
const cloudLast = ref<CloudSyncSummary | null>(null)
const cloudStarting = ref(false)
const cloudStartError = ref('')
let cloudPollTimer: number | null = null

const cloudReady = computed(
  () => !!cloudConfig.value && cloudConfig.value.enabled && cloudConfig.value.missing.length === 0,
)
const cloudPhase = computed(() => cloudCurrent.value?.phase ?? '')
const cloudActiveSummary = computed(() => cloudCurrent.value ?? cloudLast.value)

function cloudPhaseLabel(phase: string): string {
  if (!phase) return ''
  const key = `settings.cloud.phase.${phase}`
  const label = t(key)
  return label === key ? phase : label
}

function cloudCountLabel(key: string): string {
  const k = `settings.cloud.counts.${key}`
  const label = t(k)
  return label === k ? key : label
}

function apiErrDetail(e: unknown): string {
  if (e instanceof ApiError) {
    try {
      const body = JSON.parse(e.body)
      if (body?.detail) return String(body.detail)
    } catch {
      /* fallthrough */
    }
    return e.body || e.message
  }
  return e instanceof Error ? e.message : String(e)
}

function stopCloudPoll() {
  if (cloudPollTimer != null) {
    clearInterval(cloudPollTimer)
    cloudPollTimer = null
  }
}

async function pollCloudStatus() {
  try {
    const s = await cloudApi.syncStatus()
    cloudRunning.value = s.running
    cloudCurrent.value = s.current
    if (s.last) cloudLast.value = s.last
    if (!s.running) stopCloudPoll()
  } catch {
    stopCloudPoll()
  }
}

async function startCloudSync() {
  cloudStartError.value = ''
  cloudStarting.value = true
  try {
    await cloudApi.startSync()
    cloudRunning.value = true
    stopCloudPoll()
    cloudPollTimer = window.setInterval(pollCloudStatus, 1500)
    void pollCloudStatus()
  } catch (e) {
    cloudStartError.value = apiErrDetail(e)
  } finally {
    cloudStarting.value = false
  }
}

async function loadCloudInfo() {
  try {
    cloudConfig.value = await cloudApi.config()
  } catch {
    cloudConfig.value = null
  }
  void pollCloudStatus()
}

// Load persisted values on mount
onMounted(() => {
  settingsStore.loadFromStorage()
  settingsStore.loadCloudToken()
  if (CLOUD_ADMIN_ENABLED) cloudTokenInput.value = settingsStore.cloudToken
  exportStore.loadExportSettings()
  exportStore.refreshExportCacheOverview()
  appUpdateStore.init()
  void refreshShortcutStatus()
  if (CLOUD_ADMIN_ENABLED) void loadCloudInfo()
})

onUnmounted(() => {
  stopCloudPoll()
})
</script>

<template>
  <div style="max-width: 680px">
    <h2 style="font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 24px">{{ t('settings.title') }}</h2>

    <!-- 外观 -->
    <div class="card">
      <div class="card-title">{{ t('settings.appearance.title') }}</div>
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 0">
        <div>
          <div style="font-weight: 500; font-size: 14px">{{ t('settings.appearance.language') }}</div>
        </div>
        <select
          :value="currentLocale"
          class="settings-select"
          @change="onLocaleChange(($event.target as HTMLSelectElement).value)"
        >
          <option value="zh-CN">{{ t('settings.appearance.langZhCN') }}</option>
          <option value="en">{{ t('settings.appearance.langEn') }}</option>
        </select>
      </div>
      <div class="divider" style="margin: 0"></div>
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 0">
        <div>
          <div style="font-weight: 500; font-size: 14px">{{ t('settings.appearance.darkImageInvert') }}</div>
          <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">{{ t('settings.appearance.darkImageInvertDesc') }}</div>
        </div>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="darkImageInvert"
            @change="settingsStore.saveDarkImageInvert(($event.target as HTMLInputElement).checked)"
          />
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
      </div>
      <div class="divider" style="margin: 0"></div>
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 0">
        <div>
          <div style="font-weight: 500; font-size: 14px">{{ t('settings.appearance.filmStripDots') }}</div>
          <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">{{ t('settings.appearance.filmStripDotsDesc') }}</div>
        </div>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="filmStripSectionDots"
            @change="onToggleFilmStripDots"
          />
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
      </div>
    </div>

    <!-- 标注对齐 -->
    <div class="card">
      <div class="card-title">{{ t('settings.alignment.title') }}</div>
      <div style="display: flex; flex-direction: column; gap: 0">
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 0">
          <div>
            <div style="font-weight: 500; font-size: 14px">{{ t('settings.alignment.multiBox') }}</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">{{ t('settings.alignment.multiBoxDesc') }}</div>
          </div>
          <label class="toggle">
            <input type="checkbox" :checked="alignLeftEnabled" @change="onToggleAlignLeft" />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </label>
        </div>
        <div class="divider" style="margin: 0"></div>
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 0">
          <div>
            <div style="font-weight: 500; font-size: 14px">{{ t('settings.alignment.paperFirst') }}</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">{{ t('settings.alignment.paperFirstDesc') }}</div>
          </div>
          <label class="toggle">
            <input type="checkbox" :checked="alignPaperFirstEnabled" @change="onToggleAlignPaperFirst" />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </label>
        </div>
        <div class="divider" style="margin: 0"></div>
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 0">
          <div>
            <div style="font-weight: 500; font-size: 14px">{{ t('settings.alignment.answer') }}</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">{{ t('settings.alignment.answerDesc') }}</div>
          </div>
          <label class="toggle">
            <input type="checkbox" :checked="answerAlignEnabled" @change="onToggleAnswerAlign" />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </label>
        </div>
      </div>
    </div>

    <!-- OCR -->
    <div class="card">
      <div class="card-title">{{ t('settings.ocr.title') }}</div>
      <div style="display: flex; flex-direction: column; gap: 0">
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 0">
          <div>
            <div style="font-weight: 500; font-size: 14px">{{ t('settings.ocr.auto') }}</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">{{ t('settings.ocr.autoDesc') }}</div>
          </div>
          <label class="toggle">
            <input type="checkbox" :checked="ocrAutoEnabled" @change="onToggleOcrAuto" />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </label>
        </div>
        <div class="divider" style="margin: 0"></div>
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 0">
          <div>
            <div style="font-weight: 500; font-size: 14px">{{ t('settings.ocr.minHeight') }}</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">{{ t('settings.ocr.minHeightDesc') }}</div>
          </div>
          <input
            v-model.number="ocrMinHeightPx"
            type="number"
            min="0"
            max="2000"
            step="1"
            class="settings-number-input"
            @change="onOcrMinHeightChange"
          />
        </div>
        <div class="divider" style="margin: 0"></div>
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 0">
          <div>
            <div style="font-weight: 500; font-size: 14px">{{ t('settings.ocr.padding') }}</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">{{ t('settings.ocr.paddingDesc') }}</div>
          </div>
          <input
            v-model.number="ocrYPaddingPx"
            type="number"
            min="0"
            max="500"
            step="1"
            class="settings-number-input"
            @change="onOcrYPaddingChange"
          />
        </div>
      </div>
    </div>

    <!-- 导出设置 -->
    <div class="card">
      <div class="card-title">{{ t('settings.export.title') }}</div>
      <div style="display: flex; flex-direction: column; gap: 0">
        <!-- 默认另存目录 -->
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 0">
          <div>
            <div style="font-weight: 500; font-size: 14px">{{ t('settings.export.saveDir') }}</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">{{ t('settings.export.saveDirDesc') }}</div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px">
            <div
              style="max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--text-secondary); padding: 6px 12px; background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm)"
              v-tooltip="exportDefaultSaveDir || t('settings.export.saveDirPlaceholder')"
            >
              {{ exportDefaultSaveDir || t('settings.export.saveDirPlaceholder') }}
            </div>
            <button class="btn" style="font-size: 12px; padding: 5px 12px" @click="pickExportSaveDir">{{ t('settings.export.pickDir') }}</button>
            <button class="btn" style="font-size: 12px; padding: 5px 12px" @click="clearExportSaveDir">{{ t('settings.export.clearDir') }}</button>
          </div>
        </div>

        <div class="divider" style="margin: 0"></div>

        <!-- 并发裁剪 -->
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 0">
          <div>
            <div style="font-weight: 500; font-size: 14px">{{ t('settings.export.cropWorkers') }}</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">{{ t('settings.export.cropWorkersDesc') }}</div>
          </div>
          <div style="display: flex; align-items: center; gap: 10px">
            <input
              v-model.number="exportCropWorkers"
              type="number"
              min="0"
              max="32"
              step="1"
              style="width: 80px; padding: 6px 10px; background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; color: var(--text-primary); font-family: inherit; outline: none"
              @change="onCropWorkersChange"
            />
            <span style="font-size: 12px; color: var(--text-tertiary)">{{ t('settings.export.autoLabel') }}</span>
          </div>
        </div>

      </div>
    </div>

    <!-- 设置快照 -->
    <div class="card">
      <div class="card-title">{{ t('settings.snapshot.title') }}</div>
      <div style="font-size: 13px; color: var(--text-secondary); line-height: 1.5">
        {{ t('settings.snapshot.desc') }}
      </div>
      <div style="display: flex; align-items: center; gap: 10px; margin-top: 12px">
        <button class="btn" @click="onExportSettings">{{ t('settings.snapshot.export') }}</button>
        <label class="btn" style="cursor: pointer">
          {{ t('settings.snapshot.import') }}
          <input type="file" accept="application/json,.json" style="display: none" @change="onImportSettingsFile" />
        </label>
      </div>
      <div v-if="settingsSnapshotResult" style="margin-top: 8px; font-size: 13px; color: var(--text-secondary)">
        {{ settingsSnapshotResult }}
      </div>
    </div>

    <!-- 云端同步 -->
    <template v-if="CLOUD_ADMIN_ENABLED">    <div class="card">
      <div class="card-title">{{ t('settings.cloud.title') }}</div>
      <div style="font-size: 13px; color: var(--text-secondary); line-height: 1.5">
        {{ t('settings.cloud.desc') }}
      </div>

      <div style="display: flex; align-items: center; gap: 10px; margin-top: 12px">
        <span style="font-size: 13px; color: var(--text-secondary); white-space: nowrap">{{ t('settings.cloud.tokenLabel') }}</span>
        <input
          v-model="cloudTokenInput"
          type="password"
          :placeholder="t('settings.cloud.tokenPlaceholder')"
          style="flex: 1; min-width: 180px; padding: 6px 10px; background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; color: var(--text-primary); font-family: inherit; outline: none"
        />
        <button class="btn" @click="onSaveCloudToken">{{ t('settings.cloud.tokenSave') }}</button>
      </div>

      <div style="font-size: 13px; padding-top: 10px; color: var(--text-secondary)">
        <span v-if="!cloudConfig">…</span>
        <span v-else-if="!cloudConfig.enabled" style="color: var(--warning)">{{ t('settings.cloud.disabled') }}</span>
        <span v-else-if="cloudConfig.missing.length" style="color: var(--danger)">{{ t('settings.cloud.missing', { items: cloudConfig.missing.join(', ') }) }}</span>
        <span v-else>{{ t('settings.cloud.ready', { url: cloudConfig.supabase_url, bucket: cloudConfig.r2_bucket }) }}</span>
      </div>

      <div style="display: flex; align-items: center; gap: 10px; margin-top: 12px">
        <button
          class="btn btn-primary"
          :disabled="!cloudReady || cloudRunning || cloudStarting"
          @click="startCloudSync"
        >
          {{ cloudRunning || cloudStarting ? t('settings.cloud.syncing') : t('settings.cloud.sync') }}
        </button>
        <span v-if="cloudRunning && cloudPhase" style="font-size: 13px; color: var(--text-secondary)">
          {{ cloudPhaseLabel(cloudPhase) }}
        </span>
      </div>

      <div v-if="cloudStartError" style="margin-top: 8px; font-size: 13px; color: var(--danger)">
        {{ t('settings.cloud.startFailed', { error: cloudStartError }) }}
      </div>

      <div v-if="cloudActiveSummary" style="margin-top: 12px; font-size: 13px; color: var(--text-secondary); line-height: 1.6">
        <span v-if="!cloudRunning" :style="{ color: cloudActiveSummary.ok ? '#22c55e' : '#ef4444' }">
          {{ cloudActiveSummary.ok
            ? t('settings.cloud.lastOk', { seconds: cloudActiveSummary.duration_s })
            : t('settings.cloud.lastFail', { errors: cloudActiveSummary.error_count, seconds: cloudActiveSummary.duration_s }) }}
        </span>
        <div v-if="cloudActiveSummary.resurrected.length" style="color: var(--warning)">
          {{ t('settings.cloud.resurrected', { count: cloudActiveSummary.resurrected.length }) }}
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px">
          <span
            v-for="(v, k) in cloudActiveSummary.counts"
            v-show="Number(v) > 0"
            :key="k"
            style="font-size: 12px; padding: 2px 8px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 999px; color: var(--text-secondary)"
          >
            {{ cloudCountLabel(String(k)) }} {{ v }}
          </span>
        </div>
        <div v-if="cloudActiveSummary.errors.length" style="margin-top: 6px; color: var(--danger); font-size: 12px">
          {{ t('settings.cloud.errorsLabel') }}: {{ cloudActiveSummary.errors.slice(0, 3).join('；') }}<span v-if="cloudActiveSummary.error_count > 3"> …(+{{ cloudActiveSummary.error_count - 3 }})</span>
        </div>
      </div>
      <div v-else style="margin-top: 10px; font-size: 13px; color: var(--text-tertiary)">
        {{ t('settings.cloud.never') }}
      </div>
    </div>
    </template>

    <!-- 数据维护 -->
    <div class="card">
      <div class="card-title">{{ t('settings.maintenance.title') }}</div>
      <div style="display: flex; flex-direction: column; gap: 0">
        <!-- 检查与修复选项 -->
        <div style="padding: 14px 0; display: flex; flex-direction: column; gap: 10px">
          <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary)">
            <AppCheckbox v-model="maintenanceRemoveOrphanBoxes" />
            {{ t('settings.maintenance.orphanBoxes') }}
          </div>
          <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary)">
            <AppCheckbox v-model="maintenanceFillMissingQuestionNo" />
            {{ t('settings.maintenance.fillQuestionNo') }}
          </div>
          <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary)">
            <AppCheckbox v-model="maintenanceRenumberQuestionNo" />
            {{ t('settings.maintenance.renumberQuestionNo') }}
          </div>
        </div>

        <div style="display: flex; gap: 10px">
          <button class="btn" :disabled="maintenanceBusy" @click="runIntegrityCheck">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            {{ t('settings.maintenance.integrity') }}
          </button>
          <button class="btn" :disabled="maintenanceBusy" @click="runRepairDry">
            {{ t('settings.maintenance.dryRun') }}
          </button>
          <button class="btn" :disabled="maintenanceBusy" style="color: var(--warning); border-color: rgba(255, 159, 10, 0.3)" @click="runRepairApply">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
            {{ t('settings.maintenance.execute') }}
          </button>
        </div>

        <!-- 完整性检查结果 -->
        <div v-if="maintenanceIntegrityReport" style="margin-top: 14px; font-size: 13px; color: var(--text-secondary); line-height: 1.6; padding: 12px; background: var(--bg-input); border-radius: var(--radius-sm)">
          <div>{{ t('settings.maintenance.totalQuestions') }} {{ maintenanceIntegrityReport.total_questions || 0 }}，{{ t('settings.maintenance.missingQuestionNo') }} {{ maintenanceIntegrityReport.missing_question_no || 0 }}，{{ t('settings.maintenance.questionNoGaps') }} {{ maintenanceIntegrityReport.question_no_gap_count || 0 }}</div>
          <div>{{ t('settings.maintenance.duplicateGroups') }} {{ maintenanceIntegrityReport.duplicate_question_no_groups || 0 }}，{{ t('settings.maintenance.orphanQuestionBoxes') }} {{ maintenanceIntegrityReport.orphan_question_boxes || 0 }}，{{ t('settings.maintenance.orphanAnswerBoxes') }} {{ maintenanceIntegrityReport.orphan_answer_boxes || 0 }}，{{ t('settings.maintenance.orphanSections') }} {{ maintenanceIntegrityReport.orphan_question_sections || 0 }}</div>
          <div v-if="maintenanceIntegrityReport.question_no_gap_examples?.length" style="margin-top: 4px">
            {{ t('settings.maintenance.gapExamples') }}{{ maintenanceIntegrityReport.question_no_gap_examples.join(', ') }}
          </div>
        </div>

        <!-- 修复结果 -->
        <div v-if="maintenanceRepairReport" style="margin-top: 8px; font-size: 13px; color: var(--text-secondary); line-height: 1.6; padding: 12px; background: var(--bg-input); border-radius: var(--radius-sm)">
          {{ t('settings.maintenance.last') }}{{ maintenanceRepairReport.dry_run ? t('settings.maintenance.dryRunLabel') : t('settings.maintenance.repairLabel') }}：
          {{ t('settings.maintenance.cleanQuestionBoxes') }} {{ maintenanceRepairReport.orphan_question_boxes_removed || 0 }}，
          {{ t('settings.maintenance.cleanAnswerBoxes') }} {{ maintenanceRepairReport.orphan_answer_boxes_removed || 0 }}，
          {{ t('settings.maintenance.cleanSections') }} {{ maintenanceRepairReport.orphan_question_sections_removed || 0 }}，
          {{ t('settings.maintenance.fillQuestionNoLabel') }} {{ maintenanceRepairReport.missing_question_no_filled || 0 }}，
          {{ t('settings.maintenance.renumberLabel') }} {{ maintenanceRepairReport.question_no_resequenced_changed || 0 }}
        </div>

      </div>
    </div>

    <!-- 导入旧数据 -->
    <div class="card">
      <div class="card-title">{{ t('settings.importData.title') }}</div>
      <p style="font-size: 13px; color: var(--text-tertiary); margin-bottom: 12px">{{ t('settings.importData.hint') }}</p>
      <div style="display: flex; align-items: center; gap: 12px">
        <button class="btn btn-ghost" :disabled="importing" @click="onImportData">
          {{ importing ? t('settings.importData.importing') : t('settings.importData.selectFolder') }}
        </button>
        <span v-if="importResult" :style="{ fontSize: '13px', color: importResult.ok ? '#22c55e' : '#ef4444' }">
          {{ importResult.ok ? t('settings.importData.success', { items: (importResult.imported ?? []).join(', ') }) : importResult.error }}
        </span>
      </div>
    </div>

    <!-- 关于 -->
    <div class="card">
      <div class="card-title">{{ t('settings.about.title') }}</div>
      <div style="font-size: 14px; color: var(--text-secondary); line-height: 1.6">
        {{ t('settings.about.version') }}<br/>
        <span style="font-size: 13px; color: var(--text-tertiary)">{{ t('settings.about.description') }}</span>
      </div>
      <div style="margin-top: 12px; display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--text-secondary)">
        <span>{{ t('update.currentVersion') }}: {{ appUpdateStore.currentVersion || '...' }}</span>
        <button class="btn btn-ghost btn-sm" :disabled="appUpdateStore.checking" @click="appUpdateStore.checkForUpdates({ source: 'manual' })">
          {{ appUpdateStore.checking ? t('update.checking') : (appUpdateStore.upToDate ? t('update.upToDate') : t('update.checkForUpdates')) }}
        </button>
        <span v-if="appUpdateStore.upToDate && !appUpdateStore.dialogVisible" style="font-size: 12px; color: #22c55e">✓</span>
      </div>
      <div v-if="appUpdateStore.error" style="margin-top: 6px; font-size: 12px; color: #ef4444">
        {{ appUpdateStore.error }}
      </div>

      <!-- Desktop / Start Menu shortcuts (portable) -->
      <div v-if="shortcutStatus?.canCreate" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--text-secondary)">
        <span>{{ t('settings.shortcuts.label') }}</span>
        <button class="btn btn-ghost btn-sm" :disabled="shortcutBusy" @click="onCreateShortcuts">
          {{ shortcutBusy ? t('settings.shortcuts.creating') : t('settings.shortcuts.create') }}
        </button>
        <span v-if="shortcutStatus.desktop || shortcutStatus.startMenu" style="font-size: 12px; color: #22c55e">
          {{ shortcutStatus.desktop ? t('settings.shortcuts.hasDesktop') : '' }}
          <template v-if="shortcutStatus.desktop && shortcutStatus.startMenu"> · </template>
          {{ shortcutStatus.startMenu ? t('settings.shortcuts.hasStartMenu') : '' }}
        </span>
        <span v-if="shortcutMsg" style="font-size: 12px; color: var(--text-tertiary)">{{ shortcutMsg }}</span>
      </div>

      <!-- 更新信息面板 -->
      <div v-if="appUpdateStore.dialogVisible" style="margin-top: 12px; padding: 12px; border-radius: 10px; background: var(--bg-pressed); border: 1px solid var(--border)">
        <div style="display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-primary); font-weight: 600">
          <span>{{ appUpdateStore.downloadReady ? t('update.readyToInstall') : t('update.newVersion') }}</span>
          <span style="font-size: 12px; color: var(--accent); font-weight: 500">v{{ appUpdateStore.latestVersion }}</span>

        </div>
        <div v-if="appUpdateStore.releaseNotes" style="margin-top: 8px; font-size: 12px; color: var(--text-secondary); line-height: 1.6; white-space: pre-wrap">{{ appUpdateStore.releaseNotes }}</div>
        <div v-if="appUpdateStore.downloading" style="margin-top: 8px">
          <div style="height: 4px; border-radius: 2px; background: var(--bg-elevated); overflow: hidden">
            <div :style="{ width: appUpdateStore.downloadProgress + '%', height: '100%', borderRadius: '2px', background: 'var(--accent)', transition: 'width 0.2s' }"></div>
          </div>
          <div style="margin-top: 4px; font-size: 12px; color: var(--text-tertiary)">{{ appUpdateStore.downloadProgress }}%</div>
        </div>
        <div v-if="appUpdateStore.downloadReady" style="margin-top: 6px; font-size: 12px; color: #22c55e">
          {{ t('update.downloadedHint') }}
        </div>
        <div v-if="appUpdateStore.updateLevel === 'force'" style="margin-top: 6px; font-size: 12px; color: var(--danger)">{{ t('update.forceHint') }}</div>
        <div style="margin-top: 10px; display: flex; gap: 8px; justify-content: flex-end">
          <button v-if="appUpdateStore.updateLevel !== 'force'" class="btn btn-ghost btn-sm" :disabled="appUpdateStore.downloading" @click="appUpdateStore.dismiss()">
            {{ t('update.dismiss') }}
          </button>
          <!-- Downloaded portable package: replace and relaunch -->
          <button v-if="appUpdateStore.downloadReady" class="btn btn-primary btn-sm" :disabled="appUpdateStore.applying" @click="appUpdateStore.applyUpdate()">
            {{ appUpdateStore.applying ? t('update.applying') : t('update.restartToInstall') }}
          </button>
          <!-- Download portable EXE or apply downloaded package -->
          <button v-else class="btn btn-primary btn-sm" :disabled="appUpdateStore.downloading" @click="appUpdateStore.downloadAndApply()">
            {{ appUpdateStore.downloading ? t('update.downloading') : t('update.downloadAndApply') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.toggle {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  cursor: pointer;
}

.toggle input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-track {
  width: 40px;
  height: 22px;
  background: var(--bg-pressed);
  border-radius: 11px;
  transition: background var(--duration-fast) var(--ease-out);
  position: relative;
  border: 1px solid var(--border);
}

.toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: white;
  border-radius: 50%;
  box-shadow: var(--shadow-xs);
  transition: transform var(--duration-fast) var(--ease-spring);
}

.toggle input:checked + .toggle-track {
  background: var(--accent);
  border-color: var(--accent);
}

.toggle input:checked + .toggle-track .toggle-thumb {
  transform: translateX(18px);
}

.toggle input:focus-visible + .toggle-track {
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.settings-number-input {
  width: 80px;
  padding: 5px 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-primary);
  font-family: inherit;
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out);
}

.settings-number-input--wide {
  width: 100px;
}

.settings-text-input,
.settings-select {
  min-height: 30px;
  padding: 5px 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-primary);
  font-family: inherit;
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out);
}

.settings-text-input {
  flex: 1 1 160px;
  min-width: 160px;
}

.settings-select {
  min-width: 150px;
}

.settings-number-input:focus,
.settings-text-input:focus,
.settings-select:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
</style>
