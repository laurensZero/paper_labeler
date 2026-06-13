<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useExportStore } from '@/stores/export'
import RandomExport from '@/views/RandomExport.vue'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'

const { t } = useI18n()
defineOptions({ name: 'ExportWizard' })

const exportStore = useExportStore()

const {
  exportWizardOpen,
  exportWizardSummary,
  exportIncludeQno,
  exportIncludeSection,
  exportIncludePaper,
  exportIncludeOriginalQno,
  exportIncludeNotes,
  exportIncludeAnswers,
  exportAnsPlacement,
  exportFileName,
  exportFromRandomMode,
  exportIncludeFilterSummary,
  exportSummaryFieldSection,
  exportSummaryFieldPaper,
  exportSummaryFieldYear,
  exportSummaryFieldSeason,
  exportSummaryFieldFavorites,
  exportSummaryFieldCount,
  exportBusy,
  exportDefaultSaveDir,
  exportJobStatus,
  exportJobPhase,
  exportJobQueuePos,
  exportJobProgressPercent,
} = storeToRefs(exportStore)

const isJobActive = computed(() =>
  exportJobStatus.value === 'queued' || exportJobStatus.value === 'processing',
)

const progressPercent = computed(() =>
  Math.round(exportJobProgressPercent.value || 0),
)



/* ── Lifecycle ── */
watch(exportWizardOpen, (open) => {
  if (open) {
    exportStore.loadExportSettings()
  }
})

/* ── Handlers ── */
function onClose() {
  exportStore.closeExportWizard()
}

function onOpenRandomExport() {
  exportStore.openRandomExportSettings()
}

function onCancelJob() {
  exportStore.cancelExportJob()
}

function onConfirm() {
  exportStore.confirmExportWizard()
}

function onEditSaveDir() {
  exportStore.editExportSaveDir()
}

function persistOptions() {
  exportStore.persistExportWizardOptions()
}
</script>

<template>
  <!-- ── Export Wizard Modal ── -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="exportWizardOpen" class="modal-mask" @click.self="onClose">
        <div class="modal-panel">
          <!-- Header -->
          <div class="modal-header">
            <div class="modal-title">{{ t('exportWizard.title') }}</div>
            <div class="modal-header-actions">
              <button class="btn" @click="onOpenRandomExport">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
                  <polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
                </svg>
                {{ t('exportWizard.randomExport') }}
              </button>
              <button class="btn btn-ghost" @click="onClose">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>

          <!-- Summary -->
          <div class="summary-line">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            <span>{{ exportWizardSummary || t('exportWizard.calculating') }}</span>
          </div>

          <!-- Progress Bar -->
          <div v-if="isJobActive" class="progress-section">
            <div class="progress-header">
              <div class="progress-title">{{ t('exportWizard.progress') }}</div>
              <span v-if="exportJobStatus === 'queued' && exportJobQueuePos > 0" class="progress-hint">
                {{ t('exportWizard.queuePosition', { pos: exportJobQueuePos }) }}
              </span>
              <span v-else class="progress-hint">
                {{ exportJobPhase || (exportJobStatus === 'processing' ? t('exportWizard.processing') : '') }}
              </span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
            </div>
            <div class="progress-footer">
              <span class="progress-percent">{{ progressPercent }}%</span>
              <button class="btn btn-danger-ghost" @click="onCancelJob">
                {{ t('exportWizard.cancelJob') }}
              </button>
            </div>
          </div>

          <!-- Scrollable Content -->
          <div class="modal-body">
            <!-- File Name -->
            <div class="section-card">
              <div class="section-card-header">
                <div class="section-card-title">{{ t('exportWizard.fileName') }}</div>
              </div>
              <input
                v-model.trim="exportFileName"
                type="text"
                class="input"
                :placeholder="t('exportWizard.fileNamePlaceholder')"
              />
              <div class="section-card-footer">
                <div class="footer-text" :title="exportDefaultSaveDir || t('exportWizard.noSaveDir')">
                  {{ t('exportWizard.saveDir') }}：{{ exportDefaultSaveDir || t('exportWizard.noSaveDir') }}
                </div>
                <button class="btn btn-sm" @click="onEditSaveDir">{{ t('exportWizard.editDir') }}</button>
              </div>
              <div class="hint-text">{{ t('exportWizard.saveDirHint') }}</div>
            </div>

            <!-- Filter Summary -->
            <div class="section-card">
              <div class="checkbox-row" :class="{ disabled: exportFromRandomMode }">
                <AppCheckbox
                  v-model="exportIncludeFilterSummary"
                  :disabled="exportFromRandomMode"
                  @update:model-value="persistOptions"
                />
                <span>{{ t('exportWizard.includeFilterSummary') }}</span>
              </div>
              <div class="hint-text" v-if="!exportFromRandomMode">
                {{ t('exportWizard.filterSummaryHint') }}
              </div>
              <div class="hint-text" v-else>
                {{ t('exportWizard.filterSummaryDisabled') }}
              </div>
              <div v-if="exportIncludeFilterSummary && !exportFromRandomMode" class="summary-fields">
                <div class="hint-text" style="margin-bottom: 8px">{{ t('exportWizard.selectSummaryFields') }}</div>
                <div class="checkbox-grid">
                  <div class="checkbox-item"><AppCheckbox v-model="exportSummaryFieldSection" @update:model-value="persistOptions" /> {{ t('exportWizard.fieldSection') }}</div>
                  <div class="checkbox-item"><AppCheckbox v-model="exportSummaryFieldPaper" @update:model-value="persistOptions" /> {{ t('exportWizard.fieldPaper') }}</div>
                  <div class="checkbox-item"><AppCheckbox v-model="exportSummaryFieldYear" @update:model-value="persistOptions" /> {{ t('exportWizard.fieldYear') }}</div>
                  <div class="checkbox-item"><AppCheckbox v-model="exportSummaryFieldSeason" @update:model-value="persistOptions" /> {{ t('exportWizard.fieldSeason') }}</div>
                  <div class="checkbox-item"><AppCheckbox v-model="exportSummaryFieldFavorites" @update:model-value="persistOptions" /> {{ t('exportWizard.fieldFavorites') }}</div>
                  <div class="checkbox-item"><AppCheckbox v-model="exportSummaryFieldCount" @update:model-value="persistOptions" /> {{ t('exportWizard.fieldCount') }}</div>
                </div>
              </div>
            </div>

            <!-- Question Info (Header) -->
            <div class="section-card">
              <div class="section-card-header">
                <div class="section-card-title">{{ t('exportWizard.questionInfo') }}</div>
                <span class="hint-text">{{ t('exportWizard.questionInfoHint') }}</span>
              </div>
              <div class="checkbox-grid">
                <div class="checkbox-item"><AppCheckbox v-model="exportIncludeQno" @update:model-value="persistOptions" /> {{ t('exportWizard.optQno') }}</div>
                <div class="checkbox-item"><AppCheckbox v-model="exportIncludeSection" @update:model-value="persistOptions" /> {{ t('exportWizard.optSection') }}</div>
                <div class="checkbox-item"><AppCheckbox v-model="exportIncludePaper" @update:model-value="persistOptions" /> {{ t('exportWizard.optPaper') }}</div>
                <div class="checkbox-item"><AppCheckbox v-model="exportIncludeOriginalQno" @update:model-value="persistOptions" /> {{ t('exportWizard.optOriginalQno') }}</div>
                <div class="checkbox-item"><AppCheckbox v-model="exportIncludeNotes" @update:model-value="persistOptions" /> {{ t('exportWizard.optNotes') }}</div>
              </div>
            </div>

            <!-- Answers -->
            <div class="section-card">
              <div class="section-card-header">
                <div class="section-card-title">{{ t('exportWizard.answers') }}</div>
                <div class="checkbox-item" style="margin: 0">
                  <AppCheckbox v-model="exportIncludeAnswers" @update:model-value="persistOptions" />
                  {{ t('exportWizard.includeAnswers') }}
                </div>
              </div>
              <div class="radio-group">
                <label class="radio-item" :class="{ disabled: !exportIncludeAnswers }">
                  <input
                    type="radio"
                    name="ansPlacement"
                    value="end"
                    v-model="exportAnsPlacement"
                    :disabled="!exportIncludeAnswers"
                    @change="persistOptions"
                  />
                  {{ t('exportWizard.ansEnd') }}
                </label>
                <label class="radio-item" :class="{ disabled: !exportIncludeAnswers }">
                  <input
                    type="radio"
                    name="ansPlacement"
                    value="interleaved"
                    v-model="exportAnsPlacement"
                    :disabled="!exportIncludeAnswers"
                    @change="persistOptions"
                  />
                  {{ t('exportWizard.ansInterleaved') }}
                </label>
              </div>
              <div class="hint-text">{{ t('exportWizard.ansHint') }}</div>
            </div>
          </div>

          <!-- Footer -->
          <div class="modal-footer">
            <button class="btn" :disabled="exportBusy" @click="onClose">
              {{ t('exportWizard.cancel') }}
            </button>
            <button class="btn btn-primary" :disabled="exportBusy" @click="onConfirm">
              <svg v-if="exportBusy" class="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
              {{ exportBusy ? t('exportWizard.exporting') : t('exportWizard.startExport') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- ── Random Export Modal ── -->
  <RandomExport />
</template>

<style scoped>
/* ── Modal ── */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.modal-panel {
  width: min(560px, calc(100vw - 24px));
  max-height: min(85vh, calc(100vh - 24px));
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
  overflow: hidden;
  contain: layout paint;
}

/* ── Transition ── */
.modal-enter-active {
  transition: opacity var(--duration-normal) var(--ease-out);
}
.modal-enter-active .modal-panel {
  transition: transform var(--duration-normal) var(--ease-spring), opacity var(--duration-normal) var(--ease-out);
}
.modal-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out);
}
.modal-leave-active .modal-panel {
  transition: transform var(--duration-fast) var(--ease-out), opacity var(--duration-fast) var(--ease-out);
}
.modal-enter-from {
  opacity: 0;
}
.modal-enter-from .modal-panel {
  transform: scale(0.95) translateY(10px);
  opacity: 0;
}
.modal-leave-to {
  opacity: 0;
}
.modal-leave-to .modal-panel {
  transform: scale(0.97);
  opacity: 0;
}

/* ── Header ── */
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 0;
  flex-shrink: 0;
}

.modal-title {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.3px;
}

.modal-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ── Summary ── */
.summary-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  font-size: 13px;
  color: var(--text-secondary);
}

/* ── Progress ── */
.progress-section {
  margin: 0 24px 4px;
  padding: 14px 16px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.progress-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.progress-title {
  font-size: 13px;
  font-weight: 600;
}

.progress-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.progress-bar {
  height: 6px;
  background: var(--bg-pressed);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 10px;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 300ms var(--ease-out);
}

.progress-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.progress-percent {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-accent);
}

/* ── Body ── */
.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 24px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── Section Card ── */
.section-card {
  padding: 16px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.section-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.section-card-title {
  font-size: 13px;
  font-weight: 600;
}

.section-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  gap: 12px;
}

.footer-text {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

/* ── Input ── */
.input {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-primary);
  font-family: inherit;
  outline: none;
  transition: all var(--duration-fast) var(--ease-out);
}

.input::placeholder {
  color: var(--text-tertiary);
}

.input:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* ── Checkbox ── */
.checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-primary);
}

.checkbox-row.disabled {
  color: var(--text-tertiary);
}

.checkbox-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px 16px;
}

.checkbox-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}

/* ── Radio ── */
.radio-group {
  display: flex;
  gap: 16px;
  margin-top: 10px;
}

.radio-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}

.radio-item.disabled {
  color: var(--text-tertiary);
  cursor: default;
}

.radio-item input[type="radio"] {
  appearance: none;
  width: 18px;
  height: 18px;
  border: 1.5px solid var(--border-strong);
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
  position: relative;
}

.radio-item input[type="radio"]::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) scale(0);
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-primary);
  transition: transform var(--duration-fast) var(--ease-spring);
}

.radio-item input[type="radio"]:checked {
  border-color: var(--text-primary);
}

.radio-item input[type="radio"]:checked::after {
  transform: translate(-50%, -50%) scale(1);
}

/* ── Hint ── */
.hint-text {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.5;
  margin-top: 8px;
}

/* ── Summary Fields ── */
.summary-fields {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

/* ── Footer ── */
.modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 24px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

/* ── Buttons ── */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 16px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
  outline: none;
}

.btn:hover:not(:disabled) {
  background: var(--bg-card-hover);
  border-color: var(--border-strong);
  box-shadow: var(--shadow-xs);
  transform: translateY(-1px);
}

.btn:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: none;
  background: var(--bg-pressed);
}

.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.btn-primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
  box-shadow: 0 1px 3px rgba(0, 113, 227, 0.3);
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
  box-shadow: 0 2px 8px rgba(0, 113, 227, 0.4);
}

.btn-ghost {
  background: transparent;
  border-color: transparent;
  padding: 6px;
}

.btn-ghost:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: transparent;
  box-shadow: none;
  transform: none;
}

.btn-danger-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--danger);
  padding: 4px 10px;
  font-size: 12px;
}

.btn-danger-ghost:hover:not(:disabled) {
  background: rgba(255, 59, 48, 0.08);
  border-color: transparent;
  box-shadow: none;
  transform: none;
}

/* ── Spinner ── */
.spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (max-width: 520px) {
  .modal-header,
  .modal-footer {
    padding-left: 14px;
    padding-right: 14px;
  }

  .modal-header,
  .modal-header-actions,
  .section-card-footer,
  .modal-footer {
    flex-wrap: wrap;
  }

  .summary-line,
  .modal-body {
    padding-left: 14px;
    padding-right: 14px;
  }

  .progress-section {
    margin-left: 14px;
    margin-right: 14px;
  }

  .checkbox-grid {
    grid-template-columns: 1fr;
  }
}
</style>
