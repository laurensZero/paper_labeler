<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { usePapersStore } from '@/stores/papers'
import { useFilterStore } from '@/stores/filter'
import { papersApi } from '@/api/endpoints'

defineOptions({ name: 'PaperList' })

const props = withDefaults(defineProps<{
  searchQuery?: string
}>(), {
  searchQuery: '',
})

const { t } = useI18n()
const router = useRouter()
const papersStore = usePapersStore()
const filterStore = useFilterStore()

const papers = computed(() => papersStore.papers)
const normalizedSearchQuery = computed(() => props.searchQuery.trim().toLowerCase())
const viewPapers = computed(() => {
  const list = papersStore.viewPapers
  const query = normalizedSearchQuery.value
  if (!query) return list
  return list.filter((paper) => {
    const haystack = [
      paper.id,
      paper.display_no,
      paper.exam_code,
      paper.filename,
      paper.page_count,
      paper.question_count,
      paper.answers_marked,
    ]
      .filter((v) => v != null)
      .join(' ')
      .toLowerCase()
    return haystack.includes(query)
  })
})
const currentPaperId = computed(() => papersStore.currentPaperId)
const showDonePapers = computed(() => papersStore.showDonePapers)

const paperCountHint = computed(() => {
  const total = papers.value.length
  const done = papers.value.filter((p) => !!p.done).length
  const todo = total - done
  return t('paperList.paperCount', { todo, done })
})

const showDonePapersText = computed(() => {
  return showDonePapers.value ? t('paperList.showTodo') : t('paperList.showDone')
})

function formatPaperName(paper: { exam_code?: string | null; filename?: string }): string {
  const base = paper?.exam_code || paper?.filename || ''
  return String(base).trim().replace(/\.pdf$/i, '')
}

function getDisplayNo(paper: { display_no?: number | null; id: number }): string {
  return paper.display_no != null ? String(paper.display_no) : String(paper.id)
}

function openPaper(paperId: number) {
  papersStore.openPaper(paperId)
  router.push({ name: 'mark', params: { paperId: String(paperId) } })
}

async function togglePaperDone(paper: { id: number; done: boolean }, event: Event) {
  event.stopPropagation()
  try {
    await papersApi.update(paper.id, { done: !paper.done })
    await papersStore.refreshPapers()
  } catch {
    // silently fail — refresh will restore correct state
  }
}

async function deletePaper(paper: { id: number }, event: Event) {
  event.stopPropagation()
  const deleted = await papersStore.deletePaper(paper.id)
  if (deleted && router.currentRoute.value.name === 'filter') {
    await filterStore.runFilter()
  }
}
</script>

<template>
  <div class="paper-list">
    <!-- Header with toggle -->
    <div class="paper-list-header">
      <span class="paper-list-title">{{ t('paperList.title') }}</span>
      <div class="paper-list-controls">
        <button class="btn-toggle" @click="papersStore.toggleShowDonePapers()">
          {{ showDonePapersText }}
        </button>
        <span class="paper-count-hint">{{ paperCountHint }}</span>
      </div>
    </div>

    <!-- Paper list -->
    <div class="paper-scroll">
      <!-- Empty state: no papers at all -->
      <div v-if="!papers.length" class="paper-empty">
        <svg class="paper-empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <span class="paper-empty-text">{{ t('paperList.empty') }}</span>
      </div>

      <!-- Empty state: filtered view empty -->
      <div v-else-if="!viewPapers.length" class="paper-empty">
        <span class="paper-empty-text">
          {{ normalizedSearchQuery ? t('paperList.noSearchResults') : (showDonePapers ? t('paperList.emptyDone') : t('paperList.emptyTodo')) }}
        </span>
      </div>

      <!-- Paper rows -->
      <div
        v-for="paper in viewPapers"
        :key="paper.id"
        class="paper-row"
        :class="{ active: paper.id === currentPaperId, done: paper.done }"
        @click="openPaper(paper.id)"
      >
        <div class="paper-row-main">
          <div class="paper-row-info">
            <div class="paper-row-name">
              <strong class="paper-no">{{ getDisplayNo(paper) }}</strong>
              <span class="paper-label">{{ formatPaperName(paper) || ('paper#' + paper.id) }}</span>
            </div>
          </div>
          <div class="paper-row-actions">
            <label class="paper-done-label" @click.stop>
              <input
                type="checkbox"
                :checked="paper.done"
                class="paper-done-checkbox"
                @change="togglePaperDone(paper, $event)"
              />
              <span class="paper-done-text">{{ t('paperList.done') }}</span>
            </label>
            <button
              class="paper-delete-btn"
              :title="t('paperList.delete')"
              @click="deletePaper(paper, $event)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="paper-row-meta">
          <span class="paper-meta-item">{{ t('paperList.pages') }}: {{ paper.page_count ?? '?' }}</span>
          <span class="paper-meta-item">{{ t('paperList.questions') }}: {{ paper.question_count ?? 0 }}</span>
          <span class="paper-meta-item">{{ t('paperList.answers') }}: {{ paper.answers_marked ?? 0 }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.paper-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.paper-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 4px;
  margin-bottom: 4px;
}

.paper-list-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.3px;
}

.paper-list-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-toggle {
  padding: 3px 10px;
  font-size: 11.5px;
  font-weight: 500;
  font-family: inherit;
  color: var(--text-accent);
  background: var(--accent-soft);
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
  white-space: nowrap;
}

.btn-toggle:hover {
  background: var(--accent);
  color: white;
}

.paper-count-hint {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

/* Scroll area */
.paper-scroll {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 2px;
}

/* Empty state */
.paper-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  text-align: center;
  gap: 10px;
}

.paper-empty-icon {
  color: var(--text-tertiary);
  opacity: 0.5;
}

.paper-empty-text {
  font-size: 13px;
  color: var(--text-tertiary);
  line-height: 1.5;
}

/* Paper row */
.paper-row {
  padding: 10px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
  position: relative;
}

.paper-row:hover {
  background: var(--bg-card-hover);
  border-color: var(--border-strong);
  box-shadow: var(--shadow-xs);
}

.paper-row.active {
  background: var(--bg-active);
  border-color: var(--border-accent);
  box-shadow: 0 0 0 1px var(--accent-soft);
}

.paper-row.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 20px;
  background: var(--accent);
  border-radius: 0 2px 2px 0;
}

.paper-row.done {
  opacity: 0.7;
}

.paper-row.done .paper-row-name {
  text-decoration: line-through;
  text-decoration-color: var(--text-tertiary);
}

/* Row layout */
.paper-row-main {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.paper-row-info {
  min-width: 0;
  flex: 1;
}

.paper-row-name {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.4;
}

.paper-no {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-accent);
  flex-shrink: 0;
}

.paper-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Actions */
.paper-row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.paper-done-label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
}

.paper-done-checkbox {
  width: 14px;
  height: 14px;
  accent-color: var(--accent);
  cursor: pointer;
}

.paper-done-text {
  font-size: 11px;
  color: var(--text-tertiary);
}

.paper-delete-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
  opacity: 0;
}

.paper-row:hover .paper-delete-btn {
  opacity: 1;
}

.paper-delete-btn:hover {
  background: rgba(255, 59, 48, 0.1);
  border-color: rgba(255, 59, 48, 0.2);
  color: var(--danger);
}

/* Meta */
.paper-row-meta {
  display: flex;
  gap: 12px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}

.paper-meta-item {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
}
</style>
