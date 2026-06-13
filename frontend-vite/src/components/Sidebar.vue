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

const emit = defineEmits<{
  toggleCollapse: []
}>()

const { t } = useI18n()
const router = useRouter()
const papersStore = usePapersStore()
const cieImportStore = useCieImportStore()

const searchQuery = ref('')
const uploadInputRef = ref<HTMLInputElement | null>(null)

const uploading = computed(() => papersStore.uploading)

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
</script>

<template>
  <div class="sidebar-panel">
    <!-- Search -->
    <div v-if="!props.collapsed" class="sidebar-search">
      <div class="search-wrapper">
        <svg class="search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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

    <!-- Paper List -->
    <div v-if="!props.collapsed" class="sidebar-section sidebar-section--papers">
      <PaperList :search-query="searchQuery" />
    </div>

    <!-- Footer — same structure for both states -->
    <div class="sidebar-footer">
      <input
        ref="uploadInputRef"
        type="file"
        accept="application/pdf"
        multiple
        class="upload-input-hidden"
        @change="onFileSelected"
      />
      <button class="footer-btn" :class="{ collapsed: props.collapsed }" :disabled="uploading" @click="triggerFileInput" :title="t('upload.title')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <span v-if="!props.collapsed" class="footer-btn-label">{{ uploading ? t('upload.status') : t('upload.title') }}</span>
      </button>
      <button class="footer-btn" :class="{ collapsed: props.collapsed }" @click="openCieImport" :title="t('upload.cieImport')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
        <span v-if="!props.collapsed" class="footer-btn-label">{{ t('upload.cieImport') }}</span>
      </button>
      <button class="footer-btn" :class="{ collapsed: props.collapsed }" @click="router.push({ name: 'answer-admin' })" :title="t('answerAdmin.title')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
        <span v-if="!props.collapsed" class="footer-btn-label">{{ t('answerAdmin.title') }}</span>
      </button>
      <div class="sidebar-divider"></div>
      <button class="footer-btn" :class="{ collapsed: props.collapsed }" @click="emit('toggleCollapse')" :title="props.collapsed ? t('sidebar.expand') : t('sidebar.collapse')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline :points="props.collapsed ? '9 18 15 12 9 6' : '15 18 9 12 15 6'" />
        </svg>
        <span v-if="!props.collapsed" class="footer-btn-label">{{ t('sidebar.collapse') }}</span>
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
  gap: 4px;
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
  padding: 7px 10px 7px 30px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-primary);
  font-family: inherit;
  transition: all 120ms ease;
  outline: none;
}

.search-input::placeholder {
  color: var(--text-tertiary);
}

.search-input:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

/* Paper list section */
.sidebar-section {
  padding: 0 4px;
}

.sidebar-section--papers {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* Upload hidden */
.upload-input-hidden {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}

/* Footer */
.sidebar-footer {
  padding: 8px 4px;
  border-top: 1px solid var(--border);
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sidebar-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}

.footer-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: all 100ms ease;
  white-space: nowrap;
}

.footer-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.footer-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Collapsed: center icon, square hit area */
.footer-btn.collapsed {
  justify-content: center;
  width: 36px;
  height: 36px;
  align-self: center;
  padding: 0;
}

.footer-btn-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
