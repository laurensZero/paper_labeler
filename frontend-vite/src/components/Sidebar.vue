<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { usePapersStore } from '@/stores/papers'
import { useCieImportStore } from '@/stores/cieImport'
import PaperList from './PaperList.vue'

defineOptions({ name: 'Sidebar' })

const props = defineProps<{
  collapsed?: boolean
}>()

const { t } = useI18n()
const router = useRouter()
const papersStore = usePapersStore()
const cieImportStore = useCieImportStore()

const searchQuery = ref('')
const uploadInputRef = ref<HTMLInputElement | null>(null)

const uploading = computed(() => papersStore.uploading)
const uploadStatus = computed(() => papersStore.uploadStatus)

async function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files?.length) return
  const openedPaperId = await papersStore.uploadPdf(input.files)
  if (openedPaperId != null) {
    router.push({ name: 'mark', params: { paperId: String(openedPaperId) } })
  }
  input.value = ''
}

function triggerFileInput() {
  uploadInputRef.value?.click()
}

function openCieImport() {
  cieImportStore.openCieImport()
  cieImportStore.ensureCieSubjectComboList()
  router.push({ name: 'filter' })
}

function refreshPapers() {
  papersStore.refreshPapers()
}
</script>

<template>
  <div class="sidebar-panel">
    <!-- Search -->
    <div v-if="!props.collapsed" class="sidebar-search">
      <div class="search-wrapper">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          v-model="searchQuery"
          type="text"
          class="search-input"
          :placeholder="t('sidebar.search')"
        />
      </div>
    </div>

    <!-- Upload Section -->
    <div v-if="!props.collapsed" class="sidebar-section">
      <div class="section-header">
        <span class="section-title">{{ t('upload.title') }}</span>
        <span class="section-hint">{{ t('upload.hint') }}</span>
      </div>

      <div class="upload-area">
        <input
          ref="uploadInputRef"
          type="file"
          accept="application/pdf"
          multiple
          class="upload-input-hidden"
          @change="onFileSelected"
        />
        <button
          class="upload-trigger"
          :disabled="uploading"
          @click="triggerFileInput"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <span>{{ uploading ? t('upload.status') : t('upload.title') }}</span>
        </button>

        <button class="btn-cie-import" @click="openCieImport">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
          <span>{{ t('upload.cieImport') }}</span>
        </button>
      </div>

      <div v-if="uploadStatus" class="upload-status">
        {{ uploadStatus }}
      </div>
    </div>

    <!-- Divider -->
    <div class="sidebar-divider"></div>

    <!-- Paper List -->
    <div v-if="!props.collapsed" class="sidebar-section sidebar-section--papers">
      <div class="section-header">
        <span class="section-title">{{ t('paperList.title') }}</span>
        <button class="btn-refresh" :title="t('paperList.title')" @click="refreshPapers">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
      </div>
      <PaperList :search-query="searchQuery" />
    </div>

    <!-- Footer -->
    <div v-if="!props.collapsed" class="sidebar-footer">
      <button class="footer-action" @click="router.push({ name: 'answer-admin' })">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
        <span>{{ t('answerAdmin.title') }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.sidebar-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  gap: 8px;
  padding: 0 4px;
}

/* Search */
.sidebar-search {
  padding: 0 4px;
}

.search-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-tertiary);
  pointer-events: none;
  flex-shrink: 0;
}

.search-input {
  width: 100%;
  padding: 8px 12px 8px 32px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-primary);
  font-family: inherit;
  transition: all var(--duration-fast) var(--ease-out);
  outline: none;
}

.search-input::placeholder {
  color: var(--text-tertiary);
}

.search-input:focus {
  background: var(--bg-elevated);
  border-color: var(--border-accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

/* Sections */
.sidebar-section {
  margin-bottom: 0;
  padding: 0 4px;
}

.sidebar-section--papers {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  margin-bottom: 8px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.3px;
}

.section-hint {
  font-size: 11px;
  color: var(--text-tertiary);
}

.btn-refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
}

.btn-refresh:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
  color: var(--text-primary);
}

/* Upload */
.upload-area {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.upload-input-hidden {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}

.upload-trigger {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 10px 16px;
  background: var(--accent);
  color: white;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
  box-shadow: 0 1px 3px rgba(0, 113, 227, 0.3);
}

.upload-trigger:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
  box-shadow: 0 2px 8px rgba(0, 113, 227, 0.4);
  transform: translateY(-1px);
}

.upload-trigger:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: 0 1px 3px rgba(0, 113, 227, 0.3);
}

.upload-trigger:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-cie-import {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 8px 16px;
  background: var(--bg-card);
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
}

.btn-cie-import:hover {
  background: var(--bg-card-hover);
  border-color: var(--border-strong);
  color: var(--text-primary);
  box-shadow: var(--shadow-xs);
}

.upload-status {
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--text-tertiary);
  padding: 0 2px;
}

/* Divider */
.sidebar-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 0 12px;
}

/* Footer */
.sidebar-footer {
  padding: 8px 4px;
  border-top: 1px solid var(--border);
  margin-top: auto;
}

.footer-action {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
}

.footer-action:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
