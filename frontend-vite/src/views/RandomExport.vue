<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useExportStore } from '@/stores/export'
import type { RandomExportGroup } from '@/stores/export'

const { t } = useI18n()
defineOptions({ name: 'RandomExport' })

const exportStore = useExportStore()

const {
  randomExportOpen,
  randomExportFavOnly,
  randomExportYearList,
  randomExportSections,
  randomExportGroups,
  randomExportGroupOpen,
  randomExportTotalCount,
  randomExportBatchValue,
} = storeToRefs(exportStore)

/* ── Computed ── */
const hasSelection = computed(() =>
  randomExportSections.value.some((s) => s.selected && s.value > 0),
)

/* ── Handlers ── */
function onClose() {
  randomExportOpen.value = false
}

function onFavOnlyChange() {
  // Re-fetch stats with new favorite filter
  exportStore.openRandomExportSettings()
}

function onBatchAdd() {
  exportStore.randomExportBatch(1)
}

function onBatchSub() {
  exportStore.randomExportBatch(-1)
}

function onReset() {
  exportStore.randomExportReset()
}

function onSelectAll() {
  exportStore.randomExportSelectAll()
}

function onUpdateTotal() {
  exportStore.randomExportUpdateTotal()
}

function onConfirm() {
  exportStore.confirmRandomExport()
}

function isGroupOpen(label: string): boolean {
  return randomExportGroupOpen.value?.[label] === true
}

function toggleGroup(label: string) {
  const cur = randomExportGroupOpen.value?.[label] === true
  randomExportGroupOpen.value = { ...randomExportGroupOpen.value, [label]: !cur }
}

function isGroupAllSelected(group: RandomExportGroup): boolean {
  return group.items.length > 0 && group.items.every((s) => s.selected)
}

function toggleGroupSelectAll(group: RandomExportGroup) {
  const allSelected = isGroupAllSelected(group)
  group.items.forEach((s) => { s.selected = !allSelected })
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="randomExportOpen" class="modal-mask" @click.self="onClose">
        <div class="modal-panel">
          <!-- Header -->
          <div class="modal-header">
            <div class="modal-title">{{ t('randomExport.title') }}</div>
            <button class="btn btn-ghost" @click="onClose">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <!-- Description -->
          <div class="description">{{ t('randomExport.description') }}</div>

          <!-- Favorite Only -->
          <div class="option-row">
            <label class="checkbox-item">
              <input type="checkbox" v-model="randomExportFavOnly" @change="onFavOnlyChange" />
              {{ t('randomExport.favOnly') }}
            </label>
          </div>

          <!-- Scrollable Content -->
          <div class="modal-body">
            <!-- Year List -->
            <div class="section-block">
              <div class="section-block-header">
                <div class="section-block-title">{{ t('randomExport.includeYears') }}</div>
                <span class="hint-text">{{ t('randomExport.yearHint') }}</span>
              </div>
              <div class="checkbox-grid">
                <label
                  v-for="y in randomExportYearList"
                  :key="y.year"
                  class="checkbox-item"
                >
                  <input type="checkbox" v-model="y.checked" />
                  {{ y.year }}
                </label>
              </div>
            </div>

            <!-- Batch Controls -->
            <div class="batch-controls">
              <div class="batch-left">
                <button class="btn btn-sm" :title="t('randomExport.batchSubTitle')" @click="onBatchSub">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </button>
                <button class="btn btn-sm" :title="t('randomExport.batchAddTitle')" @click="onBatchAdd">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </button>
                <input
                  v-model.number="randomExportBatchValue"
                  type="number"
                  min="1"
                  class="batch-input"
                />
                <span class="hint-text">{{ t('randomExport.batchLabel') }}</span>
              </div>
              <div class="batch-right">
                <button class="btn btn-sm" @click="onSelectAll">{{ t('randomExport.selectAll') }}</button>
                <button class="btn btn-sm" @click="onReset">{{ t('randomExport.reset') }}</button>
              </div>
            </div>

            <!-- Section Groups -->
            <div class="groups-container">
              <div
                v-for="group in randomExportGroups"
                :key="group.label"
                class="group-block"
              >
                <!-- Group Header -->
                <div class="group-header" @click="toggleGroup(group.label)">
                  <div class="group-header-left">
                    <svg
                      width="12" height="12" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
                      class="chevron"
                      :class="{ open: isGroupOpen(group.label) }"
                    >
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                    <span class="group-label">{{ group.label }}</span>
                    <span class="group-count">{{ t('randomExport.stock') }} {{ group.totalCount }}</span>
                  </div>
                  <button
                    class="btn btn-sm btn-ghost group-select-btn"
                    @click.stop="toggleGroupSelectAll(group)"
                  >
                    {{ isGroupAllSelected(group) ? t('randomExport.deselectAll') : t('randomExport.selectAllGroup') }}
                  </button>
                </div>

                <!-- Group Items -->
                <Transition name="collapse">
                  <div v-show="isGroupOpen(group.label)" class="group-items">
                    <div
                      v-for="item in group.items"
                      :key="item.section"
                      class="section-row"
                    >
                      <label class="section-label">
                        <input type="checkbox" v-model="item.selected" />
                        <span class="section-name" :title="item.section || t('randomExport.unsectioned')">
                          {{ item.section || t('randomExport.unsectioned') }}
                        </span>
                        <span class="section-stock">({{ t('randomExport.stock') }} {{ item.count }})</span>
                      </label>
                      <input
                        type="number"
                        min="0"
                        class="section-count-input"
                        v-model.number="item.value"
                        @input="onUpdateTotal"
                      />
                    </div>
                  </div>
                </Transition>
              </div>
            </div>
          </div>

          <!-- Footer -->
          <div class="modal-footer">
            <div class="total-count">
              {{ t('randomExport.totalCount') }}：<strong>{{ randomExportTotalCount }}</strong>
            </div>
            <div class="footer-actions">
              <button class="btn" @click="onClose">{{ t('randomExport.cancel') }}</button>
              <button class="btn btn-primary" :disabled="!hasSelection" @click="onConfirm">
                {{ t('randomExport.confirm') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ── Modal ── */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 1001;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.modal-panel {
  width: min(580px, calc(100vw - 24px));
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

/* ── Collapse Transition ── */
.collapse-enter-active {
  transition: all var(--duration-normal) var(--ease-out);
  overflow: hidden;
}
.collapse-leave-active {
  transition: all var(--duration-fast) var(--ease-out);
  overflow: hidden;
}
.collapse-enter-from,
.collapse-leave-to {
  opacity: 0;
  max-height: 0;
}
.collapse-enter-to,
.collapse-leave-from {
  opacity: 1;
  max-height: 1000px;
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

/* ── Description ── */
.description {
  padding: 10px 24px 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}

/* ── Option Row ── */
.option-row {
  padding: 12px 24px;
}

/* ── Body ── */
.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 0 24px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── Section Block ── */
.section-block {
  padding: 16px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.section-block-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.section-block-title {
  font-size: 13px;
  font-weight: 600;
}

/* ── Batch Controls ── */
.batch-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.batch-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.batch-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.batch-input {
  width: 56px;
  padding: 4px 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-primary);
  font-family: inherit;
  outline: none;
  text-align: center;
}

.batch-input:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* ── Groups ── */
.groups-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.group-block {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}

.group-header:hover {
  background: var(--bg-hover);
}

.group-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chevron {
  transition: transform var(--duration-fast) var(--ease-out);
  flex-shrink: 0;
}

.chevron.open {
  transform: rotate(90deg);
}

.group-label {
  font-size: 13px;
  font-weight: 600;
}

.group-count {
  font-size: 12px;
  color: var(--text-tertiary);
}

.group-select-btn {
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}

.group-header:hover .group-select-btn {
  opacity: 1;
}

/* ── Group Items ── */
.group-items {
  border-top: 1px solid var(--border);
}

.section-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 10px 34px;
  border-bottom: 1px solid var(--border);
  transition: background var(--duration-fast) var(--ease-out);
}

.section-row:last-child {
  border-bottom: none;
}

.section-row:hover {
  background: var(--bg-hover);
}

.section-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
  flex: 1;
  min-width: 0;
}

.section-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-stock {
  font-size: 12px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.section-count-input {
  width: 72px;
  padding: 5px 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-primary);
  font-family: inherit;
  outline: none;
  text-align: center;
  flex-shrink: 0;
}

.section-count-input:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* ── Checkbox ── */
.checkbox-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}

.checkbox-item input[type="checkbox"] {
  accent-color: var(--accent);
}

.checkbox-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 8px 16px;
}

/* ── Hint ── */
.hint-text {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.5;
}

/* ── Footer ── */
.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.total-count {
  font-size: 14px;
  color: var(--text-primary);
}

.total-count strong {
  color: var(--text-accent);
  font-weight: 700;
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
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

@media (max-width: 520px) {
  .modal-header,
  .description,
  .option-row,
  .modal-body,
  .modal-footer {
    padding-left: 14px;
    padding-right: 14px;
  }

  .section-block {
    padding: 12px;
  }

  .batch-controls,
  .section-block-header,
  .modal-footer,
  .footer-actions {
    flex-wrap: wrap;
  }

  .batch-left,
  .batch-right {
    flex-wrap: wrap;
    min-width: 0;
  }

  .section-row {
    padding-left: 14px;
    gap: 8px;
  }

  .section-label {
    min-width: 0;
  }

  .section-count-input {
    width: 58px;
  }
}
</style>
