<script setup lang="ts">
import { ref, computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useFilterStore } from '@/stores/filter'
import { useSectionsStore } from '@/stores/sections'
import { usePapersStore } from '@/stores/papers'
import { useExportStore } from '@/stores/export'
import { useDialogStore } from '@/stores/dialog'
import { useSettingsStore } from '@/stores/settings'
import { questionsApi } from '@/api/endpoints'
import SimpleSelect from '@/components/ui/SimpleSelect.vue'
import MultiSelect from '@/components/ui/MultiSelect.vue'
import PaperCascadeMultiSelect from '@/components/ui/PaperCascadeMultiSelect.vue'
import SectionCascadeSelect from '@/components/ui/SectionCascadeSelect.vue'
import SectionTagEditor from '@/components/ui/SectionTagEditor.vue'
import CropPreview from '@/components/ui/CropPreview.vue'
import MergedCropPreview from '@/components/ui/MergedCropPreview.vue'
import { useDeferredQuestionPreview } from '@/composables/useDeferredQuestionPreview'
import { useFilterAnswerPanels } from '@/composables/useFilterAnswerPanels'
import { useFilterVirtualList } from '@/composables/useFilterVirtualList'

const { t } = useI18n()
const router = useRouter()
defineOptions({ name: 'FilterView' })

const filterStore = useFilterStore()
const sectionsStore = useSectionsStore()
const papersStore = usePapersStore()
const exportStore = useExportStore()
const dialogStore = useDialogStore()
const settingsStore = useSettingsStore()

const {
  filterSection,
  filterPaperMulti,
  filterYearMulti,
  filterSeasonMulti,
  filterFavOnly,
  filterExcludeMultiSection,
  filterPage,
  filterPageSize,
  filterTotal,
  filterTotalPages,
  filterResults,
  filterLoading,
  filterMultiSelect,
  selectedQuestionIds,
  filterPresets,
  filterPresetNameInput,
  filterPresetSelected,
  filterBatchSection,
  filterQuestionNoInput,
  filterJumpPageInput,
} = storeToRefs(filterStore)

// sectionDisplayName is a function, access via sectionsStore directly

/* ── Local state ── */
const advancedOpen = ref(false)
let skipNextActivatedRefresh = true
let enterRefreshSeq = 0

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

const paperOptions = computed(() => {
  const opts: { value: string; label: string }[] = []
  for (const p of papersStore.papers) {
    const name = papersStore.formatPaperName(p) || `#${p.id}`
    opts.push({ value: String(p.id), label: name })
  }
  return opts
})

const paperCascadeOptions = computed(() => paperOptions.value)

const yearOptions = computed(() => {
  const years = new Set<string>()
  for (const p of papersStore.papers) {
    const text = (p.exam_code || '') + ' ' + (p.filename || '')
    const m = text.match(/_(m|s|w)(\d{2})_/i)
    if (m) years.add(m[2])
  }
  return [
    ...Array.from(years).sort().map(y => ({ value: y, label: `20${y}` })),
  ]
})

const seasonOptions = computed(() => [
  { value: 'm', label: t('filter.spring') },
  { value: 's', label: t('filter.summer') },
  { value: 'w', label: t('filter.winter') },
])

const seasonShortLabels: Record<string, string> = {
  m: 'm',
  s: 's',
  w: 'w',
}

const batchSectionOptions = computed(() => {
  const opts: { value: string; label: string }[] = [
    { value: '', label: t('filter.batchChangeSectionPlaceholder') },
  ]
  for (const group of sectionsStore.sectionOptionGroupsAll) {
    for (const name of group.options) {
      const label = sectionsStore.sectionLabelMap[name] || name
      opts.push({ value: name, label: `${group.label} / ${label}` })
    }
  }
  return opts
})

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

function onFavOnlyChange(e: Event) {
  filterFavOnly.value = (e.target as HTMLInputElement).checked
  filterStore.onFilterChange()
}

function onExcludeMultiSectionChange(e: Event) {
  filterExcludeMultiSection.value = (e.target as HTMLInputElement).checked
  filterStore.onFilterChange()
}

function onPresetSelectChange(v: string) {
  filterPresetSelected.value = v
  filterStore.applyFilterPreset(v)
}

/* ── Display helpers ── */
const pageCountInfo = computed(() =>
  t('filter.pageCountInfo', {
    page: filterPage.value,
    total: filterTotalPages.value,
    current: filterResults.value.length,
    count: filterTotal.value,
  })
)

const selectedCount = computed(() => selectedQuestionIds.value.size)
const virtualThresholdValue = computed(() => {
  const n = Number(settingsStore.filterVirtualThreshold)
  return Number.isFinite(n) ? Math.max(1, Math.min(200, Math.floor(n))) : 24
})
const virtualOverscanPxValue = computed(() => {
  const n = Number(settingsStore.filterVirtualOverscanPx)
  return Number.isFinite(n) ? Math.max(0, Math.min(5000, Math.floor(n))) : 900
})
function getFilterScrollContainerEl(): HTMLElement | null {
  const container = filterStore.getFilterScrollContainer?.()
  return container instanceof HTMLElement ? container : null
}

const {
  setFilterResultsRootRef,
  setFilterQItemRef,
  isVirtualizingFilterResults,
  virtualFilterRows,
  virtualFilterContainerStyle,
  loadVirtualHeightsCache,
  queueVirtualRefresh,
  syncVirtualRuntime: syncFilterVirtualRuntime,
  startVirtualListRuntime: startFilterVirtualListRuntime,
  stopVirtualListRuntime: stopFilterVirtualListRuntime,
  disposeVirtualList,
  virtualFilterItemStyle,
} = useFilterVirtualList({
  results: filterResults,
  threshold: virtualThresholdValue,
  overscanPx: virtualOverscanPxValue,
  getScrollContainer: getFilterScrollContainerEl,
  registerScroller: (fn) => filterStore.setFilterVirtualScroller(fn),
})

const {
  isQuestionPreviewReady,
  queuePreviewObserverRefresh,
  setPreviewTargetRef,
  prunePreviewStateForResults,
  onQuestionPreviewError,
  onQuestionPreviewLoaded,
  pauseDeferredQuestionPreview,
  disposeDeferredQuestionPreview,
} = useDeferredQuestionPreview({
  results: filterResults,
  getScrollContainer: getFilterScrollContainerEl,
  onHeightMayChange: onCardHeightMayChange,
})

function getPaperLabel(q: any): string {
  if (q.paper?.exam_code) return q.paper.exam_code
  if (q.paper?.filename) return q.paper.filename
  return `paper#${q.paper_id ?? '?'}`
}

function getSectionNames(q: any): string[] {
  return q.sections ?? (q.section ? [q.section] : [])
}

function getQuestionBoxes(q: any): any[] {
  return Array.isArray(q?.boxes) ? q.boxes : []
}

function getQuestionPreviewUrl(q: any): string {
  if (q?.__previewFailed) return ''
  return String(q?.preview_image_url || '')
}

/* ── Advanced toggle ── */
function toggleAdvanced() {
  advancedOpen.value = !advancedOpen.value
  queueVirtualRefresh()
}

function onCardHeightMayChange() {
  queueVirtualRefresh()
}

const {
  toggleFilterAnswer,
  onShowAllAnswers,
  onHideAllAnswers,
} = useFilterAnswerPanels({
  results: filterResults,
  onHeightMayChange: onCardHeightMayChange,
})

/* ── Jump to question ── */
async function onJumpToQuestionNo() {
  const raw = String(filterQuestionNoInput.value || '').trim()
  if (!raw) return
  try {
    const selectedPaperIds = filterPaperMulti.value.length
      ? filterPaperMulti.value.map(Number).filter(Number.isFinite)
      : []
    const localNo = Number(raw)
    if (selectedPaperIds.length === 1 && Number.isInteger(localNo) && localNo > 0) {
      const paperResp = await questionsApi.listForPaper(selectedPaperIds[0])
      const rows = Array.isArray((paperResp as any)?.questions) ? [...(paperResp as any).questions] : []
      rows.sort((a: any, b: any) => {
        const aBox = Array.isArray(a?.boxes) && a.boxes.length ? a.boxes[0] : null
        const bBox = Array.isArray(b?.boxes) && b.boxes.length ? b.boxes[0] : null
        const ap = Number(aBox?.page || 0)
        const bp = Number(bBox?.page || 0)
        if (ap !== bp) return ap - bp
        const ay = Number(aBox?.bbox?.[1] || 0)
        const by = Number(bBox?.bbox?.[1] || 0)
        if (ay !== by) return ay - by
        return Number(a?.id || 0) - Number(b?.id || 0)
      })
      const target = rows[localNo - 1]
      if (!target?.id) return
      let ids = await filterStore.collectAllFilteredQuestionIds()
      if (!ids.includes(Number(target.id))) {
        filterSection.value = ''
        filterYearMulti.value = []
        filterSeasonMulti.value = []
        filterFavOnly.value = false
        filterExcludeMultiSection.value = false
        ids = await filterStore.collectAllFilteredQuestionIds()
      }
      const idx = ids.indexOf(Number(target.id))
      if (idx < 0) return
      const page = Math.floor(idx / Math.max(1, filterPageSize.value)) + 1
      filterPage.value = page
      await filterStore.runFilter()
      filterStore.scrollToFilterQuestion(target.id)
      return
    }

    const lookup = await questionsApi.search({
      questionNo: raw,
      page: 1,
      pageSize: 1,
    })
    const q = (lookup as any)?.questions?.[0]
    if (!q || q.id == null) {
      return
    }
    const ids = await filterStore.collectAllFilteredQuestionIds()
    let idx = ids.indexOf(q.id)
    if (idx < 0) {
      filterSection.value = ''
      filterPaperMulti.value = []
      filterYearMulti.value = []
      filterSeasonMulti.value = []
      filterFavOnly.value = false
      filterExcludeMultiSection.value = false
      const allIds = await filterStore.collectAllFilteredQuestionIds()
      idx = allIds.indexOf(q.id)
      if (idx < 0) return
    }
    const page = Math.floor(idx / Math.max(1, filterPageSize.value)) + 1
    filterPage.value = page
    await filterStore.runFilter()
    filterStore.scrollToFilterQuestion(q.id)
  } catch {
    // ignore
  }
}

function onJumpToQuestionKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') onJumpToQuestionNo()
}

/* ── Jump to page ── */
function onJumpToPage() {
  const raw = filterJumpPageInput.value
  const n = parseInt(String(raw), 10)
  if (!Number.isFinite(n) || n < 1) return
  filterStore.setFilterPage(n)
}

function onJumpToPageKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') onJumpToPage()
}

/* ── Export PDF ── */
async function onExportPdf() {
  await exportStore.exportFilterPdf()
}

/* ── Card event handlers ── */
function onToggleFavorite(q: any) {
  filterStore.toggleFavorite(q)
}

function onToggleSelection(q: any, checked: boolean) {
  filterStore.toggleFilterSelection({ id: q.id }, checked)
}

function onToggleItem(q: any, e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target?.closest?.('button') || target?.closest?.('a') || target?.closest?.('input') || target?.closest?.('textarea') || target?.closest?.('select')) return
  filterStore.toggleFilterItemSelection({ id: q.id })
}

async function onJumpToQuestion(q: any) {
  if (!q?.paper_id) return
  await filterStore.jumpToQuestionFromFilter(q)
  await router.push({ name: 'mark', params: { paperId: String(q.paper_id) } })
}

async function onEditQuestionBoxes(q: any) {
  if (!q?.paper_id) return
  await filterStore.editQuestionBoxesFromFilter(q)
  await router.push({ name: 'mark', params: { paperId: String(q.paper_id) } })
}

async function onEditAnswerBoxes(q: any) {
  if (!q?.paper_id) return
  await filterStore.editAnswerBoxesFromFilter(q)
  await router.push({ name: 'answer', params: { paperId: String(q.paper_id) } })
}

function onToggleEditPanel(q: any) {
  q.__editOpen = !q.__editOpen
  if (q.__editOpen) q.__notesOpen = false
  onCardHeightMayChange()
}

function onToggleNotesPanel(q: any) {
  q.__notesOpen = !q.__notesOpen
  onCardHeightMayChange()
}

async function onFilterSectionsChange(q: any, sections: string[]) {
  q.__editSections = Array.isArray(sections) ? sections : []
  await filterStore.saveFilterQuestionMeta(q, q.__editSections, q.__editNotes)
  onCardHeightMayChange()
}

async function onFilterNotesBlur(q: any) {
  await filterStore.saveFilterQuestionMeta(q, q.__editSections, q.__editNotes)
}

async function onDeleteQuestion(q: any) {
  if (!await dialogStore.confirm(t('filter.confirmDelete', { id: q.id }), {
    title: t('filter.deleteTitle'),
    confirmText: t('dialog.delete'),
    danger: true,
  })) return
  try {
    await questionsApi.delete(q.id)
    filterStore.markQuestionDatasetChanged()
    await filterStore.runFilter()
  } catch {
    // error handled by store
  }
}

/* ── Batch section change ── */
async function onApplyBatchSection() {
  const section = filterBatchSection.value
  if (!section) return
  await filterStore.batchUpdateSelected([section])
  filterBatchSection.value = ''
}

function onToggleMultiSelect() {
  filterStore.toggleFilterMultiSelect()
  onCardHeightMayChange()
}

function syncVirtualRuntime() {
  syncFilterVirtualRuntime()
}

function startVirtualListRuntime() {
  startFilterVirtualListRuntime()
  queuePreviewObserverRefresh()
}

function stopVirtualListRuntime() {
  stopFilterVirtualListRuntime()
  pauseDeferredQuestionPreview()
}

async function refreshFilterOnEnter(options: { silent?: boolean } = {}) {
  const seq = ++enterRefreshSeq
  await Promise.all([
    sectionsStore.refreshSectionDefs(),
    papersStore.refreshPapers({ silent: options.silent !== false }),
  ])
  if (seq !== enterRefreshSeq) return
  await filterStore.runFilter()
  if (seq !== enterRefreshSeq) return
  await nextTick()
  syncVirtualRuntime()
}

/* ── Lifecycle ── */
onMounted(async () => {
  loadVirtualHeightsCache()
  settingsStore.loadFromStorage()
  filterStore.loadFilterSettings()
  filterStore.loadFilterPresets()
  await refreshFilterOnEnter({ silent: false })
  startVirtualListRuntime()
})

onActivated(() => {
  startVirtualListRuntime()
  if (skipNextActivatedRefresh) {
    skipNextActivatedRefresh = false
    return
  }
  if (filterStore.consumeSkipNextEnterRefresh()) {
    nextTick(() => queueVirtualRefresh()).catch(() => {})
    return
  }
  refreshFilterOnEnter({ silent: true }).catch(() => {})
})

onDeactivated(() => {
  stopVirtualListRuntime()
})

onBeforeUnmount(() => {
  disposeVirtualList()
  disposeDeferredQuestionPreview()
})

watch(filterResults, () => {
  prunePreviewStateForResults()
  nextTick(() => syncVirtualRuntime()).catch(() => {})
  nextTick(() => queuePreviewObserverRefresh()).catch(() => {})
}, { flush: 'post' })

watch([virtualThresholdValue, virtualOverscanPxValue, isVirtualizingFilterResults], () => {
  nextTick(() => syncVirtualRuntime()).catch(() => {})
}, { flush: 'post' })
</script>

<template>
  <div class="filter-view">
    <!-- ── Filter Criteria ── -->
    <div class="fv-sticky">
      <div class="fv-toolbar">
        <div class="fv-toolbar-main">
          <div class="fv-field fv-field--section">
            <span class="fv-label">{{ t('filter.module') }}</span>
            <SectionCascadeSelect
              :modelValue="filterSection"
              :options="sectionCascadeOptions"
              :placeholder="t('filter.allModules')"
              class="fv-select"
              @update:model-value="onSectionChange"
            />
          </div>
          <div class="fv-field fv-field--paper">
            <span class="fv-label">{{ t('filter.paper') }}</span>
            <PaperCascadeMultiSelect
              :model-value="filterPaperMulti"
              :options="paperCascadeOptions"
              :placeholder="t('filter.allPapers')"
              class="fv-select"
              @update:model-value="onPaperMultiChange"
            />
          </div>
          <div class="fv-field fv-field--compact">
            <span class="fv-label">{{ t('filter.year') }}</span>
            <MultiSelect
              :model-value="filterYearMulti"
              :options="yearOptions"
              :placeholder="t('filter.allYears')"
              display-mode="values"
              :show-all-when-all-selected="true"
              class="fv-select"
              @update:model-value="onYearMultiChange"
            />
          </div>
          <div class="fv-field fv-field--compact">
            <span class="fv-label">{{ t('filter.season') }}</span>
            <MultiSelect
              :model-value="filterSeasonMulti"
              :options="seasonOptions"
              :placeholder="t('filter.allSeasons')"
              display-mode="values"
              :short-label-map="seasonShortLabels"
              :show-all-when-all-selected="true"
              class="fv-select"
              @update:model-value="onSeasonMultiChange"
            />
          </div>
          <div class="fv-field fv-field--preset">
            <span class="fv-label">{{ t('filter.preset') }}</span>
            <SimpleSelect
              :model-value="filterPresetSelected"
              :options="[{ value: '', label: t('filter.presetNone') }, ...filterPresets.map(p => ({ value: p.name, label: p.name }))]"
              :placeholder="t('filter.presetNone')"
              class="fv-select"
              @change="onPresetSelectChange"
            />
          </div>
          <div class="fv-switches">
            <label class="fv-check-label">
              <input type="checkbox" :checked="filterFavOnly" @change="onFavOnlyChange" />
              <span>{{ t('filter.favOnly') }}</span>
            </label>
            <label class="fv-check-label">
              <input type="checkbox" :checked="filterExcludeMultiSection" @change="onExcludeMultiSectionChange" />
              <span>{{ t('filter.excludeMultiSection') }}</span>
            </label>
          </div>
        </div>

        <div class="fv-toolbar-actions">
          <div class="fv-action-group fv-action-group--right">
            <button class="btn btn-sm btn-primary" @click="onExportPdf">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {{ t('filter.exportPdf') }}
            </button>
            <button class="btn btn-sm" :class="{ 'btn-active': advancedOpen }" @click="toggleAdvanced">
              {{ advancedOpen ? t('filter.less') : t('filter.more') }}
            </button>
          </div>
        </div>
      </div>

      <!-- ── Advanced Options ── -->
      <Transition name="fv-slide">
        <div v-if="advancedOpen" class="fv-advanced">
          <div class="fv-advanced-row">
            <input
              type="text"
              class="fv-input"
              v-model="filterPresetNameInput"
              :placeholder="t('filter.presetNamePlaceholder')"
              style="width: 140px"
              @keydown.enter="filterStore.saveCurrentFilterPreset()"
            />
            <button class="btn btn-sm" @click="filterStore.saveCurrentFilterPreset()">{{ t('filter.savePreset') }}</button>
            <button class="btn btn-sm" :disabled="!filterPresetSelected" @click="filterStore.deleteFilterPreset(filterPresetSelected)">{{ t('filter.deletePreset') }}</button>
            <span class="fv-advanced-sep"></span>
            <button class="btn btn-sm" @click="onShowAllAnswers">{{ t('filter.showAllAnswers') }}</button>
            <button class="btn btn-sm" @click="onHideAllAnswers">{{ t('filter.hideAllAnswers') }}</button>
            <button class="btn btn-sm" :class="{ 'btn-active': filterMultiSelect }" @click="onToggleMultiSelect">
              {{ filterMultiSelect ? t('filter.cancelMultiSelect') : t('filter.multiSelect') }}
            </button>
            <span v-if="filterMultiSelect" class="fv-selected-count">
              {{ t('filter.selectedCount', { count: selectedCount }) }}
            </span>
            <template v-if="filterMultiSelect">
              <SimpleSelect
                v-model="filterBatchSection"
                :options="batchSectionOptions"
                :placeholder="t('filter.batchChangeSectionPlaceholder')"
                class="fv-select fv-select--batch"
              />
              <button class="btn btn-sm" :disabled="!filterBatchSection" @click="onApplyBatchSection">{{ t('filter.applyBatchSection') }}</button>
              <button class="btn btn-sm" @click="filterStore.batchUpdateSelected(undefined, true)">{{ t('filter.batchFavorite') }}</button>
              <button class="btn btn-sm" @click="filterStore.batchUpdateSelected(undefined, false)">{{ t('filter.batchUnfavorite') }}</button>
            </template>
          </div>
        </div>
      </Transition>
    </div>

    <div class="fv-spacer"></div>

    <!-- ── Results ── -->
    <div :ref="(el) => setFilterResultsRootRef(el as Element | null)" class="fv-results">
      <!-- Loading skeleton -->
      <div v-if="filterLoading" class="fv-skeleton-list">
        <div v-for="i in 4" :key="'sk-'+i" class="fv-skeleton-item">
          <div class="fv-skel fv-skel-title"></div>
          <div class="fv-skel fv-skel-line"></div>
          <div class="fv-skel fv-skel-line fv-skel-short"></div>
        </div>
      </div>

      <!-- Empty state -->
      <div v-else-if="!filterResults.length" class="fv-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <span>{{ t('filter.noResults') }}</span>
      </div>

      <!-- Results list -->
      <div
        v-else
        class="fv-list"
        :class="{ 'fv-list--virtual': isVirtualizingFilterResults }"
        :style="virtualFilterContainerStyle"
      >
        <div
          v-for="q in virtualFilterRows"
          :key="q.id"
          :ref="(el) => setFilterQItemRef(q.id, el as Element | null)"
          class="fv-qrow"
          :class="{ 'fv-qrow--virtual': isVirtualizingFilterResults }"
          :data-qid="q.id"
          :style="virtualFilterItemStyle(q.id)"
        >
          <div
            class="fv-qcard"
            :class="{ 'fv-qcard--selected': selectedQuestionIds.has(q.id) }"
            @click="onToggleItem(q, $event)"
          >
          <!-- Header -->
          <div class="fv-qcard-header">
            <div class="fv-qcard-header-left">
              <label v-if="filterMultiSelect" class="fv-qcard-check" @click.stop>
                <input
                  type="checkbox"
                  :checked="selectedQuestionIds.has(q.id)"
                  @change="onToggleSelection(q, ($event.target as HTMLInputElement).checked)"
                />
              </label>
              <strong class="fv-qcard-qno">{{ t('filter.questionNo') }} {{ q.question_no ?? t('filter.noQuestionNo') }}</strong>
              <span
                v-for="s in getSectionNames(q)"
                :key="s"
                class="fv-pill fv-pill--tag"
              >{{ sectionsStore.sectionDisplayName(s) }}</span>
              <span v-if="!getSectionNames(q).length" class="fv-pill fv-pill--muted">{{ t('filter.noSection') }}</span>
              <span class="fv-pill">{{ getPaperLabel(q) }}</span>
              <span v-if="q.notes" class="fv-qcard-notes">{{ t('filter.notesPrefix') }}{{ q.notes }}</span>
            </div>
            <div class="fv-qcard-header-right">
              <button class="btn btn-ghost" :title="t('filter.favOnly')" @click.stop="onToggleFavorite(q)">
                <svg width="16" height="16" viewBox="0 0 24 24" :fill="q.is_favorite ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              </button>
              <button class="btn" @click.stop="onJumpToQuestion(q)">{{ t('filter.locateInPaper') }}</button>
              <button class="btn" @click.stop="onToggleEditPanel(q)">{{ q.__editOpen ? t('filter.less') : t('filter.editLabel') }}</button>
              <button class="btn" @click.stop="toggleFilterAnswer(q)">{{ q.__ansOpen ? t('filter.answerHide') : t('filter.answerShow') }}</button>
              <button class="btn fv-btn-danger" @click.stop="onDeleteQuestion(q)">{{ t('filter.deleteQuestion') }}</button>
            </div>
          </div>

          <!-- Edit panel -->
          <Transition name="fv-expand">
            <div v-if="q.__editOpen" class="fv-edit-panel" @click.stop>
              <div class="fv-edit-row">
                <label class="fv-edit-label">模块</label>
                <SectionTagEditor
                  :model-value="q.__editSections"
                  :option-groups="sectionsStore.sectionOptionGroupsAll.map(g => ({ label: g.label, options: g.options.map(name => ({ value: name, label: sectionsStore.sectionLabelMap[name] || name })) }))"
                  placeholder="选择模块..."
                  @update:model-value="(val: string[]) => onFilterSectionsChange(q, val)"
                />
              </div>
              <div class="fv-edit-actions">
                <button class="btn" @click="onToggleNotesPanel(q)">修改备注</button>
                <button class="btn" @click="onEditQuestionBoxes(q)">修改题目</button>
                <button class="btn" @click="onEditAnswerBoxes(q)">修改答案</button>
              </div>
              <div v-if="q.__notesOpen" class="fv-edit-notes">
                <textarea
                  v-model="q.__editNotes"
                  class="fv-textarea"
                  placeholder="可空"
                  @blur="onFilterNotesBlur(q)"
                ></textarea>
              </div>
            </div>
          </Transition>

          <!-- Boxes preview -->
          <div v-if="getQuestionBoxes(q).length" class="fv-qcard-boxes">
            <div
              :ref="(el) => setPreviewTargetRef(q.id, el as Element | null)"
              class="fv-qcard-box-img"
            >
              <img
                v-if="isQuestionPreviewReady(q) && getQuestionPreviewUrl(q)"
                class="fv-qcard-preview-img"
                :src="getQuestionPreviewUrl(q)"
                loading="lazy"
                decoding="async"
                alt=""
                @load="onQuestionPreviewLoaded"
                @error="onQuestionPreviewError(q)"
              />
              <MergedCropPreview v-else-if="isQuestionPreviewReady(q)" :boxes="getQuestionBoxes(q)" />
              <div v-else class="fv-qcard-preview-placeholder">
                <div class="fv-qcard-preview-skeleton" />
              </div>
            </div>
          </div>

          <!-- Answer panel -->
          <Transition name="fv-expand">
            <div v-if="q.__ansOpen" class="fv-ans-panel">
              <div class="fv-ans-header">
                <strong>{{ t('filter.answerLabel') }}</strong>
                <span class="fv-ans-meta">{{ q.__ansMeta || t('filter.answerNotLoaded') }}</span>
              </div>
              <div v-if="!q.__ansBoxes?.length" class="fv-ans-empty">
                {{ q.__ansMeta === t('filter.answerNone') ? t('filter.answerEmpty') : t('filter.answerEmptyAlt') }}
              </div>
              <div v-else class="fv-qcard-boxes">
                <div v-for="(b, idx) in q.__ansBoxes" :key="idx" class="fv-qcard-box-img">
                  <CropPreview :image-url="b.image_url ?? ''" :bbox="b.bbox" />
                </div>
              </div>
            </div>
          </Transition>
          </div>
        </div>
      </div>
    </div>

    <div class="fv-floating-pager" role="toolbar" :aria-label="t('filter.pageSize')">
      <div class="fv-floating-pager-inner">
        <span class="fv-page-info">{{ pageCountInfo }}</span>
        <label class="fv-inline-field">
          <span>{{ t('filter.pageSize') }}</span>
          <input
            type="number"
            class="fv-input fv-input--page-size"
            :value="filterPageSize"
            min="1"
            max="200"
            @change="filterPageSize = Number(($event.target as HTMLInputElement).value); filterStore.onFilterPageSizeChange()"
          />
        </label>
        <div class="fv-segment">
          <button class="fv-icon-btn" :disabled="filterPage <= 1" :title="t('filter.prevPage')" @click="filterStore.filterPrevPage()">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <button class="fv-icon-btn" :disabled="filterPage >= filterTotalPages" :title="t('filter.nextPage')" @click="filterStore.filterNextPage()">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
        <div class="fv-input-action">
          <label class="fv-input-action-label" for="filter-jump-page">{{ t('filter.jumpPage') }}</label>
          <input
            id="filter-jump-page"
            type="number"
            class="fv-input-action-input"
            v-model="filterJumpPageInput"
            min="1"
            placeholder="1"
            @keydown="onJumpToPageKeydown"
          />
          <button class="fv-input-action-btn" @click="onJumpToPage">{{ t('filter.go') }}</button>
        </div>
        <div class="fv-input-action fv-input-action--wide">
          <label class="fv-input-action-label" for="filter-jump-question">{{ t('filter.questionNo') }}</label>
          <input
            id="filter-jump-question"
            type="text"
            class="fv-input-action-input"
            v-model="filterQuestionNoInput"
            placeholder="12"
            @keydown="onJumpToQuestionKeydown"
          />
          <button class="fv-input-action-btn" @click="onJumpToQuestionNo">{{ t('filter.go') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filter-view {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding-bottom: 88px;
}

/* ── Sticky filter bar ── */
.fv-sticky {
  position: sticky;
  top: -18px;
  z-index: 100;
  padding: 0 0 2px;
  background: linear-gradient(to bottom, var(--bg) 0%, var(--bg) 78%, transparent 100%);
  overflow: visible;
  isolation: isolate;
}

.fv-toolbar {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px;
  background: var(--bg-card);
  backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  border: 0.5px solid var(--glass-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-md);
  overflow: visible;
}

.fv-toolbar-main {
  display: grid;
  grid-template-columns: minmax(180px, 1.2fr) minmax(260px, 1.6fr) minmax(130px, 0.8fr) minmax(130px, 0.8fr) minmax(170px, 1fr) minmax(240px, auto);
  gap: 14px 18px;
  align-items: end;
}

.fv-toolbar-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 14px;
  border-top: 0.5px solid var(--border);
}

.fv-field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}

.fv-field--paper {
  min-width: 260px;
}

.fv-field--compact {
  min-width: 130px;
}

.fv-field--preset {
  min-width: 170px;
}

.fv-label {
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.fv-switches {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-self: center;
  min-width: 220px;
}

.fv-check-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
  line-height: 1.2;
  white-space: nowrap;
}

.fv-check-label input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
  cursor: pointer;
}

.fv-select {
  position: relative;
  z-index: 1;
  width: 100%;
  min-width: 0;
}

.fv-select.ss--open,
.fv-select.ms--open,
.fv-select.scs--open,
.fv-select.pcms--open {
  z-index: 200;
}

.fv-select--batch {
  min-width: 180px;
  max-width: 260px;
}

.fv-native-select {
  width: 100%;
  height: 36px;
  padding: 7px 14px;
  background: var(--bg-elevated);
  border: 0.5px solid var(--border);
  border-radius: 999px;
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
}

.fv-native-select:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.fv-action-group {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  min-width: 0;
}

.fv-action-group--right {
  margin-left: auto;
  justify-content: flex-end;
}

.fv-inline-field {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.fv-input-action {
  display: inline-flex;
  align-items: stretch;
  height: 36px;
  overflow: hidden;
  border: 0.5px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elevated);
}

.fv-input-action-label {
  display: inline-flex;
  align-items: center;
  padding: 0 12px;
  border-right: 0.5px solid var(--border);
  color: var(--text-tertiary);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
}

.fv-input-action-input {
  width: 58px;
  min-width: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  padding: 0 10px;
}

.fv-input-action--wide .fv-input-action-input {
  width: 72px;
}

.fv-input-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  padding: 0 12px;
  border: 0;
  border-left: 0.5px solid var(--border);
  background: transparent;
  color: var(--text-accent);
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
}

.fv-input-action-btn:hover {
  background: var(--bg-hover);
}

.fv-input {
  height: 36px;
  padding: 6px 14px;
  background: var(--bg-elevated);
  border: 0.5px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: all var(--duration-fast) var(--ease-out);
}

.fv-input:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.fv-input::placeholder {
  color: var(--text-tertiary);
}

.fv-input--xs {
  width: 64px;
}

.fv-input--page-size {
  width: 54px;
}

.fv-page-info {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
  min-width: 0;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fv-segment {
  display: inline-flex;
  overflow: hidden;
  border: 0.5px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elevated);
}

.fv-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-right: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
}

.fv-icon-btn:last-child {
  border-right: 0;
}

.fv-icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.fv-icon-btn:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

/* ── Advanced options ── */
.fv-advanced {
  margin-top: 12px;
  padding: 14px 18px;
  background: var(--bg-card);
  backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  border: 0.5px solid var(--glass-border);
  border-radius: var(--radius-xl);
  overflow: visible;
}

.fv-advanced-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  overflow: visible;
}

.fv-advanced-sep {
  width: 1px;
  height: 20px;
  background: var(--border);
  flex-shrink: 0;
}

.fv-selected-count {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-accent);
  padding: 4px 12px;
  background: var(--accent-soft);
  border-radius: 999px;
}

/* ── Button utilities ── */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 18px;
  border: 0.5px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  border-radius: 999px;
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
  outline: none;
  white-space: nowrap;
}

.btn:hover {
  background: var(--bg-card-hover);
  box-shadow: var(--shadow-xs);
}

.btn:active {
  background: var(--bg-pressed);
}

.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
  transform: none;
}

.btn-sm {
  padding: 5px 12px;
  font-size: 12px;
}

.btn-primary {
  background: var(--accent);
  color: white;
  border-color: transparent;
  box-shadow: 0 2px 8px rgba(0, 113, 227, 0.25);
}

.btn-primary:hover {
  background: var(--accent-hover);
  box-shadow: 0 4px 14px rgba(0, 113, 227, 0.35);
}

.btn-ghost {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}

.btn-ghost:hover {
  background: var(--bg-hover);
  border-color: transparent;
  box-shadow: none;
  transform: none;
}

.btn-active {
  background: var(--accent-soft);
  color: var(--text-accent);
  border-color: var(--border-accent);
}

.fv-btn-danger {
  color: var(--danger);
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

.fv-btn-danger:hover {
  background: rgba(255, 59, 48, 0.08);
  border-color: transparent;
  box-shadow: none;
  transform: none;
}

/* ── Spacer ── */
.fv-spacer {
  height: 16px;
  flex-shrink: 0;
}

/* ── Results ── */
.fv-results {
  min-height: 200px;
}

.fv-floating-pager {
  position: fixed;
  left: calc(var(--shell-sidebar-width, 260px) + 28px);
  right: 28px;
  bottom: 18px;
  z-index: 180;
  display: flex;
  justify-content: center;
  pointer-events: none;
}

.fv-floating-pager-inner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  max-width: 100%;
  min-width: min(720px, 100%);
  padding: 10px 14px;
  background: var(--bg-card);
  border: 0.5px solid var(--glass-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  pointer-events: auto;
  overflow-x: auto;
  scrollbar-width: thin;
}

/* ── Skeleton loading ── */
.fv-skeleton-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.fv-skeleton-item {
  padding: 20px;
  background: var(--bg-elevated);
  border: 0.5px solid var(--border);
  border-radius: var(--radius-xl);
}

.fv-skel {
  border-radius: var(--radius-xs);
  background: linear-gradient(
    90deg,
    var(--bg-input) 25%,
    var(--bg-hover) 50%,
    var(--bg-input) 75%
  );
  background-size: 200% 100%;
  animation: fv-shimmer 1.5s ease-in-out infinite;
}

.fv-skel-title {
  width: 40%;
  height: 16px;
  margin-bottom: 12px;
}

.fv-skel-line {
  width: 100%;
  height: 12px;
  margin-bottom: 8px;
}

.fv-skel-short {
  width: 60%;
}

@keyframes fv-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* ── Empty state ── */
.fv-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 56px 32px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 14px;
}

/* ── Question list ── */
.fv-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.fv-list--virtual {
  display: block;
  gap: 0;
}

.fv-qrow {
  width: 100%;
}

.fv-list--virtual .fv-qrow {
  padding-bottom: 12px;
}

/* ── Question card ── */
.fv-qcard {
  background: var(--bg-elevated);
  border: 0.5px solid var(--border);
  border-radius: var(--radius-xl);
  padding: 18px 20px;
  cursor: default;
  transition: all var(--duration-normal) var(--ease-out);
  box-shadow: var(--shadow-sm);
}

.fv-qcard:hover {
  background: var(--bg-card-hover);
  box-shadow: var(--shadow-md);
}

.fv-qcard--selected {
  border-color: var(--border-accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow-sm);
}

/* ── Card header ── */
.fv-qcard-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
  min-width: 0;
}

.fv-qcard-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}

.fv-qcard-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.fv-qcard-check {
  display: flex;
  align-items: center;
  cursor: pointer;
  flex-shrink: 0;
}

.fv-qcard-check input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
  cursor: pointer;
}

.fv-qcard-qno {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.3px;
  flex-shrink: 0;
}

.fv-pill {
  display: inline-flex;
  padding: 4px 12px;
  font-size: 13px;
  font-weight: 500;
  border-radius: 999px;
  background: var(--bg-input);
  color: var(--text-secondary);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fv-pill--tag {
  color: var(--text-accent);
  background: var(--accent-soft);
}

.fv-pill--muted {
  color: var(--text-tertiary);
}

.fv-qcard-notes {
  font-size: 13px;
  color: var(--text-tertiary);
  margin-top: 4px;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Card boxes ── */
.fv-qcard-boxes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
  min-width: 0;
}

.fv-qcard-box-img {
  width: 100%;
  border-radius: var(--radius-lg);
  overflow: hidden;
  border: 0.5px solid var(--border);
  background: var(--bg-input);
}

.fv-qcard-preview-img {
  display: block;
  width: 100%;
  height: auto;
  object-fit: contain;
  object-position: top left;
  background: var(--bg-input);
}

.fv-qcard-preview-placeholder {
  width: 100%;
  min-height: 150px;
  background: var(--bg-input);
}

.fv-qcard-preview-skeleton {
  width: 100%;
  height: 150px;
  background: linear-gradient(
    90deg,
    var(--bg-input) 25%,
    var(--bg-hover) 50%,
    var(--bg-input) 75%
  );
  background-size: 200% 100%;
  animation: fv-preview-shimmer 1.4s ease-in-out infinite;
}

@keyframes fv-preview-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.fv-edit-panel {
  margin-top: 14px;
  padding: 14px;
  background: var(--bg-input);
  border-radius: var(--radius-lg);
  border: 0.5px solid var(--border);
}

.fv-edit-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fv-edit-label {
  font-size: 13px;
  color: var(--text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
  font-weight: 500;
}

.fv-edit-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.fv-edit-notes {
  margin-top: 12px;
}

.fv-textarea {
  width: 100%;
  min-height: 56px;
  padding: 8px 12px;
  background: var(--bg-elevated);
  border: 0.5px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  resize: vertical;
  transition: border-color var(--duration-fast) var(--ease-out);
}

.fv-textarea:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* ── Answer panel ── */
.fv-ans-panel {
  margin-top: 14px;
  padding: 16px;
  background: var(--bg-input);
  border: 0.5px solid var(--border);
  border-radius: var(--radius-lg);
}

.fv-ans-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.fv-ans-header strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.fv-ans-meta {
  font-size: 12px;
  color: var(--text-tertiary);
}

.fv-ans-empty {
  font-size: 12px;
  color: var(--text-tertiary);
  padding: 8px 0;
}

/* ── Transitions ── */
.fv-slide-enter-active {
  transition: all var(--duration-normal) var(--ease-out);
}

.fv-slide-leave-active {
  transition: all var(--duration-fast) var(--ease-out);
}

.fv-slide-enter-from {
  opacity: 0;
  transform: translateY(-8px);
  max-height: 0;
}

.fv-slide-leave-to {
  opacity: 0;
  transform: translateY(-4px);
  max-height: 0;
}

.fv-expand-enter-active {
  transition: all var(--duration-normal) var(--ease-out);
}

.fv-expand-leave-active {
  transition: all var(--duration-fast) var(--ease-out);
}

.fv-expand-enter-from {
  opacity: 0;
  max-height: 0;
  overflow: hidden;
}

.fv-expand-leave-to {
  opacity: 0;
  max-height: 0;
  overflow: hidden;
}

/* ── Responsive ── */
@media (max-width: 900px) {
  .filter-view {
    padding-bottom: 168px;
  }

  .fv-sticky {
    position: static;
    background: transparent;
  }

  .fv-toolbar-main {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .fv-field--section,
  .fv-field--paper,
  .fv-field--preset,
  .fv-switches {
    grid-column: 1 / -1;
  }

  .fv-toolbar-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .fv-switches,
  .fv-field--paper,
  .fv-field--compact,
  .fv-field--preset {
    min-width: 0;
  }

  .fv-switches {
    flex-direction: row;
    flex-wrap: wrap;
  }

  .fv-action-group,
  .fv-action-group--right {
    width: 100%;
    margin-left: 0;
    justify-content: flex-start;
  }

  .fv-input-action {
    flex: 1 1 132px;
  }

  .fv-input-action-input,
  .fv-input-action--wide .fv-input-action-input {
    flex: 1;
    width: auto;
  }

  .fv-page-info {
    min-width: 0;
    max-width: none;
    width: 100%;
  }

  .fv-floating-pager {
    left: calc(var(--shell-sidebar-width, 72px) + 10px);
    right: 10px;
    bottom: 10px;
  }

  .fv-floating-pager-inner {
    justify-content: flex-start;
    flex-wrap: wrap;
    min-width: 0;
    padding: 8px;
    gap: 7px;
  }

  .fv-floating-pager .fv-inline-field {
    flex: 1 1 96px;
  }

  .fv-floating-pager .fv-segment {
    flex: 0 0 auto;
  }
}
</style>
