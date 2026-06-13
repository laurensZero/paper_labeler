<script setup lang="ts">
import { ref, computed, nextTick, onActivated, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useFilterStore } from '@/stores/filter'
import { useSectionsStore } from '@/stores/sections'
import { usePapersStore } from '@/stores/papers'
import { useExportStore } from '@/stores/export'
import { useDialogStore } from '@/stores/dialog'
import { questionsApi } from '@/api/endpoints'
import MultiSelect from '@/components/ui/MultiSelect.vue'
import PaperCascadeMultiSelect from '@/components/ui/PaperCascadeMultiSelect.vue'
import SectionCascadeSelect from '@/components/ui/SectionCascadeSelect.vue'
import MergedCropPreview from '@/components/ui/MergedCropPreview.vue'
import CropPreview from '@/components/ui/CropPreview.vue'
import FilmStrip from '@/components/ui/FilmStrip.vue'
import Inspector from '@/components/ui/Inspector.vue'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import { useDeferredQuestionPreview } from '@/composables/useDeferredQuestionPreview'

const { t } = useI18n()
const router = useRouter()
defineOptions({ name: 'FilterView' })

const filterStore = useFilterStore()
const sectionsStore = useSectionsStore()
const papersStore = usePapersStore()
const exportStore = useExportStore()
const dialogStore = useDialogStore()

const {
  filterSection,
  filterPaperMulti,
  filterYearMulti,
  filterSeasonMulti,
  filterFavOnly,
  filterResults,
  filterLoading,
  filterMultiSelect,
  selectedQuestionIds,
} = storeToRefs(filterStore)

/* ── Local state ── */
const selectedQuestion = ref<any>(null)
const inspectorCollapsed = ref(false)
let skipNextActivatedRefresh = true

/* ── Filter options ── */
const sectionCascadeOptions = computed(() => {
  const groups: { label: string; options: { value: string; label: string }[] }[] = [
    {
      label: t('filter.module'),
      options: [
        { value: '', label: t('filter.allModules') },
        { value: '__UNSET__', label: t('filter.unsectioned') },
      ],
    },
  ]
  for (const group of sectionsStore.sectionOptionGroupsAll) {
    groups.push({
      label: group.label,
      options: group.options.map((name) => ({
        value: name,
        label: sectionsStore.sectionLabelMap[name] || name,
      })),
    })
  }
  return groups
})

const paperCascadeOptions = computed(() => {
  const opts: { value: string; label: string }[] = []
  for (const p of papersStore.papers) {
    const name = papersStore.formatPaperName(p) || `#${p.id}`
    opts.push({ value: String(p.id), label: name })
  }
  return opts
})

const yearOptions = computed(() => {
  const years = new Set<string>()
  for (const p of papersStore.papers) {
    const text = (p.exam_code || '') + ' ' + (p.filename || '')
    const m = text.match(/_(m|s|w)(\d{2})_/i)
    if (m) years.add(m[2])
  }
  return Array.from(years).sort().map(y => ({ value: y, label: `20${y}` }))
})

const seasonOptions = computed(() => [
  { value: 'm', label: t('filter.spring') },
  { value: 's', label: t('filter.summer') },
  { value: 'w', label: t('filter.winter') },
])

const seasonShortLabels: Record<string, string> = { m: 'm', s: 's', w: 'w' }

/* ── Film strip data (all questions, independent of pagination) ── */
const allFilmStripItems = ref<any[]>([])
const questionCache = new Map<number, any>()

async function loadAllFilmStripItems() {
  try {
    const allQuestions: any[] = []
    let page = 1
    let totalPages = 1
    do {
      const data = await filterStore.requestFilterSearch({ page, pageSize: 500, idsOnly: false })
      const qs = Array.isArray(data?.questions) ? data.questions : []
      for (const q of qs) {
        allQuestions.push({
          id: q.id,
          question_no: q.question_no,
          is_favorite: q.is_favorite,
          section: q.section,
          sections: q.sections,
        })
        // Cache full question data
        questionCache.set(q.id, q)
      }
      totalPages = Number(data?.total_pages || 1)
      page += 1
    } while (page <= totalPages)
    allFilmStripItems.value = allQuestions
  } catch {
    // fallback to current page
    allFilmStripItems.value = (filterResults.value || []).map((q: any) => ({
      id: q.id,
      question_no: q.question_no,
      is_favorite: q.is_favorite,
      section: q.section,
      sections: q.sections,
    }))
  }
}

const activeQuestionId = computed(() => selectedQuestion.value?.id ?? null)

/* ── Question preview ── */
const {
  isQuestionPreviewReady,
  setPreviewTargetRef,
  onQuestionPreviewError,
  onQuestionPreviewLoaded,
} = useDeferredQuestionPreview({
  results: filterResults,
  getScrollContainer: () => null,
  onHeightMayChange: () => {},
})

function getQuestionPreviewUrl(q: any): string {
  if (q?.__previewFailed) return ''
  return String(q?.preview_image_url || '')
}

function getQuestionBoxes(q: any): any[] {
  return Array.isArray(q?.boxes) ? q.boxes : []
}

/* ── Answer state (local, not on question objects) ── */
const ansOpen = ref(false)
const ansLoaded = ref(false)
const ansLoading = ref(false)
const ansBoxes = ref<any[]>([])
const ansMeta = ref('')
const ansSectionRef = ref<HTMLElement | null>(null)

function scrollToAnswer() {
  // Wait for v-if element to be fully rendered
  requestAnimationFrame(() => {
    nextTick(() => {
      ansSectionRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  })
}

async function loadAnswer(questionId: number) {
  ansLoading.value = true
  ansMeta.value = '加载中...'
  try {
    const d = await questionsApi.getAnswer(questionId)
    const a = (d as any).answer
    if (!a) {
      ansMeta.value = '未标注'
      ansBoxes.value = []
    } else {
      const ab = a.boxes || []
      ansMeta.value = `MS #${a.ms_paper_id} · ${ab.length} 框`
      ansBoxes.value = ab.map((b: any) => ({ image_url: b.image_url, bbox: b.bbox }))
    }
    ansLoaded.value = true
  } catch {
    ansMeta.value = '加载失败'
    ansBoxes.value = []
  } finally {
    ansLoading.value = false
  }
}

function resetAnswerState() {
  ansOpen.value = false
  ansLoaded.value = false
  ansLoading.value = false
  ansBoxes.value = []
  ansMeta.value = ''
}

/* ── Quick edit state ── */
const editMode = ref(false)
const editSections = ref<string[]>([])
const editNotes = ref('')

function enterEditMode() {
  if (!selectedQuestion.value) return
  editSections.value = (selectedQuestion.value.sections && Array.isArray(selectedQuestion.value.sections))
    ? [...selectedQuestion.value.sections]
    : (selectedQuestion.value.section ? [selectedQuestion.value.section] : [])
  editNotes.value = selectedQuestion.value.notes || ''
  editMode.value = true
}

function cancelEdit() {
  editMode.value = false
}

async function saveEdit() {
  if (!selectedQuestion.value) return
  try {
    await questionsApi.update(selectedQuestion.value.id, {
      sections: editSections.value,
      notes: editNotes.value,
    } as any)
    // Update local state
    selectedQuestion.value.sections = [...editSections.value]
    selectedQuestion.value.notes = editNotes.value
    editMode.value = false
    // Refresh filter results to reflect changes
    filterStore.markQuestionDatasetChanged()
    await filterStore.runFilter()
  } catch {
    // error handled by API
  }
}

function goToMarkView() {
  if (!selectedQuestion.value?.paper_id) return
  editMode.value = false
  filterStore.editQuestionBoxesFromFilter(selectedQuestion.value)
  router.push({ name: 'mark', params: { paperId: String(selectedQuestion.value.paper_id) } })
}

/* ── Change handlers ── */
function onSectionChange(v: string) {
  filterSection.value = v
  filterStore.onFilterChange()
}

function onPaperMultiChange(v: string[]) {
  filterPaperMulti.value = Array.isArray(v) ? v : []
  filterStore.onFilterChange()
}

function onYearMultiChange(v: string[]) {
  filterYearMulti.value = Array.isArray(v) ? v : []
  filterStore.onFilterChange()
}

function onSeasonMultiChange(v: string[]) {
  filterSeasonMulti.value = Array.isArray(v) ? v : []
  filterStore.onFilterChange()
}

function onFavOnlyChange(value: boolean) {
  filterFavOnly.value = value
  filterStore.onFilterChange()
}

function onBatchFavorite() {
  filterStore.batchUpdateSelected(undefined, true)
}

/* ── Question selection ── */
function selectQuestion(q: any) {
  if (selectedQuestion.value?.id === q?.id) return
  selectedQuestion.value = q
  resetAnswerState()
  editMode.value = false
}

function selectQuestionById(id: number) {
  // First check current page
  const q = filterResults.value.find((r: any) => r.id === id)
  if (q) {
    selectQuestion(q)
    preloadAdjacent(id)
    return
  }
  // Then check cache
  const cached = questionCache.get(id)
  if (cached) {
    if (cached.__ansOpen === undefined) cached.__ansOpen = false
    if (cached.__ansLoaded === undefined) cached.__ansLoaded = false
    if (cached.__ansBoxes === undefined) cached.__ansBoxes = []
    if (cached.__ansMeta === undefined) cached.__ansMeta = ''
    if (cached.__editSections === undefined) cached.__editSections = cached.sections || (cached.section ? [cached.section] : [])
    if (cached.__editNotes === undefined) cached.__editNotes = cached.notes || ''
    selectQuestion(cached)
    preloadAdjacent(id)
  }
}

/* ── Preload adjacent question images ── */
const _preloaded = new Set<number>()

function preloadAdjacent(currentId: number) {
  const items = allFilmStripItems.value
  const idx = items.findIndex((item: any) => item.id === currentId)
  if (idx < 0) return
  const range = 3
  for (let i = idx - range; i <= idx + range; i++) {
    if (i === idx || i < 0 || i >= items.length) continue
    const neighborId = items[i].id
    if (_preloaded.has(neighborId)) continue
    _preloaded.add(neighborId)
    const cached = questionCache.get(neighborId)
    if (!cached) continue
    const url = cached.preview_image_url || cached.boxes?.[0]?.image_url
    if (url) {
      const img = new Image()
      img.src = url
    }
  }
}

function onToggleFavorite() {
  if (!selectedQuestion.value) return
  // Keep the same object reference so mutations (__ansOpen etc.) stay linked
  filterStore.toggleFavorite(selectedQuestion.value)
  // toggleFavorite already mutates the object in-place via filterResults
}

function onEdit() {
  enterEditMode()
}

async function onEditAnswer() {
  if (!selectedQuestion.value?.paper_id) return
  await filterStore.editAnswerBoxesFromFilter(selectedQuestion.value)
  await router.push({ name: 'answer', params: { paperId: String(selectedQuestion.value.paper_id) } })
}

async function onLocate() {
  if (!selectedQuestion.value) return
  await filterStore.jumpToQuestionFromFilter(selectedQuestion.value)
  await router.push({ name: 'mark', params: { paperId: String(selectedQuestion.value.paper_id) } })
}

async function onDelete() {
  if (!selectedQuestion.value) return
  if (!await dialogStore.confirm(t('filter.confirmDelete', { id: selectedQuestion.value.id }), {
    title: t('filter.deleteTitle'),
    confirmText: t('dialog.delete'),
    danger: true,
  })) return
  try {
    await questionsApi.delete(selectedQuestion.value.id)
    const idx = filterResults.value.findIndex((r: any) => r.id === selectedQuestion.value.id)
    selectedQuestion.value = null
    filterStore.markQuestionDatasetChanged()
    await filterStore.runFilter()
    // Select next question
    if (filterResults.value.length) {
      const nextIdx = Math.min(idx, filterResults.value.length - 1)
      selectQuestion(filterResults.value[nextIdx])
    }
  } catch {
    // error handled by store
  }
}

async function onToggleAnswer() {
  if (!selectedQuestion.value) return
  if (ansOpen.value) {
    ansOpen.value = false
    return
  }
  ansOpen.value = true
  if (!ansLoaded.value) {
    await loadAnswer(selectedQuestion.value.id)
  }
  scrollToAnswer()
}

/* ── Keyboard navigation ── */
function onKeyDown(e: KeyboardEvent) {
  // Don't intercept if typing in input
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return

  if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault()
    navigateQuestion(1)
  } else if (e.key === 'k' || e.key === 'ArrowUp') {
    e.preventDefault()
    navigateQuestion(-1)
  } else if (e.key === 'f') {
    e.preventDefault()
    onToggleFavorite()
  }
}

function navigateQuestion(delta: number) {
  const items = allFilmStripItems.value
  if (!items.length) return
  if (!selectedQuestion.value) {
    selectQuestionById(items[0].id)
    return
  }
  const idx = items.findIndex((item: any) => item.id === selectedQuestion.value.id)
  const nextIdx = Math.max(0, Math.min(items.length - 1, idx + delta))
  selectQuestionById(items[nextIdx].id)
}

/* ── Lifecycle ── */
async function refreshFilterOnEnter(options: { silent?: boolean } = {}) {
  await Promise.all([
    sectionsStore.refreshSectionDefs(),
    papersStore.refreshPapers({ silent: options.silent !== false }),
  ])
  await filterStore.runFilter()
  loadAllFilmStripItems()
}

onMounted(async () => {
  filterStore.loadFilterSettings()
  filterStore.loadFilterPresets()
  await refreshFilterOnEnter({ silent: false })
  document.addEventListener('keydown', onKeyDown)
})

onActivated(() => {
  if (skipNextActivatedRefresh) {
    skipNextActivatedRefresh = false
    return
  }
  if (filterStore.consumeSkipNextEnterRefresh()) return
  refreshFilterOnEnter({ silent: true }).catch(() => {})
})

import { onBeforeUnmount } from 'vue'
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeyDown)
})

/* ── Auto-select first result ── */
watch(filterResults, (results) => {
  if (results?.length && !selectedQuestion.value) {
    selectQuestion(results[0])
  } else if (!results?.length) {
    selectedQuestion.value = null
  }
  // Reload filmstrip (debounced)
  clearTimeout(_filmStripTimer)
  _filmStripTimer = setTimeout(loadAllFilmStripItems, 300)
}, { flush: 'post' })

let _filmStripTimer: ReturnType<typeof setTimeout> | undefined
</script>

<template>
  <div class="ws">
    <!-- ── Top Toolbar ── -->
    <div class="ws-toolbar">
      <div class="ws-toolbar-main">
        <SectionCascadeSelect
          :modelValue="filterSection"
          :options="sectionCascadeOptions"
          :placeholder="t('filter.allModules')"
          class="ws-toolbar-select"
          @update:model-value="onSectionChange"
        />
        <PaperCascadeMultiSelect
          :model-value="filterPaperMulti"
          :options="paperCascadeOptions"
          :placeholder="t('filter.allPapers')"
          class="ws-toolbar-select"
          @update:model-value="onPaperMultiChange"
        />
        <MultiSelect
          :model-value="filterYearMulti"
          :options="yearOptions"
          :placeholder="t('filter.allYears')"
          display-mode="values"
          :show-all-when-all-selected="true"
          class="ws-toolbar-select ws-toolbar-select--sm"
          @update:model-value="onYearMultiChange"
        />
        <MultiSelect
          :model-value="filterSeasonMulti"
          :options="seasonOptions"
          :placeholder="t('filter.allSeasons')"
          display-mode="values"
          :short-label-map="seasonShortLabels"
          :show-all-when-all-selected="true"
          class="ws-toolbar-select ws-toolbar-select--sm"
          @update:model-value="onSeasonMultiChange"
        />
        <div class="ws-toolbar-check">
          <AppCheckbox
            :model-value="filterFavOnly"
            @update:model-value="onFavOnlyChange"
          />
          <span>{{ t('filter.favOnly') }}</span>
        </div>
      </div>
      <div class="ws-toolbar-right">
        <button class="ws-toolbar-btn" :class="{ active: filterMultiSelect }" @click="filterStore.toggleFilterMultiSelect()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          <span>{{ filterMultiSelect ? t('filter.multiSelectActive', { count: selectedQuestionIds.size }) : t('filter.multiSelect') }}</span>
        </button>
        <button v-if="filterMultiSelect && selectedQuestionIds.size" class="ws-toolbar-btn" @click="onBatchFavorite">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></svg>
          <span>{{ t('filter.batchFavorite') }}</span>
        </button>
        <button class="ws-toolbar-btn" @click="exportStore.exportFilterPdf()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>{{ t('filter.exportPdf') }}</span>
        </button>
      </div>
    </div>

    <!-- ── Main Content ── -->
    <div class="ws-main">
      <!-- Question hero -->
      <div class="ws-content">
        <!-- Loading -->
        <div v-if="filterLoading" class="ws-loading">
          <div class="ws-loading-skeleton"></div>
        </div>

        <!-- Empty -->
        <div v-else-if="!filterResults.length" class="ws-empty">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <span>{{ t('filter.noResults') }}</span>
        </div>

        <!-- Question image -->
        <div v-else-if="selectedQuestion" class="ws-question">
          <div
            :ref="(el) => setPreviewTargetRef(selectedQuestion.id, el as Element | null)"
            class="ws-question-img"
          >
            <img
              v-if="isQuestionPreviewReady(selectedQuestion) && getQuestionPreviewUrl(selectedQuestion)"
              class="ws-question-preview"
              :src="getQuestionPreviewUrl(selectedQuestion)"
              loading="lazy"
              decoding="async"
              alt=""
              @load="onQuestionPreviewLoaded"
              @error="onQuestionPreviewError(selectedQuestion)"
            />
            <MergedCropPreview v-else-if="isQuestionPreviewReady(selectedQuestion) && getQuestionBoxes(selectedQuestion).length" :boxes="getQuestionBoxes(selectedQuestion)" />
            <div v-else class="ws-question-placeholder">
              <div class="ws-question-skeleton"></div>
            </div>
          </div>

          <!-- Answer section -->
          <div v-if="ansOpen" ref="ansSectionRef" class="ws-answer">
            <div class="ws-answer-header">
              <span>{{ t('filter.answerHeader') }}</span>
            </div>
            <div v-if="ansBoxes.length" class="ws-answer-boxes">
              <div v-for="(b, idx) in ansBoxes" :key="idx" class="ws-answer-box">
                <CropPreview :image-url="b.image_url ?? ''" :bbox="b.bbox" />
              </div>
            </div>
            <div v-else class="ws-answer-empty">
              {{ ansLoading ? t('filter.answerLoadingStatus') : (ansLoaded ? t('filter.answerNotMarked') : '') }}
            </div>
          </div>
        </div>

        <!-- No selection -->
        <div v-else class="ws-empty">
          <span>{{ t('filter.selectQuestion') }}</span>
        </div>
      </div>

      <!-- Inspector -->
      <Inspector
        :question="selectedQuestion"
        :collapsed="inspectorCollapsed"
        :ans-open="ansOpen"
        :ans-loaded="ansLoaded"
        :ans-box-count="ansBoxes.length"
        :edit-mode="editMode"
        :edit-sections="editSections"
        :edit-notes="editNotes"
        :section-options="sectionCascadeOptions"
        @toggle-collapse="inspectorCollapsed = !inspectorCollapsed"
        @toggle-favorite="onToggleFavorite"
        @edit="onEdit"
        @edit-answer="onEditAnswer"
        @locate="onLocate"
        @delete="onDelete"
        @toggle-answer="onToggleAnswer"
        @cancel-edit="cancelEdit"
        @save-edit="saveEdit"
        @go-to-mark="goToMarkView"
        @update:editSections="editSections = $event"
        @update:editNotes="editNotes = $event"
      />
    </div>

    <!-- ── Film Strip (all questions, horizontal scroll) ── -->
    <div class="ws-filmstrip">
      <span class="ws-filmstrip-count">{{ t('filter.questionCount', { count: allFilmStripItems.length }) }}</span>
      <FilmStrip
        :items="allFilmStripItems"
        :active-id="activeQuestionId"
        :multi-select="filterMultiSelect"
        :selected-ids="selectedQuestionIds"
        @select="selectQuestionById"
        @toggle-selection="(id) => filterStore.toggleFilterItemSelection({ id })"
      />
    </div>
  </div>
</template>

<style scoped>
.ws {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  border-radius: 16px;
  gap: 1px;
}

/* ══════════════════════════════════════
   TOP TOOLBAR — single row, 56px max
   ══════════════════════════════════════ */
.ws-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  min-height: 44px;
  border-radius: 16px;
}

.ws-toolbar-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
}

.ws-toolbar-select {
  flex-shrink: 0;
  min-width: 110px;
  max-width: 180px;
}

.ws-toolbar-select--sm {
  min-width: 80px;
  max-width: 110px;
}

.ws-toolbar-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
}

.ws-toolbar-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.ws-toolbar-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  border-radius: 8px;
  cursor: pointer;
  transition: all 100ms ease;
}

.ws-toolbar-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.ws-toolbar-btn.active {
  background: var(--accent-soft);
  border-color: var(--border-accent);
  color: var(--text-accent);
}

/* ══════════════════════════════════════
   MAIN CONTENT
   ══════════════════════════════════════ */
.ws-main {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* Question hero */
.ws-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 16px 20px;
  overflow-y: auto;
}

.ws-question {
  display: flex;
  flex-direction: column;
  max-width: 100%;
  width: 100%;
  align-items: center;
}

.ws-question-img {
  max-width: 100%;
  border-radius: 20px;
  overflow: hidden;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.ws-question-preview {
  display: block;
  width: 100%;
  height: auto;
  max-height: none;
  object-fit: contain;
  object-position: top center;
}

.ws-question-placeholder {
  width: 100%;
  min-height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ws-question-skeleton {
  width: 80%;
  height: 200px;
  border-radius: var(--radius-md);
  background: linear-gradient(90deg, var(--bg-input) 25%, var(--bg-hover) 50%, var(--bg-input) 75%);
  background-size: 200% 100%;
  animation: ws-shimmer 1.5s ease-in-out infinite;
}

@keyframes ws-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* Answer */
.ws-answer {
  margin-top: 12px;
  padding: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 16px;
  width: 100%;
  max-width: 1000px;
  flex-shrink: 0;
}

.ws-answer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.ws-answer-meta {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-tertiary);
}

.ws-answer-boxes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ws-answer-box {
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg-input);
}

/* Loading / Empty */
.ws-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

.ws-loading-skeleton {
  width: 60%;
  max-width: 500px;
  height: 300px;
  border-radius: var(--radius-lg);
  background: linear-gradient(90deg, var(--bg-input) 25%, var(--bg-hover) 50%, var(--bg-input) 75%);
  background-size: 200% 100%;
  animation: ws-shimmer 1.5s ease-in-out infinite;
}

.ws-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-tertiary);
  font-size: 14px;
}

/* ══════════════════════════════════════
   FILM STRIP
   ══════════════════════════════════════ */
.ws-filmstrip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 8px;
  background: var(--bg-elevated);
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  min-height: 56px;
  max-height: 80px;
  border-radius: 16px;
}

.ws-filmstrip-nav {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  padding: 0 4px;
}

.ws-filmstrip-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 8px;
  transition: all 100ms ease;
}

.ws-filmstrip-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.ws-filmstrip-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.ws-filmstrip-page {
  font-size: 11px;
  color: var(--text-tertiary);
  padding: 0 6px;
  white-space: nowrap;
}

.ws-filmstrip-count {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
  flex-shrink: 0;
  padding: 0 4px;
}

/* ══════════════════════════════════════
   RESPONSIVE
   ══════════════════════════════════════ */
@media (max-width: 640px) {
  .ws {
    height: 100%;
  }

  .ws-main {
    flex-direction: column;
  }

  .ws-content {
    min-height: 50vh;
  }

  .ws-toolbar-main {
    flex-wrap: wrap;
  }

  .ws-toolbar-select {
    min-width: 90px;
  }
}
</style>
