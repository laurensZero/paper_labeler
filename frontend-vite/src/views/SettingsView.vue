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
  appStore.setStatus(enabled ? '多选区左右对齐：已开启' : '多选区左右对齐：已关闭', 'ok')
}

async function onToggleAlignPaperFirst() {
  const enabled = settingsStore.saveAlignPaperFirst(!alignPaperFirstEnabled.value)
  if (enabled && papersStore.currentPaperId != null) {
    await markStore.ensurePaperAlignRefFromFirstQuestion(papersStore.currentPaperId)
  }
  appStore.setStatus(enabled ? '按试卷首题对齐：已开启' : '按试卷首题对齐：已关闭', 'ok')
}

async function onToggleAnswerAlign() {
  const enabled = settingsStore.saveAnswerAlign(!answerAlignEnabled.value)
  if (enabled) {
    await answerStore.ensureAnswerAlignRefFromFirstQuestion()
  }
  appStore.setStatus(enabled ? '答案框左右对齐：已开启' : '答案框左右对齐：已关闭', 'ok')
}

function onToggleOcrAuto() {
  settingsStore.saveOcrAuto(!ocrAutoEnabled.value)
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
  appStore.setStatus('导出缓存已清除', 'ok')
}

function formatAgeText(ms: number | null | undefined) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return '无'
  if (n < 60_000) return `${Math.round(n / 1000)} 秒`
  if (n < 3_600_000) return `${Math.round(n / 60_000)} 分钟`
  return `${(n / 3_600_000).toFixed(1)} 小时`
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
})
</script>

<template>
  <div style="max-width: 680px">
    <h2 style="font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 24px">{{ t('settings.title') }}</h2>

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
            <div style="font-weight: 500; font-size: 14px">OCR 最小高度</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">小于该像素高度的识别框会被过滤。</div>
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
            <div style="font-weight: 500; font-size: 14px">OCR 上下留白</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">自动识别框保存前额外扩展的上下像素。</div>
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
      <div class="card-title">列表性能</div>
      <div style="display: flex; flex-direction: column; gap: 0">
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 0; gap: 20px">
          <div>
            <div style="font-weight: 500; font-size: 14px">题库列表虚拟化</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">结果达到阈值后只渲染可视区附近的题卡；Overscan 越大滚动越顺滑，越小越省资源。</div>
          </div>
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end">
            <label style="font-size: 12px; color: var(--text-tertiary)">阈值</label>
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
            <div style="font-weight: 500; font-size: 14px">导出缓存管理</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5">筛选导出会缓存题目 ID；筛选条件相同且数据未变时可复用。</div>
            <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 6px; line-height: 1.6">
              当前 {{ exportCacheOverview.entryCount || 0 }} 组；
              最新 {{ formatAgeText(exportCacheOverview.newestAgeMs) }}；
              最旧 {{ formatAgeText(exportCacheOverview.oldestAgeMs) }}；
              命中率 {{ exportCacheHitRateText }}
            </div>
            <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 4px; line-height: 1.6">
              过期 {{ exportCacheStats.expired || 0 }} 次；写入 {{ exportCacheStats.write || 0 }} 次；有效期 {{ Math.round((exportCacheOverview.ttlMs || 0) / 3600000) || 0 }} 小时。
            </div>
          </div>
          <button class="btn" style="font-size: 12px; padding: 5px 12px; flex-shrink: 0" @click="clearExportCache">清除缓存</button>
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
              当前预览：{{ exportNamePreview }}
            </div>
            <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 4px; line-height: 1.5">
              可用占位符：{mode} {section} {paper} {year} {season} {fav} {exclude} {count} {custom} {ts} {date} {time} {seq}
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
                placeholder="自定义常量"
                class="settings-text-input"
                @blur="onExportNameOptionChange"
                @keydown.enter.prevent="onExportNameOptionChange"
              />
              <label style="font-size: 12px; color: var(--text-tertiary)">模块值</label>
              <select
                v-model="exportNameSectionStyle"
                class="settings-select"
                @change="onExportNameOptionChange"
              >
                <option value="display">显示名（含大类）</option>
                <option value="raw">原始模块名</option>
              </select>
              <div style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); white-space: nowrap">
                <AppCheckbox
                  v-model="exportNameAutoTimestamp"
                  @update:model-value="onExportNameOptionChange"
                />
                自动追加时间戳
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
            {{ t('settings.maintenance.repair') }}: 清理孤儿记录
          </div>
          <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary)">
            <AppCheckbox v-model="maintenanceFillMissingQuestionNo" />
            填充缺失题号
          </div>
          <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary)">
            <AppCheckbox v-model="maintenanceRenumberQuestionNo" />
            题号重排为连续序列
          </div>
        </div>

        <div style="display: flex; gap: 10px">
          <button class="btn" :disabled="maintenanceBusy" @click="runIntegrityCheck">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            {{ t('settings.maintenance.integrity') }}
          </button>
          <button class="btn" :disabled="maintenanceBusy" @click="runRepairDry">
            干跑修复
          </button>
          <button class="btn" :disabled="maintenanceBusy" style="color: var(--warning); border-color: rgba(255, 159, 10, 0.3)" @click="runRepairApply">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
            执行修复
          </button>
        </div>

        <!-- 完整性检查结果 -->
        <div v-if="maintenanceIntegrityReport" style="margin-top: 14px; font-size: 13px; color: var(--text-secondary); line-height: 1.6; padding: 12px; background: var(--bg-input); border-radius: var(--radius-sm)">
          <div>总题数 {{ maintenanceIntegrityReport.total_questions || 0 }}，缺失题号 {{ maintenanceIntegrityReport.missing_question_no || 0 }}，题号跳号 {{ maintenanceIntegrityReport.question_no_gap_count || 0 }}</div>
          <div>重复题号组 {{ maintenanceIntegrityReport.duplicate_question_no_groups || 0 }}，孤儿题框 {{ maintenanceIntegrityReport.orphan_question_boxes || 0 }}，孤儿答案框 {{ maintenanceIntegrityReport.orphan_answer_boxes || 0 }}，孤儿模块关联 {{ maintenanceIntegrityReport.orphan_question_sections || 0 }}</div>
          <div v-if="maintenanceIntegrityReport.question_no_gap_examples?.length" style="margin-top: 4px">
            跳号示例：{{ maintenanceIntegrityReport.question_no_gap_examples.join(', ') }}
          </div>
        </div>

        <!-- 修复结果 -->
        <div v-if="maintenanceRepairReport" style="margin-top: 8px; font-size: 13px; color: var(--text-secondary); line-height: 1.6; padding: 12px; background: var(--bg-input); border-radius: var(--radius-sm)">
          上次{{ maintenanceRepairReport.dry_run ? '干跑' : '修复' }}：
          清理题框 {{ maintenanceRepairReport.orphan_question_boxes_removed || 0 }}，
          清理答案框 {{ maintenanceRepairReport.orphan_answer_boxes_removed || 0 }}，
          清理模块关联 {{ maintenanceRepairReport.orphan_question_sections_removed || 0 }}，
          填充题号 {{ maintenanceRepairReport.missing_question_no_filled || 0 }}，
          重排题号 {{ maintenanceRepairReport.question_no_resequenced_changed || 0 }}
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
