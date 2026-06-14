<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useSettingsStore } from '@/stores/settings'
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
const exportStore = useExportStore()
const appStore = useAppStore()
const papersStore = usePapersStore()
const markStore = useMarkStore()
const answerStore = useAnswerStore()
const filterStore = useFilterStore()
const appUpdateStore = useAppUpdateStore()

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
  webpConvertReport,
  webpConvertProgress,
  darkImageInvert,
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

const currentLocale = computed(() => i18n.global.locale.value)

function onLocaleChange(locale: string) {
  ;(i18n.global.locale as any).value = locale
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

    <!-- 列表性能 -->
    <div class="card">
      <div class="card-title">{{ t('settings.performance.title') }}</div>
      <div style="display: flex; flex-direction: column; gap: 0">
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 0; gap: 20px">
          <div>
            <div style="font-weight: 500; font-size: 14px">{{ t('settings.performance.virtualize') }}</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">{{ t('settings.performance.virtualizeDesc') }}</div>
          </div>
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end">
            <label style="font-size: 12px; color: var(--text-tertiary)">{{ t('settings.performance.threshold') }}</label>
            <input
              v-model.number="filterVirtualThreshold"
              type="number"
              min="1"
              max="200"
              step="1"
              class="settings-number-input"
              @change="onFilterVirtualThresholdChange"
            />
            <label style="font-size: 12px; color: var(--text-tertiary)">Overscan</label>
            <input
              v-model.number="filterVirtualOverscanPx"
              type="number"
              min="0"
              max="5000"
              step="50"
              class="settings-number-input settings-number-input--wide"
              @change="onFilterVirtualOverscanChange"
            />
          </div>
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
              :title="exportDefaultSaveDir || t('settings.export.saveDirPlaceholder')"
            >
              {{ exportDefaultSaveDir || t('settings.export.saveDirPlaceholder') }}
            </div>
            <button class="btn" style="font-size: 12px; padding: 5px 12px" @click="pickExportSaveDir">{{ t('settings.export.pickDir') }}</button>
            <button class="btn" style="font-size: 12px; padding: 5px 12px" @click="clearExportSaveDir">{{ t('settings.export.clearDir') }}</button>
          </div>
        </div>

        <div class="divider" style="margin: 0"></div>

        <!-- 导出缓存 -->
        <div style="display: flex; justify-content: space-between; align-items: flex-start; padding: 14px 0; gap: 20px">
          <div>
            <div style="font-weight: 500; font-size: 14px">{{ t('settings.exportCache.title') }}</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">{{ t('settings.exportCache.desc') }}</div>
            <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 6px; line-height: 1.6">
              {{ t('settings.exportCache.current') }} {{ exportCacheOverview.entryCount || 0 }} {{ t('settings.exportCache.groups') }}
              {{ t('settings.exportCache.latest') }} {{ formatAgeText(exportCacheOverview.newestAgeMs) }}；
              {{ t('settings.exportCache.oldest') }} {{ formatAgeText(exportCacheOverview.oldestAgeMs) }}；
              {{ t('settings.exportCache.hitRate') }} {{ exportCacheHitRateText }}
            </div>
            <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 4px; line-height: 1.6">
              {{ t('settings.exportCache.expired') }} {{ exportCacheStats.expired || 0 }}{{ t('settings.exportCache.times') }} {{ exportCacheStats.write || 0 }}{{ t('settings.exportCache.validity') }} {{ Math.round((exportCacheOverview.ttlMs || 0) / 3600000) || 0 }}{{ t('settings.exportCache.hours') }}
            </div>
          </div>
          <button class="btn" style="font-size: 12px; padding: 5px 12px; flex-shrink: 0" @click="clearExportCache">{{ t('settings.exportCache.clear') }}</button>
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

        <div class="divider" style="margin: 0"></div>

        <!-- 文件名模板 -->
        <div style="display: flex; justify-content: space-between; align-items: flex-start; padding: 14px 0; gap: 20px">
          <div style="flex-shrink: 0">
            <div style="font-weight: 500; font-size: 14px">{{ t('settings.export.nameTemplate') }}</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">{{ t('settings.export.nameTemplateDesc') }}</div>
            <div style="font-size: 12px; margin-top: 8px; line-height: 1.6" :style="{ color: exportNameTemplateError ? 'var(--danger)' : 'var(--text-tertiary)' }">
              {{ exportNameTemplateError || t('settings.export.nameTemplateValid') }}
            </div>
            <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 4px; line-height: 1.5; word-break: break-all">
              {{ t('settings.nameTemplate.preview') }}{{ exportNamePreview }}
            </div>
            <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 4px; line-height: 1.5">
              {{ t('settings.nameTemplate.placeholders') }}{mode} {section} {paper} {year} {season} {fav} {exclude} {count} {custom} {ts} {date} {time} {seq}
            </div>
          </div>
          <div style="display: flex; flex-direction: column; gap: 8px; min-width: 260px; flex: 1">
            <input
              v-model.trim="exportNameTemplate"
              type="text"
              placeholder="{mode}_{section}_{paper}_{year}_{season}_{count}"
              style="padding: 6px 10px; background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; color: var(--text-primary); font-family: inherit; outline: none"
              @blur="onNameTemplateBlur"
              @keydown.enter.prevent="onNameTemplateBlur"
            />
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
              <label style="font-size: 12px; color: var(--text-tertiary); min-width: 58px">{custom}</label>
              <input
                v-model.trim="exportNameCustom"
                type="text"
                :placeholder="t('settings.nameTemplate.customPlaceholder')"
                class="settings-text-input"
                @blur="onExportNameOptionChange"
                @keydown.enter.prevent="onExportNameOptionChange"
              />
              <label style="font-size: 12px; color: var(--text-tertiary)">{{ t('settings.nameTemplate.moduleValue') }}</label>
              <select
                v-model="exportNameSectionStyle"
                class="settings-select"
                @change="onExportNameOptionChange"
              >
                <option value="display">{{ t('settings.nameTemplate.displayName') }}</option>
                <option value="raw">{{ t('settings.nameTemplate.rawName') }}</option>
              </select>
              <div style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); white-space: nowrap">
                <AppCheckbox
                  v-model="exportNameAutoTimestamp"
                  @update:model-value="onExportNameOptionChange"
                />
                {{ t('settings.nameTemplate.autoTimestamp') }}
              </div>
            </div>
            <button class="btn" style="font-size: 12px; padding: 5px 12px; align-self: flex-end" @click="resetNameTemplate">{{ t('settings.export.resetDefault') }}</button>
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

        <div class="divider" style="margin: 16px 0 0"></div>

        <!-- 压缩页面图片 -->
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 0">
          <div>
            <div style="font-weight: 500; font-size: 14px">{{ t('settings.maintenance.webpConvert') }}</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">{{ t('settings.maintenance.webpConvertDesc') }}</div>
          </div>
          <button class="btn" :disabled="maintenanceBusy" @click="settingsStore.convertToWebp()">
            {{ t('settings.maintenance.webpButton') }}
          </button>
        </div>

        <!-- 转换进度 -->
        <div v-if="webpConvertProgress.running && !webpConvertProgress.finished" style="margin-top: 4px">
          <div style="display: flex; justify-content: space-between; font-size: 12px; color: var(--text-secondary); margin-bottom: 6px">
            <span>{{ t('settings.maintenance.webpRunning') }}</span>
            <span>{{ webpConvertProgress.done }} / {{ webpConvertProgress.total || '?' }}</span>
          </div>
          <div style="width: 100%; height: 6px; border-radius: 999px; background: var(--bg-pressed); overflow: hidden">
            <div
              style="height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), #22c55e); transition: width 0.2s ease"
              :style="{ width: webpConvertProgress.total > 0 ? (webpConvertProgress.done / webpConvertProgress.total * 100).toFixed(1) + '%' : '0%' }"
            ></div>
          </div>
        </div>

        <!-- 转换结果 -->
        <div v-if="webpConvertReport" style="margin-top: 8px; font-size: 13px; color: var(--text-secondary); line-height: 1.6; padding: 12px; background: var(--bg-input); border-radius: var(--radius-sm)">
          {{ t('settings.maintenance.webpDone', { converted: webpConvertReport.converted || 0, beforeMB: ((webpConvertReport.before_bytes || 0) / 1024 / 1024).toFixed(1), afterMB: ((webpConvertReport.after_bytes || 0) / 1024 / 1024).toFixed(1) }) }}
          <span v-if="webpConvertReport.errors" style="color: var(--warning)">（{{ webpConvertReport.errors }} 个错误）</span>
        </div>
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
          {{ appUpdateStore.checking ? t('update.checking') : t('update.upToDate') }}
        </button>
      </div>
      <div v-if="appUpdateStore.error" style="margin-top: 6px; font-size: 12px; color: #ef4444">
        {{ appUpdateStore.error }}
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
