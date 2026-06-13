<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { usePapersStore } from '@/stores/papers'
import { useFilterStore } from '@/stores/filter'
import { papersApi } from '@/api/endpoints'
import AppCheckbox from './ui/AppCheckbox.vue'

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

const paperCountHint = computed(() => {
  const total = papers.value.length
  const done = papers.value.filter((p) => !!p.done).length
  const todo = total - done
  return t('paperList.paperCount', { todo, done })
})

function formatPaperName(paper: { exam_code?: string | null; filename?: string }): string {
  const base = paper?.exam_code || paper?.filename || ''
  return String(base).trim().replace(/\.pdf$/i, '')
}

function openPaper(paperId: number) {
  papersStore.openPaper(paperId)
  router.push({ name: 'mark', params: { paperId: String(paperId) } })
}

async function togglePaperDone(paper: { id: number; done: boolean }, newValue: boolean) {
  try {
    await papersApi.update(paper.id, { done: newValue })
    await papersStore.refreshPapers()
  } catch {
    // silently fail
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
    <!-- Header -->
    <div class="pl-header">
      <span class="pl-header-title">{{ t('paperList.title') }}</span>
      <div class="pl-header-right">
        <span class="pl-header-count">{{ paperCountHint }}</span>
        <button class="pl-header-btn" @click="papersStore.toggleShowDonePapers()" :title="papersStore.showDonePapers ? t('paperList.showTodo') : t('paperList.showDone')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
      </div>
    </div>

    <!-- List -->
    <div class="pl-scroll">
      <div v-if="!papers.length" class="pl-empty">
        <span>{{ t('paperList.empty') }}</span>
      </div>

      <div v-else-if="!viewPapers.length" class="pl-empty">
        <span>{{ normalizedSearchQuery ? t('paperList.noSearchResults') : t('paperList.emptyTodo') }}</span>
      </div>

      <div
        v-for="paper in viewPapers"
        :key="paper.id"
        class="pl-item"
        :class="{ 'pl-item--active': paper.id === currentPaperId, 'pl-item--done': paper.done }"
        @click="openPaper(paper.id)"
      >
        <div class="pl-item-main">
          <span class="pl-item-name">{{ formatPaperName(paper) || ('paper#' + paper.id) }}</span>
          <div class="pl-item-actions">
            <div class="pl-item-done" @click.stop>
              <AppCheckbox
                :model-value="paper.done"
                @update:model-value="togglePaperDone(paper, $event)"
              />
            </div>
            <button class="pl-item-del" :title="t('paperList.delete')" @click="deletePaper(paper, $event)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="pl-item-meta">
          <span>{{ paper.question_count ?? 0 }} {{ t('paperList.questions') }}</span>
          <span>{{ paper.page_count ?? '?' }} {{ t('paperList.pages') }}</span>
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

/* Header */
.pl-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 4px;
  margin-bottom: 4px;
}

.pl-header-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
}

.pl-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pl-header-count {
  font-size: 11px;
  color: var(--text-tertiary);
}

.pl-header-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  border-radius: var(--radius-xs);
  transition: all 100ms ease;
}

.pl-header-btn:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

/* Scroll */
.pl-scroll {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

/* Empty */
.pl-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  color: var(--text-tertiary);
  font-size: 12px;
}

/* Item */
.pl-item {
  padding: 8px 10px;
  cursor: pointer;
  transition: background 80ms ease;
  position: relative;
  border-radius: var(--radius-xs);
  margin: 0 2px;
}

.pl-item:hover {
  background: var(--bg-hover);
}

.pl-item--active {
  background: var(--accent-soft);
}

.pl-item--active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: var(--accent);
  border-radius: 1px;
}

.pl-item--done {
  opacity: 0.5;
}

.pl-item--done .pl-item-name {
  text-decoration: line-through;
  text-decoration-color: var(--text-tertiary);
}

.pl-item-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.pl-item-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.pl-item-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 100ms ease;
}

.pl-item:hover .pl-item-actions {
  opacity: 1;
}

.pl-item-done {
  display: flex;
  align-items: center;
}

.pl-item-del {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  border-radius: var(--radius-xs);
  transition: all 100ms ease;
}

.pl-item-del:hover {
  background: rgba(239, 68, 68, 0.08);
  color: var(--danger);
}

.pl-item-meta {
  display: flex;
  gap: 8px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-tertiary);
}
</style>
