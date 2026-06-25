<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useSettingsStore } from '@/stores/settings'
import { useSectionsStore } from '@/stores/sections'
import { useExportStore } from '@/stores/export'
import { useAppStore } from '@/stores/app'
import { usePapersStore } from '@/stores/papers'
import { useMarkStore } from '@/stores/mark'
import { useAnswerStore } from '@/stores/answer'
import { useFilterStore } from '@/stores/filter'
import { useAppUpdateStore } from '@/stores/appUpdate'
import { i18n } from '@/i18n'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'

const { t } = useI18n()

defineOptions({ name: 'SettingsView' })

const settingsStore = useSettingsStore()
const sectionsStore = useSectionsStore()
const exportStore = useExportStore()
const appStore = useAppStore()
const papersStore = usePapersStore()
const markStore = useMarkStore()
const answerStore = useAnswerStore()
const filterStore = useFilterStore()
const appUpdateStore = useAppUpdateStore()

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
  filterVirtualThreshold,
  filterVirtualOverscanPx,
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
  exportNameTemplate,
  exportNameTemplateError,
  exportNameCustom,
  exportNameAutoTimestamp,
  exportNameSectionStyle,
  exportCacheStats,
  exportCacheOverview,
  exportCacheHitRateText,
} = storeToRefs(exportStore)

const { filterTotal } = storeToRefs(filterStore)

const exportNamePreview = computed(() =>
  exportStore.buildRecommendedExportFileNamePreview({ idsCount: Math.max(0, Number(filterTotal.value || 0)), fromRandom: false }).name
)

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

function onFilterVirtualThresholdChange() {
  settingsStore.saveFilterVirtualThreshold(Number(filterVirtualThreshold.value))
}

function onFilterVirtualOverscanChange() {
  settingsStore.saveFilterVirtualOverscanPx(Number(filterVirtualOverscanPx.value))
}

// Export handlers
async function pickExportSaveDir() {
  await exportStore.editExportSaveDir()
}

function onCropWorkersChange() {
  exportStore.saveExportSettings()
}

function onNameTemplateBlur() {
  exportStore.saveExportSettings()
}

function onExportNameOptionChange() {
  exportStore.saveExportSettings()
}

function resetNameTemplate() {
  exportNameTemplate.value = '{mode}_{section}_{paper}_{year}_{season}_{count}'
  exportStore.saveExportSettings()
}

function clearExportSaveDir() {
  exportDefaultSaveDir.value = ''
  exportStore.saveExportSettings()
}

function clearExportCache() {
  exportStore.invalidateExportFilterCache()
  appStore.setStatus(t('settings.exportCache.cleared'), 'ok')
}

function formatAgeText(ms: number | null | undefined) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return t('settings.exportCache.noAge')
  if (n < 60_000) return t('settings.exportCache.seconds', { n: Math.round(n / 1000) })
  if (n < 3_600_000) return t('settings.exportCache.minutes', { n: Math.round(n / 60_000) })
  return t('settings.exportCache.hoursFmt', { n: (n / 3_600_000).toFixed(1) })
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

// Load persisted values on mount
onMounted(() => {
  settingsStore.loadFromStorage()
  exportStore.loadExportSettings()
  exportStore.refreshExportCacheOverview()
  appUpdateStore.init()
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

      <!-- 更新信息面板 -->
      <div v-if="appUpdateStore.dialogVisible" style="margin-top: 12px; padding: 12px; border-radius: 10px; background: var(--bg-pressed); border: 1px solid var(--border)">
        <div style="display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-primary); font-weight: 600">
          <span>{{ t('update.newVersion') }}</span>
          <span style="font-size: 12px; color: var(--accent); font-weight: 500">v{{ appUpdateStore.latestVersion }}</span>
        </div>
        <div v-if="appUpdateStore.releaseNotes" style="margin-top: 8px; font-size: 12px; color: var(--text-secondary); line-height: 1.6; white-space: pre-wrap">{{ appUpdateStore.releaseNotes }}</div>
        <div v-if="appUpdateStore.downloading" style="margin-top: 8px">
          <div style="height: 4px; border-radius: 2px; background: var(--bg-elevated); overflow: hidden">
            <div :style="{ width: appUpdateStore.downloadProgress + '%', height: '100%', borderRadius: '2px', background: 'var(--accent)', transition: 'width 0.2s' }"></div>
          </div>
          <div style="margin-top: 4px; font-size: 12px; color: var(--text-tertiary)">{{ appUpdateStore.downloadProgress }}%</div>
        </div>
        <div v-if="appUpdateStore.updateLevel === 'force'" style="margin-top: 6px; font-size: 12px; color: var(--danger)">{{ t('update.forceHint') }}</div>
        <div style="margin-top: 10px; display: flex; gap: 8px; justify-content: flex-end">
          <button v-if="appUpdateStore.updateLevel !== 'force'" class="btn btn-ghost btn-sm" :disabled="appUpdateStore.downloading" @click="appUpdateStore.dismiss()">
            {{ t('update.dismiss') }}
          </button>
          <button v-if="appUpdateStore.downloadUrl" class="btn btn-primary btn-sm" :disabled="appUpdateStore.downloading" @click="appUpdateStore.downloadAndApply()">
            {{ appUpdateStore.downloading ? t('update.downloading') : t('update.downloadAndApply') }}
          </button>
          <button v-else-if="appUpdateStore.releasePageUrl" class="btn btn-primary btn-sm" @click="appUpdateStore.openReleasePage()">
            {{ t('update.openReleasePage') }}
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
