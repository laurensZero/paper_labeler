<script setup lang="ts">
import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useCieImportStore } from '@/stores/cieImport'
import AppCheckbox from './ui/AppCheckbox.vue'

defineOptions({ name: 'CieImport' })

const { t } = useI18n()
const store = useCieImportStore()

const {
  cieImportOpen,
  cieSubjectInput,
  cieSubjectName,
  cieSubjectNameKind,
  cieYearInput,
  cieSeason,
  cieImportStatus,
  ciePaperGroups,
  ciePaperUnpaired,
  ciePaperCountText,
  cieSelectedIds,
  cieLoading,
} = storeToRefs(store)

const seasonOptions = ['Mar', 'Jun', 'Nov'] as const

const selectedCount = computed(() => cieSelectedIds.value.size)
const hasPapers = computed(() => ciePaperGroups.value.length > 0 || ciePaperUnpaired.value.length > 0)

function onSubjectInput() {
  store.updateCieSubjectName()
}

function onClose() {
  store.closeCieImport()
}

function onOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('modalMask')) {
    onClose()
  }
}

// Load combo list when dialog opens
watch(cieImportOpen, (open) => {
  if (open) {
    store.ensureCieSubjectComboList()
  }
})
</script>

<template>
  <Teleport to="body">
    <div
      class="modalMask"
      :class="{ show: cieImportOpen }"
      @click="onOverlayClick"
    >
      <div class="cie-modal">
        <!-- Header -->
        <div class="cie-header">
          <div class="cie-header-left">
            <h2 class="cie-title">{{ t('cieImport.title') }}</h2>
            <p class="cie-subtitle">{{ t('cieImport.subtitle') }}</p>
          </div>
          <button class="btn-close" @click="onClose" v-tooltip="t('cieImport.close')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <!-- Filters -->
        <div class="cie-filters">
          <div class="cie-filters-header">
            <span class="cie-filters-title">{{ t('cieImport.filters') }}</span>
            <span class="cie-filters-source">{{ t('cieImport.source') }}</span>
          </div>
          <div class="cie-filters-row">
            <div class="cie-field">
              <label class="cie-label">{{ t('cieImport.subject') }}</label>
              <input
                v-model="cieSubjectInput"
                type="text"
                class="cie-input"
                :placeholder="t('cieImport.subjectPlaceholder')"
                @input="onSubjectInput"
              />
            </div>
            <div class="cie-field-subject-name">
              <span
                v-if="cieSubjectName"
                class="cie-subject-name"
                :class="cieSubjectNameKind"
              >
                {{ cieSubjectName }}
              </span>
            </div>
            <div class="cie-field">
              <label class="cie-label">{{ t('cieImport.year') }}</label>
              <input
                v-model="cieYearInput"
                type="text"
                class="cie-input cie-input--narrow"
                :placeholder="t('cieImport.yearPlaceholder')"
                @keydown.enter="store.fetchPapers()"
              />
            </div>
            <div class="cie-field">
              <label class="cie-label">{{ t('cieImport.season') }}</label>
              <div class="cie-season-group">
                <button
                  v-for="s in seasonOptions"
                  :key="s"
                  class="cie-season-btn"
                  :class="{ active: cieSeason === s }"
                  @click="cieSeason = s"
                >
                  {{ s }}
                </button>
              </div>
            </div>
            <div class="cie-field cie-field--action">
              <button
                class="btn btn-primary cie-fetch-btn"
                :disabled="cieLoading"
                @click="store.fetchPapers()"
              >
                <svg v-if="cieLoading" class="cie-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
                <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                {{ t('cieImport.fetch') }}
              </button>
            </div>
          </div>
          <div v-if="cieImportStatus" class="cie-status">
            {{ cieImportStatus }}
          </div>
        </div>

        <!-- Paper list -->
        <div v-if="hasPapers" class="cie-papers">
          <div class="cie-papers-header">
            <span class="cie-papers-count">{{ ciePaperCountText }}</span>
            <div class="cie-papers-actions">
              <button class="btn btn-ghost btn-sm" @click="store.cieSelectAll()">{{ t('cieImport.selectAll') }}</button>
              <button class="btn btn-ghost btn-sm" @click="store.cieDeselectAll()">{{ t('cieImport.deselectAll') }}</button>
            </div>
          </div>

          <div class="cie-paper-list">
            <!-- Empty state -->
            <div v-if="!ciePaperGroups.length && !ciePaperUnpaired.length" class="cie-paper-empty">
              {{ t('cieImport.noPapers') }}
            </div>

            <!-- Paired groups -->
            <div
              v-for="group in ciePaperGroups"
              :key="group.baseName"
              class="cie-paper-group"
            >
              <!-- QP -->
              <label
                v-if="group.qp"
                class="cie-paper-item"
                :class="{
                  selected: cieSelectedIds.has(group.qp.originalIdx),
                  exists: group.qp.exists,
                  done: group.qp.done,
                }"
              >
                <AppCheckbox
                  class="cie-checkbox"
                  :model-value="cieSelectedIds.has(group.qp.originalIdx)"
                  @update:model-value="store.toggleCieSelection(group.qp, $event)"
                />
                <span class="cie-paper-filename">{{ group.qp.filename }}</span>
                <span class="cie-badge cie-badge--qp">{{ t('cieImport.questionPaper') }}</span>
                <span v-if="group.qp.exists" class="cie-badge cie-badge--exists">{{ t('cieImport.imported') }}</span>
                <span v-if="group.qp.done" class="cie-badge cie-badge--done">{{ t('cieImport.completed') }}</span>
              </label>

              <!-- MS -->
              <label
                v-if="group.ms"
                class="cie-paper-item"
                :class="{
                  selected: cieSelectedIds.has(group.ms.originalIdx),
                  exists: group.ms.exists,
                  done: group.ms.done,
                }"
              >
                <AppCheckbox
                  class="cie-checkbox"
                  :model-value="cieSelectedIds.has(group.ms.originalIdx)"
                  @update:model-value="store.toggleCieSelection(group.ms, $event)"
                />
                <span class="cie-paper-filename">{{ group.ms.filename }}</span>
                <span class="cie-badge cie-badge--ms">{{ t('cieImport.markScheme') }}</span>
                <span v-if="group.ms.exists" class="cie-badge cie-badge--exists">{{ t('cieImport.imported') }}</span>
                <span v-if="group.ms.done" class="cie-badge cie-badge--done">{{ t('cieImport.completed') }}</span>
              </label>
            </div>

            <!-- Unpaired papers -->
            <label
              v-for="paper in ciePaperUnpaired"
              :key="paper.originalIdx"
              class="cie-paper-item cie-paper-item--single"
              :class="{
                selected: cieSelectedIds.has(paper.originalIdx),
                exists: paper.exists,
              }"
            >
              <AppCheckbox
                class="cie-checkbox"
                :model-value="cieSelectedIds.has(paper.originalIdx)"
                @update:model-value="store.toggleCieSelection(paper, $event)"
              />
              <span class="cie-paper-filename">{{ paper.filename }}</span>
              <span class="cie-badge cie-badge--other">{{ t('cieImport.other') }}</span>
              <span v-if="paper.exists" class="cie-badge cie-badge--exists">{{ t('cieImport.imported') }}</span>
            </label>
          </div>

          <!-- Footer actions -->
          <div class="cie-papers-footer">
            <span class="cie-selected-count">
              {{ t('cieImport.selectedCount', { count: selectedCount }) }}
            </span>
            <button
              class="btn btn-primary"
              :disabled="selectedCount === 0 || cieLoading"
              @click="store.importSelected()"
            >
              <svg v-if="cieLoading" class="cie-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
              </svg>
              {{ t('cieImport.importSelected') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ── Modal ── */
.modalMask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  opacity: 0;
  visibility: hidden;
  transition: opacity var(--duration-normal) var(--ease-out),
              visibility var(--duration-normal) var(--ease-out);
}

.modalMask.show {
  opacity: 1;
  visibility: visible;
}

.modalMask.show .cie-modal {
  transform: translateY(0) scale(1);
  opacity: 1;
}

/* ── Modal container ── */
.cie-modal {
  width: 640px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl);
  overflow: hidden;
  contain: layout paint;
  transform: translateY(12px) scale(0.98);
  opacity: 0;
  transition: all var(--duration-normal) var(--ease-spring);
}

/* ── Header ── */
.cie-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 24px 24px 16px;
  flex-shrink: 0;
}

.cie-header-left {
  min-width: 0;
}

.cie-title {
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.3px;
  margin: 0;
}

.cie-subtitle {
  font-size: 12.5px;
  color: var(--text-tertiary);
  margin: 4px 0 0;
  line-height: 1.5;
}

.btn-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  color: var(--text-tertiary);
  cursor: pointer;
  flex-shrink: 0;
  transition: all var(--duration-fast) var(--ease-out);
}

.btn-close:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
  color: var(--text-primary);
}

/* ── Filters ── */
.cie-filters {
  padding: 0 24px 16px;
  flex-shrink: 0;
}

.cie-filters-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.cie-filters-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}

.cie-filters-source {
  font-size: 11px;
  color: var(--text-tertiary);
}

.cie-filters-row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}

.cie-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.cie-field--action {
  justify-content: flex-end;
}

.cie-label {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-secondary);
}

.cie-input {
  width: 100px;
  padding: 7px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  font-size: 13px;
  color: var(--text-primary);
  font-family: inherit;
  outline: none;
  transition: all var(--duration-fast) var(--ease-out);
}

.cie-input:focus {
  background: var(--bg-elevated);
  border-color: var(--border-accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.cie-input::placeholder {
  color: var(--text-tertiary);
}

.cie-input--narrow {
  width: 72px;
}

.cie-field-subject-name {
  display: flex;
  align-items: center;
  padding-bottom: 8px;
  min-width: 0;
  flex: 1;
}

.cie-subject-name {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cie-subject-name.ok {
  color: var(--success);
}

.cie-subject-name.err {
  color: var(--danger);
}

/* Season toggle */
.cie-season-group {
  display: flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  overflow: hidden;
}

.cie-season-btn {
  padding: 6px 12px;
  background: none;
  border: none;
  border-right: 1px solid var(--border);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
}

.cie-season-btn:last-child {
  border-right: none;
}

.cie-season-btn:hover {
  background: var(--bg-hover);
}

.cie-season-btn.active {
  background: var(--accent);
  color: white;
}

/* Fetch button */
.cie-fetch-btn {
  white-space: nowrap;
}

/* Status */
.cie-status {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

/* ── Papers section ── */
.cie-papers {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 0 24px 20px;
}

.cie-papers-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  flex-shrink: 0;
}

.cie-papers-count {
  font-size: 12px;
  color: var(--text-tertiary);
}

.cie-papers-actions {
  display: flex;
  gap: 4px;
}

.btn-sm {
  padding: 4px 10px;
  font-size: 11.5px;
}

/* Paper list scrollable */
.cie-paper-list {
  flex: 1;
  min-height: 0;
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  padding: 4px;
}

.cie-paper-empty {
  padding: 32px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary);
}

/* Paper group (QP + MS pair) */
.cie-paper-group {
  border-bottom: 1px solid var(--border);
}

.cie-paper-group:last-child {
  border-bottom: none;
}

/* Paper item row */
.cie-paper-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
  user-select: none;
}

.cie-paper-item:hover {
  background: var(--bg-hover);
}

.cie-paper-item.selected {
  background: var(--accent-soft);
}

.cie-paper-item.exists {
  opacity: 0.65;
}

.cie-paper-item.done {
  opacity: 0.5;
}

.cie-checkbox {
  flex-shrink: 0;
}

.cie-paper-filename {
  font-size: 12px;
  font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

/* Badges */
.cie-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2px;
  white-space: nowrap;
  flex-shrink: 0;
}

.cie-badge--qp {
  background: #2563eb;
  color: white;
}

.cie-badge--ms {
  background: #059669;
  color: white;
}

.cie-badge--other {
  background: #6b7280;
  color: white;
}

.cie-badge--exists {
  background: rgba(255, 159, 10, 0.15);
  color: var(--warning);
  border: 1px solid rgba(255, 159, 10, 0.25);
}

.cie-badge--done {
  background: rgba(52, 199, 89, 0.15);
  color: var(--success);
  border: 1px solid rgba(52, 199, 89, 0.25);
}

/* Footer */
.cie-papers-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
  flex-shrink: 0;
}

.cie-selected-count {
  font-size: 12.5px;
  color: var(--text-secondary);
  font-weight: 500;
}

/* Spinner animation */
.cie-spinner {
  animation: cie-spin 1s linear infinite;
}

@keyframes cie-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ── Scrollbar ── */
.cie-paper-list::-webkit-scrollbar {
  width: 5px;
}

.cie-paper-list::-webkit-scrollbar-track {
  background: transparent;
}

.cie-paper-list::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.25);
  border-radius: 3px;
}

.cie-paper-list::-webkit-scrollbar-thumb:hover {
  background: rgba(128, 128, 128, 0.4);
}
</style>
