import { nextTick, ref } from 'vue'
import { defineStore } from 'pinia'
import { i18n } from '@/i18n'
import router from '@/router'
import { useAppStore } from './app'
import { usePapersStore } from './papers'
import { useMarkStore } from './mark'
import { useAnswerStore } from './answer'
import { useExportStore } from './export'
import { useDialogStore } from './dialog'
import { api, convertKeysToSnake } from '@/api/client'
import type { Question, QuestionSearchParams, QuestionSearchResponse, QuestionsBatchUpdateParams, FilterQuestion } from '@/types'
import { clampInt } from '@/utils/geometry'

function extractPaperYear(text: string): string {
  const m = String(text || '').match(/_(m|s|w)(\d{2})_/i)
  return m?.[2] || ''
}

const FILTER_PRESET_KEY = 'setting:filterPresets'

export interface FilterPreset {
  name: string
  filterSection: string
  filterPaperMulti: string[]
  filterYearMulti: string[]
  filterSeasonMulti: string[]
  filterFavOnly: boolean
  filterExcludeMultiSection: boolean
}

export type FilterResultItem = FilterQuestion

export const useFilterStore = defineStore('filter', () => {
  // --- state ---
  const filterSection = ref('')
  const filterPaper = ref('')
  const filterPaperMulti = ref<string[]>([])
  const filterYear = ref('')
  const filterYearMulti = ref<string[]>([])
  const filterSeason = ref('')
  const filterSeasonMulti = ref<string[]>([])
  const filterFavOnly = ref(false)
  const filterExcludeMultiSection = ref(false)
  const filterPage = ref(1)
  const filterPageSize = ref(10)
  const filterResults = ref<FilterResultItem[]>([])
  const filterTotal = ref(0)
  const filterTotalPages = ref(1)
  const filterMultiSelect = ref(false)
  const selectedQuestionIds = ref<Set<number>>(new Set())
  const filterPresets = ref<FilterPreset[]>([])
  const filterPresetNameInput = ref('')
  const filterPresetSelected = ref('')
  const filterLoading = ref(false)
  const filterReturnQid = ref<number | null>(null)
  const filterBatchSection = ref('')
  const filterQuestionNoInput = ref('')
  const filterJumpPageInput = ref('')
  const filterSearchKeyword = ref('')

  // internal debounce state
  let _filterRunDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let _filterAbortController: AbortController | null = null
  let _filterRunSeq = 0
  let _filterVirtualScroller: ((questionId: number | string) => boolean) | null = null
  let _filterWarmupTimer: ReturnType<typeof setTimeout> | null = null
  let _filterWarmupKeyInFlight = ''
  let _skipNextEnterRefresh = false

  function markQuestionDatasetChanged() {
    try {
      useExportStore().invalidateExportFilterCache()
      return
    } catch {}
    try {
      localStorage.removeItem('cache:exportFilterIdsByKey')
      localStorage.removeItem('cache:exportFilterIdsLatest')
      const rawVersion = localStorage.getItem('cache:exportFilterCacheVersion')
      const nextVersion = Math.max(0, Number(rawVersion || 0)) + 1
      localStorage.setItem('cache:exportFilterCacheVersion', String(nextVersion))
    } catch {}
  }

  function clearFilterWarmupTimer() {
    if (_filterWarmupTimer) clearTimeout(_filterWarmupTimer)
    _filterWarmupTimer = null
  }

  function scheduleFilterExportIdsWarmup(delayMs = 900) {
    clearFilterWarmupTimer()
    const exportStore = useExportStore()
    const cacheKey = exportStore.buildFilterExportCacheKey()
    if (!cacheKey) return
    const hasMemoryCache =
      exportStore.exportFilterIdsCacheKey === cacheKey &&
      Array.isArray(exportStore.exportFilterIdsCacheIds) &&
      exportStore.exportFilterIdsCacheIds.length > 0
    if (hasMemoryCache) return
    _filterWarmupTimer = setTimeout(async () => {
      _filterWarmupTimer = null
      if (_filterWarmupKeyInFlight === cacheKey) return
      _filterWarmupKeyInFlight = cacheKey
      try {
        const ids = await collectAllFilteredQuestionIds()
        const currentKey = exportStore.buildFilterExportCacheKey()
        if (currentKey !== cacheKey) return
        exportStore.exportFilterIdsCacheKey = cacheKey
        exportStore.exportFilterIdsCacheIds = [...ids]
        exportStore.exportFilterIdsCacheAt = Date.now()
      } catch {
        // background warmup is best-effort
      } finally {
        _filterWarmupKeyInFlight = ''
      }
    }, Math.max(0, Number(delayMs) || 0))
  }

  // --- actions ---
  function loadFilterSettings() {
    try {
      const raw = localStorage.getItem('setting:filterPageSize')
      if (raw != null) filterPageSize.value = clampInt(raw, 1, 200)
    } catch {}
  }

  function loadFilterPresets() {
    try {
      const raw = localStorage.getItem(FILTER_PRESET_KEY)
      const parsed = raw ? JSON.parse(raw) : []
      filterPresets.value = Array.isArray(parsed) ? parsed : []
    } catch {
      filterPresets.value = []
    }
  }

  function saveFilterPresetsToStorage() {
    try {
      localStorage.setItem(FILTER_PRESET_KEY, JSON.stringify(filterPresets.value || []))
    } catch {}
  }

  function saveCurrentFilterPreset() {
    const appStore = useAppStore()
    const name = String(filterPresetNameInput.value || '').trim()
    if (!name) {
      appStore.setStatus('请先输入预设名称', 'err')
      return
    }
    const payload: FilterPreset = {
      name,
      filterSection: filterSection.value || '',
      filterPaperMulti: [...filterPaperMulti.value],
      filterYearMulti: [...filterYearMulti.value],
      filterSeasonMulti: [...filterSeasonMulti.value],
      filterFavOnly: !!filterFavOnly.value,
      filterExcludeMultiSection: !!filterExcludeMultiSection.value,
    }
    const next = filterPresets.value.filter((x) => x?.name !== name)
    next.unshift(payload)
    filterPresets.value = next.slice(0, 20)
    filterPresetSelected.value = name
    saveFilterPresetsToStorage()
    appStore.setStatus(`已保存筛选预设：${name}`, 'ok')
  }

  async function applyFilterPreset(name: string) {
    const appStore = useAppStore()
    const key = String(name || '').trim()
    if (!key) return
    const p = filterPresets.value.find((x) => x?.name === key)
    if (!p) return
    filterSection.value = p.filterSection || ''
    filterPaperMulti.value = [...(p.filterPaperMulti || [])]
    filterYearMulti.value = [...(p.filterYearMulti || [])]
    filterSeasonMulti.value = [...(p.filterSeasonMulti || [])]
    filterFavOnly.value = !!p.filterFavOnly
    filterExcludeMultiSection.value = !!p.filterExcludeMultiSection
    filterPage.value = 1
    filterPresetSelected.value = key
    await runFilter()
    appStore.setStatus(`已应用筛选预设：${key}`, 'ok')
  }

  function deleteFilterPreset(name: string) {
    const appStore = useAppStore()
    const key = String(name || '').trim()
    if (!key) return
    filterPresets.value = filterPresets.value.filter((x) => x?.name !== key)
    if (filterPresetSelected.value === key) filterPresetSelected.value = ''
    saveFilterPresetsToStorage()
    appStore.setStatus(`已删除筛选预设：${key}`, 'ok')
  }

  function scheduleRunFilter(delayMs = 220) {
    if (_filterRunDebounceTimer) clearTimeout(_filterRunDebounceTimer)
    _filterRunDebounceTimer = setTimeout(() => {
      _filterRunDebounceTimer = null
      runFilter().catch(() => {})
    }, Math.max(0, Number(delayMs) || 0))
  }

  function onFilterChange() {
    filterPaper.value = filterPaperMulti.value.length ? String(filterPaperMulti.value[0]) : ''
    filterYear.value = filterYearMulti.value.length ? String(filterYearMulti.value[0]) : ''
    filterSeason.value = filterSeasonMulti.value.length ? String(filterSeasonMulti.value[0]) : ''
    filterPage.value = 1
    scheduleRunFilter(220)
  }

  function onSearchKeywordChange() {
    filterPage.value = 1
    scheduleRunFilter(350)
  }

  function onFilterPageSizeChange() {
    const next = clampInt(filterPageSize.value, 1, 200)
    filterPageSize.value = next
    try { localStorage.setItem('setting:filterPageSize', String(next)) } catch {}
    filterPage.value = 1
    runFilter().catch(() => {})
  }

  function buildFilterSearchParams({ page, pageSize }: { page: number; pageSize: number }): URLSearchParams {
    const papersStore = usePapersStore()
    const params = new URLSearchParams()
    const section = filterSection.value
    const selectedPaperIds = filterPaperMulti.value.length
      ? filterPaperMulti.value
      : (filterPaper.value ? [filterPaper.value] : [])
    const selectedYears = filterYearMulti.value.length
      ? filterYearMulti.value
      : (filterYear.value ? [filterYear.value] : [])
    const selectedSeasons = filterSeasonMulti.value.length
      ? filterSeasonMulti.value
      : (filterSeason.value ? [filterSeason.value] : [])
    const allPaperIds = papersStore.papers.map((p) => String(p.id))
    const allYears = Array.from(new Set(papersStore.papers
      .map((p) => extractPaperYear(`${p.exam_code || ''} ${p.filename || ''}`))
      .filter(Boolean)))
    const allSeasons = ['m', 's', 'w']
    const paperIds = selectedPaperIds.filter(Boolean)
    const years = selectedYears.filter(Boolean)
    const seasons = selectedSeasons.map((v) => String(v).toLowerCase()).filter(Boolean)
    const usePaperFilter = paperIds.length > 0 && paperIds.length < allPaperIds.length
    const useYearFilter = years.length > 0 && years.length < allYears.length
    const useSeasonFilter = seasons.length > 0 && seasons.length < allSeasons.length
    if (section === '__UNSET__') params.set('unsectioned', 'true')
    else if (section) params.set('section', section)
    if (usePaperFilter) params.set('paper_ids', paperIds.join(','))
    if (useYearFilter) params.set('years', years.join(','))
    if (useSeasonFilter) params.set('seasons', seasons.join(','))
    if (filterFavOnly.value) params.set('favorite', 'true')
    if (filterExcludeMultiSection.value) params.set('exclude_multi_section', 'true')
    const kw = String(filterSearchKeyword.value || '').trim()
    if (kw) params.set('notes_keyword', kw)
    params.set('page', String(page || 1))
    params.set('page_size', String(pageSize || 10))
    return params
  }

  function buildFilterSearchPayload({ page, pageSize, idsOnly = false }: { page: number; pageSize: number; idsOnly?: boolean }): QuestionSearchParams {
    const papersStore = usePapersStore()
    const selectedPaperIds = filterPaperMulti.value.length
      ? filterPaperMulti.value.map(Number).filter(Number.isFinite)
      : (filterPaper.value ? [Number(filterPaper.value)].filter(Number.isFinite) : [])
    const selectedYears = filterYearMulti.value.length
      ? filterYearMulti.value
      : (filterYear.value ? [filterYear.value] : [])
    const selectedSeasons = filterSeasonMulti.value.length
      ? filterSeasonMulti.value
      : (filterSeason.value ? [filterSeason.value] : [])
    const allPaperIds = papersStore.papers.map((p) => p.id)
    const allYears = Array.from(new Set(papersStore.papers
      .map((p) => extractPaperYear(`${p.exam_code || ''} ${p.filename || ''}`))
      .filter(Boolean)))
    const allSeasons = ['m', 's', 'w']
    let paperIds = selectedPaperIds
    let years = selectedYears.filter(Boolean)
    let seasons = selectedSeasons.map((v) => String(v).toLowerCase()).filter(Boolean)
    if (paperIds.length >= allPaperIds.length) paperIds = []
    if (years.length >= allYears.length) years = []
    if (seasons.length >= allSeasons.length) seasons = []
    const kw = String(filterSearchKeyword.value || '').trim()
    return {
      section: filterSection.value === '__UNSET__' ? undefined : (filterSection.value || undefined),
      unsectioned: filterSection.value === '__UNSET__' ? true : undefined,
      paperIds,
      years,
      seasons,
      favorite: filterFavOnly.value ? true : undefined,
      excludeMultiSection: filterExcludeMultiSection.value ? true : undefined,
      notesKeyword: kw || undefined,
      page: Number(page || 1),
      pageSize: Number(pageSize || 10),
      idsOnly: !!idsOnly,
    }
  }

  async function requestFilterSearch({ page, pageSize, idsOnly = false, signal }: { page: number; pageSize: number; idsOnly?: boolean; signal?: AbortSignal | null }) {
    const params = buildFilterSearchParams({ page, pageSize })
    if (!idsOnly && params.toString().length < 1200) {
      return api(`/questions?${params.toString()}`, signal ? { signal } : undefined)
    }
    const req: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(convertKeysToSnake(buildFilterSearchPayload({ page, pageSize, idsOnly }))),
      ...(signal ? { signal } : {}),
    }
    return api('/questions/search', req)
  }

  async function runFilter() {
    const appStore = useAppStore()
    if (_filterRunDebounceTimer) {
      clearTimeout(_filterRunDebounceTimer)
      _filterRunDebounceTimer = null
    }
    clearFilterWarmupTimer()
    if (_filterAbortController) {
      try { _filterAbortController.abort() } catch {}
      _filterAbortController = null
    }
    const reqSeq = ++_filterRunSeq
    filterLoading.value = true
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    _filterAbortController = controller
    appStore.setStatus('筛选中...')
    let data: QuestionSearchResponse
    try {
      data = await requestFilterSearch({
        page: filterPage.value,
        pageSize: filterPageSize.value,
        idsOnly: false,
        signal: controller?.signal ?? null,
      }) as QuestionSearchResponse
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') return
      throw e
    } finally {
      if (_filterAbortController === controller) _filterAbortController = null
      filterLoading.value = false
    }
    if (reqSeq !== _filterRunSeq) return
    const qs = data.questions || []
    const total = data.total != null ? Number(data.total) : qs.length
    const page = data.page != null ? Number(data.page) : filterPage.value
    const pageSize = data.page_size != null ? Number(data.page_size) : filterPageSize.value
    const totalPages = data.total_pages != null ? Number(data.total_pages) : Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
    filterPage.value = page
    filterTotal.value = total
    filterTotalPages.value = totalPages

    filterResults.value = (qs || []).map((q: Question) => ({
      ...q,
      __editOpen: false,
      __ansOpen: false,
      __ansLoaded: false,
      __ansBoxes: [],
      __ansMeta: 'Not loaded',
      __editSections: q.sections && Array.isArray(q.sections) ? [...q.sections] : (q.section ? [q.section] : []),
      __editNotes: q.notes || '',
      __notesOpen: false,
    }))

    appStore.setStatus(qs.length ? `筛选完成：${qs.length}` : '筛选完成：0', 'ok')
    if (qs.length) scheduleFilterExportIdsWarmup(700)
  }

  function toggleFilterMultiSelect() {
    filterMultiSelect.value = !filterMultiSelect.value
    if (!filterMultiSelect.value) selectedQuestionIds.value = new Set()
  }

  function toggleFilterSelection(q: { id: number }, checked: boolean) {
    const next = new Set(selectedQuestionIds.value)
    if (checked) next.add(q.id)
    else next.delete(q.id)
    selectedQuestionIds.value = next
  }

  function toggleFilterItemSelection(q: { id: number }) {
    if (!filterMultiSelect.value) return
    const next = new Set(selectedQuestionIds.value)
    if (next.has(q.id)) next.delete(q.id)
    else next.add(q.id)
    selectedQuestionIds.value = next
  }

  async function toggleFavorite(q: Question) {
    const appStore = useAppStore()
    try {
      const next = !q.is_favorite
      appStore.setStatus(`${next ? '收藏' : '取消收藏'} 题目 #${q.id} 中...`)
      await api(`/questions/${q.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_favorite: next }),
      })
      q.is_favorite = next
      markQuestionDatasetChanged()
      appStore.setStatus('已更新', 'ok')
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  async function saveFilterQuestionMeta(q: Question, sections: string[], notes: string) {
    const appStore = useAppStore()
    try {
      appStore.setStatus(`保存题目 #${q.id} 中...`)
      await api(`/questions/${q.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sections, notes }),
      })
      q.sections = sections
      q.section = sections[0] || null
      q.notes = notes
      markQuestionDatasetChanged()
      appStore.setStatus('已保存', 'ok')
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  async function batchUpdateSelected(sections?: string[], isFavorite?: boolean) {
    const appStore = useAppStore()
    const ids = Array.from(selectedQuestionIds.value)
    if (!ids.length) {
      appStore.setStatus('未选择题目', 'err')
      return
    }
    try {
      appStore.setStatus(`批量更新中（${ids.length} 题）...`)
      const payload: QuestionsBatchUpdateParams & { is_favorite?: boolean } = { ids }
      if (sections) payload.sections = sections
      if (isFavorite !== undefined) payload.is_favorite = isFavorite
      await api('/questions/batch_update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      markQuestionDatasetChanged()
      appStore.setStatus('批量更新完成', 'ok')
      await runFilter()
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  async function batchDeleteSelected(): Promise<boolean> {
    const appStore = useAppStore()
    const dialogStore = useDialogStore()
    const t = i18n.global.t
    const ids = Array.from(selectedQuestionIds.value)
    if (!ids.length) {
      appStore.setStatus('未选择题目', 'err')
      return false
    }
    if (!await dialogStore.confirm(t('filter.batchDeleteConfirm', { count: ids.length }), {
      title: t('filter.batchDeleteTitle'),
      confirmText: t('dialog.delete'),
      danger: true,
    })) return false
    try {
      appStore.setStatus(`批量删除中（${ids.length} 题）...`)
      await api('/questions/batch_delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      selectedQuestionIds.value = new Set()
      markQuestionDatasetChanged()
      appStore.setStatus('批量删除完成', 'ok')
      await usePapersStore().refreshPapers({ silent: true })
      await runFilter()
      return true
    } catch (e) {
      appStore.setStatus(String(e), 'err')
      return false
    }
  }

  async function filterPrevPage() {
    if (filterPage.value <= 1) return
    filterPage.value -= 1
    scrollFilterContainerTo(0)
    await runFilter()
  }

  async function filterNextPage() {
    if (filterPage.value >= filterTotalPages.value) return
    filterPage.value += 1
    scrollFilterContainerTo(0)
    await runFilter()
  }

  async function setFilterPage(page: number) {
    filterPage.value = clampInt(page, 1, filterTotalPages.value || 1)
    scrollFilterContainerTo(0)
    await runFilter()
  }

  function getFilterScrollContainer(): HTMLElement | Element | null {
    if (typeof document === 'undefined') return null
    const workspace = document.querySelector('.workspace-content') as HTMLElement | null
    if (workspace) return workspace
    return document.scrollingElement || document.documentElement
  }

  function getFilterScrollRoot(): ParentNode | null {
    if (typeof document === 'undefined') return null
    return getFilterScrollContainer() || document
  }

  function scrollFilterContainerTo(top: number, behavior: ScrollBehavior = 'auto') {
    if (typeof window === 'undefined') return
    const container = getFilterScrollContainer()
    const nextTop = Math.max(0, Number(top) || 0)
    if (!container || container === document.body || container === document.documentElement || container === document.scrollingElement) {
      window.scrollTo({ top: nextTop, behavior })
      return
    }
    const el = container as HTMLElement
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: nextTop, behavior })
    else el.scrollTop = nextTop
  }

  function setFilterVirtualScroller(fn: ((questionId: number | string) => boolean) | null) {
    _filterVirtualScroller = typeof fn === 'function' ? fn : null
  }

  function skipNextEnterRefresh() {
    _skipNextEnterRefresh = true
  }

  function consumeSkipNextEnterRefresh(): boolean {
    const shouldSkip = _skipNextEnterRefresh
    _skipNextEnterRefresh = false
    return shouldSkip
  }

  function scrollToFilterQuestion(questionId: number | string | null | undefined, block: ScrollLogicalPosition = 'center') {
    if (questionId == null) return
    const usedVirtual = _filterVirtualScroller?.(questionId) === true
    const findAndScroll = () => {
      const root = getFilterScrollRoot()
      const el = root?.querySelector?.(`[data-qid="${questionId}"]`) as HTMLElement | null
      el?.scrollIntoView?.({ behavior: 'auto', block })
    }
    nextTick(() => {
      if (!usedVirtual || typeof requestAnimationFrame === 'undefined') {
        findAndScroll()
        return
      }
      requestAnimationFrame(() => requestAnimationFrame(findAndScroll))
    }).catch(() => {})
  }

  async function collectAllFilteredQuestionIds(): Promise<number[]> {
    const ids: number[] = []
    let page = 1
    let totalPages = 1
    do {
      const data = await requestFilterSearch({ page, pageSize: 1000, idsOnly: true })
      const pageIds = Array.isArray(data?.question_ids)
        ? data.question_ids
        : (Array.isArray(data?.questions) ? (data.questions as Question[]).map((q) => q.id) : [])
      ids.push(...pageIds.map((x: number | string) => Number(x)).filter((x: number) => Number.isFinite(x)))
      totalPages = Number(data.total_pages || 1)
      page += 1
    } while (page <= totalPages)
    return ids
  }

  function captureFilterState() {
    const container = getFilterScrollContainer() as HTMLElement | null
    return {
      section: filterSection.value,
      paper: filterPaper.value,
      paperMulti: [...filterPaperMulti.value],
      year: filterYear.value,
      yearMulti: [...filterYearMulti.value],
      season: filterSeason.value,
      seasonMulti: [...filterSeasonMulti.value],
      favOnly: filterFavOnly.value,
      excludeMultiSection: filterExcludeMultiSection.value,
      page: filterPage.value,
      pageSize: filterPageSize.value,
      questionNoInput: filterQuestionNoInput.value,
      searchKeyword: filterSearchKeyword.value,
      scrollTop: container ? Number((container as HTMLElement).scrollTop || 0) : 0,
    }
  }

  async function restoreFilterState(state: ReturnType<typeof captureFilterState>) {
    const appStore = useAppStore()
    appStore.setView('filter')
    filterSection.value = state.section || ''
    filterPaper.value = state.paper || ''
    filterPaperMulti.value = state.paperMulti?.length ? [...state.paperMulti] : (state.paper ? [state.paper] : [])
    filterYear.value = state.year || ''
    filterYearMulti.value = state.yearMulti?.length ? [...state.yearMulti] : (state.year ? [state.year] : [])
    filterSeason.value = state.season || ''
    filterSeasonMulti.value = state.seasonMulti?.length ? [...state.seasonMulti] : (state.season ? [state.season] : [])
    filterFavOnly.value = !!state.favOnly
    filterExcludeMultiSection.value = !!state.excludeMultiSection
    filterPage.value = state.page || 1
    filterPageSize.value = state.pageSize || filterPageSize.value
    filterQuestionNoInput.value = state.questionNoInput || ''
    filterSearchKeyword.value = state.searchKeyword || ''
    await runFilter()
    await nextTick()
    scrollFilterContainerTo(Number(state.scrollTop || 0))
  }

  async function jumpToQuestionFromFilter(q: Question) {
    const appStore = useAppStore()
    const papersStore = usePapersStore()
    if (!q?.paper_id) return
    const paperId = Number(q.paper_id)
    if (!Number.isFinite(paperId)) return
    appStore.pushNav({ kind: 'filter', state: captureFilterState() })
    filterReturnQid.value = q?.id ?? null
    if (papersStore.currentPaperId !== paperId || !papersStore.pages.length) {
      await papersStore.openPaper(paperId)
    }
    const targetPage = q.boxes?.[0]?.page ?? 1
    const idx = papersStore.pages.findIndex((p) => p.page === targetPage)
    if (idx >= 0) await papersStore.goToPage(idx)
  }

  async function editQuestionBoxesFromFilter(q: Question) {
    const markStore = useMarkStore()
    filterReturnQid.value = q?.id ?? null
    await jumpToQuestionFromFilter(q)
    await markStore.editQuestion(q)
  }

  async function editAnswerBoxesFromFilter(q: Question) {
    const appStore = useAppStore()
    const papersStore = usePapersStore()
    const answerStore = useAnswerStore()
    if (!q?.paper_id || !q?.id) return
    const paperId = Number(q.paper_id)
    const questionId = Number(q.id)
    if (!Number.isFinite(paperId) || !Number.isFinite(questionId)) return
    appStore.pushNav({ kind: 'filter', state: captureFilterState() })
    filterReturnQid.value = q.id
    answerStore.beginAnswerReplaceMode(questionId)
    appStore.setStatus(`准备修改答案 #${questionId}...`)
    if (papersStore.currentPaperId !== paperId || !papersStore.pages.length) {
      await papersStore.openPaper(paperId)
    }
    await answerStore.openAnswerForPaper(null, questionId)
  }

  async function returnToFilterFromNavStack() {
    const appStore = useAppStore()
    const last = appStore.popNav()
    if (!last || last.kind !== 'filter') {
      filterReturnQid.value = null
      return false
    }
    skipNextEnterRefresh()
    await restoreFilterState(last.state as ReturnType<typeof captureFilterState>)
    await router.push({ name: 'filter' })
    await nextTick()
    const qid = filterReturnQid.value
    filterReturnQid.value = null
    if (qid != null) {
      scrollToFilterQuestion(qid)
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(() => requestAnimationFrame(() => scrollToFilterQuestion(qid)))
      } else {
        setTimeout(() => scrollToFilterQuestion(qid), 0)
      }
    } else {
      scrollFilterContainerTo(Number((last.state as Record<string, unknown>)?.scrollTop || 0))
    }
    return true
  }

  function shouldQuestionRemainInCurrentFilter(sections: string[], isFavorite: boolean): boolean {
    const sectionList = Array.isArray(sections) ? sections.filter(Boolean).map(String) : []
    if (filterFavOnly.value && !isFavorite) return false
    if (filterExcludeMultiSection.value && sectionList.length > 1) return false
    if (filterSection.value === '__UNSET__') return sectionList.length === 0
    if (filterSection.value) return sectionList.includes(String(filterSection.value))
    return true
  }

  return {
    // state
    filterSection,
    filterPaper,
    filterPaperMulti,
    filterYear,
    filterYearMulti,
    filterSeason,
    filterSeasonMulti,
    filterFavOnly,
    filterExcludeMultiSection,
    filterPage,
    filterPageSize,
    filterResults,
    filterTotal,
    filterTotalPages,
    filterMultiSelect,
    selectedQuestionIds,
    filterPresets,
    filterPresetNameInput,
    filterPresetSelected,
    filterLoading,
    filterReturnQid,
    filterBatchSection,
    filterQuestionNoInput,
    filterJumpPageInput,
    filterSearchKeyword,
    // actions
    loadFilterSettings,
    loadFilterPresets,
    saveFilterPresetsToStorage,
    saveCurrentFilterPreset,
    applyFilterPreset,
    deleteFilterPreset,
    scheduleRunFilter,
    onFilterChange,
    onSearchKeywordChange,
    onFilterPageSizeChange,
    buildFilterSearchParams,
    buildFilterSearchPayload,
    requestFilterSearch,
    runFilter,
    toggleFilterMultiSelect,
    toggleFilterSelection,
    toggleFilterItemSelection,
    toggleFavorite,
    saveFilterQuestionMeta,
    batchUpdateSelected,
    batchDeleteSelected,
    filterPrevPage,
    filterNextPage,
    setFilterPage,
    markQuestionDatasetChanged,
    getFilterScrollContainer,
    scrollFilterContainerTo,
    setFilterVirtualScroller,
    skipNextEnterRefresh,
    consumeSkipNextEnterRefresh,
    scrollToFilterQuestion,
    collectAllFilteredQuestionIds,
    captureFilterState,
    restoreFilterState,
    jumpToQuestionFromFilter,
    editQuestionBoxesFromFilter,
    editAnswerBoxesFromFilter,
    returnToFilterFromNavStack,
    shouldQuestionRemainInCurrentFilter,
  }
})
