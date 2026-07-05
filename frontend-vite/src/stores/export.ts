import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useAppStore } from './app'
import { useSectionsStore } from './sections'
import { usePapersStore } from './papers'
import { useFilterStore } from './filter'
import { useDialogStore } from './dialog'
import { i18n } from '@/i18n'
import { api } from '@/api/client'
import type { SectionStat } from '@/types/question'
import { extractYearFromPaperName } from '@/utils/paper'
import type { ExportJobStatus } from '@/types'
import { clampInt } from '@/utils/geometry'

function normalizeUniqueValues(values: unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values || []) {
    const key = String(value ?? '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

function sanitizeExportTokenValue(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/_+/g, '_')
    .replace(/^[-_.]+|[-_.]+$/g, '')
}

function sanitizeExportFileNameCore(value: unknown): string {
  const normalized = String(value ?? '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
  return normalized
    .split('_')
    .map((part) => part.trim().replace(/^[-.]+|[-.]+$/g, ''))
    .filter(Boolean)
    .join('_')
}

function formatDateYmd(now = new Date()): string {
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
}

function formatTimeHm(now = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
}

// localStorage key constants matching old frontend
const DEFAULT_EXPORT_NAME_TEMPLATE = '{mode}_{section}_{paper}_{year}_{season}_{count}'

export interface ExportJobProgress {
  jobId: string
  status: string
  phase: string
  queuePos: number
  progressDone: number
  progressTotal: number
  progressPercent: number
}

export interface RandomExportSection {
  section: string
  count: number
  selected: boolean
  value: number
  aliases: { name: string; count: number }[]
}

export interface RandomExportGroup {
  label: string
  items: RandomExportSection[]
  totalCount: number
}

export const useExportStore = defineStore('export', () => {
  // --- export wizard state ---
  const exportWizardOpen = ref(false)
  const exportWizardSummary = ref('')
  const exportIncludeQno = ref(true)
  const exportIncludeSection = ref(true)
  const exportIncludePaper = ref(true)
  const exportIncludeOriginalQno = ref(false)
  const exportIncludeNotes = ref(false)
  const exportIncludeAnswers = ref(false)
  const exportAnsPlacement = ref<'end' | 'interleaved'>('end')
  const exportFileName = ref('')
  const exportRecommendedName = ref('')
  const exportFromRandomMode = ref(false)
  const exportIncludeFilterSummary = ref(false)
  const exportSummaryFieldSection = ref(true)
  const exportSummaryFieldPaper = ref(true)
  const exportSummaryFieldYear = ref(true)
  const exportSummaryFieldSeason = ref(true)
  const exportSummaryFieldFavorites = ref(true)
  const exportSummaryFieldCount = ref(true)
  const exportBusy = ref(false)
  const exportDefaultSaveDir = ref('')
  const exportNameTemplate = ref(DEFAULT_EXPORT_NAME_TEMPLATE)
  const exportNamePrefix = ref('')
  const exportNameSuffix = ref('')
  const exportNameCustom = ref('')
  const exportNameAutoTimestamp = ref(true)
  const exportNameSectionStyle = ref<'display' | 'raw'>('display')
  const exportCropWorkers = ref(0)
  const exportNameTemplateError = ref('')
  const pendingExportIds = ref<number[]>([])

  // --- export job state ---
  const exportJobId = ref('')
  const exportJobStatus = ref('')
  const exportJobPhase = ref('')
  const exportJobQueuePos = ref(0)
  const exportJobProgressDone = ref(0)
  const exportJobProgressTotal = ref(0)
  const exportJobProgressPercent = ref(0)
  let exportPollingTimer: ReturnType<typeof setTimeout> | null = null

  // --- export cache ---
  const exportFilterIdsCacheKey = ref('')
  const exportFilterIdsCacheIds = ref<number[]>([])
  const exportFilterIdsCacheAt = ref(0)
  const exportFilterCacheVersion = ref(0)
  const exportCacheStats = ref({ hit: 0, miss: 0, expired: 0, write: 0, lastHitAt: 0, lastMissAt: 0, lastWriteAt: 0 })
  const exportCacheOverview = ref({ entryCount: 0, newestAgeMs: null as number | null, oldestAgeMs: null as number | null, ttlMs: 6 * 60 * 60 * 1000 })

  // --- random export state ---
  const randomExportOpen = ref(false)
  const randomExportFavOnly = ref(false)
  const randomExportYearList = ref<{ year: string; checked: boolean }[]>([])
  const randomExportSections = ref<RandomExportSection[]>([])
  const randomExportGroups = ref<RandomExportGroup[]>([])
  const randomExportGroupOpen = ref<Record<string, boolean>>({})
  const randomExportTotalCount = ref(0)
  const randomExportBatchValue = ref(1)
  const randomExportConfig = ref<Record<string, number> | null>(null)
  const randomExportExcludeYears = ref<string[]>([])
  const randomExportFavoriteOnly = ref(false)

  // --- compose export meta (transient, set by ComposeView before opening wizard) ---
  const composeExportMeta = ref<{
    title: string | null
    headerText: string | null
    footerText: string | null
    blankPagesPerQuestion: number[] | null
    showPageNumbers: boolean
  } | null>(null)

  // --- computed ---
  const exportCacheHitRateText = computed(() => {
    const s = exportCacheStats.value
    const hit = Number(s.hit || 0)
    const miss = Number(s.miss || 0)
    const total = hit + miss
    if (total <= 0) return '暂无数据'
    return `${((hit / total) * 100).toFixed(1)}%（命中 ${hit} / 请求 ${total}）`
  })

  // --- export wizard options persistence ---
  function hydrateExportWizardOptions() {
    try {
      const raw = localStorage.getItem('setting:exportWizardOptions')
      const parsed = raw ? JSON.parse(raw) : null
      if (parsed && typeof parsed === 'object') {
        exportIncludeQno.value = parsed.includeQno !== false
        exportIncludeSection.value = parsed.includeSection !== false
        exportIncludePaper.value = parsed.includePaper !== false
        exportIncludeOriginalQno.value = !!parsed.includeOriginalQno
        exportIncludeNotes.value = !!parsed.includeNotes
        exportIncludeAnswers.value = !!parsed.includeAnswers
        exportAnsPlacement.value = parsed.ansPlacement === 'interleaved' ? 'interleaved' : 'end'
        exportIncludeFilterSummary.value = !!parsed.includeFilterSummary
        exportSummaryFieldSection.value = parsed.summaryFieldSection !== false
        exportSummaryFieldPaper.value = parsed.summaryFieldPaper !== false
        exportSummaryFieldYear.value = parsed.summaryFieldYear !== false
        exportSummaryFieldSeason.value = parsed.summaryFieldSeason !== false
        exportSummaryFieldFavorites.value = parsed.summaryFieldFavorites !== false
        exportSummaryFieldCount.value = parsed.summaryFieldCount !== false
      }
    } catch {}
  }

  function persistExportWizardOptions() {
    const next = {
      includeQno: exportIncludeQno.value,
      includeSection: exportIncludeSection.value,
      includePaper: exportIncludePaper.value,
      includeOriginalQno: exportIncludeOriginalQno.value,
      includeNotes: exportIncludeNotes.value,
      includeAnswers: exportIncludeAnswers.value,
      ansPlacement: exportAnsPlacement.value,
      includeFilterSummary: exportIncludeFilterSummary.value,
      summaryFieldSection: exportSummaryFieldSection.value,
      summaryFieldPaper: exportSummaryFieldPaper.value,
      summaryFieldYear: exportSummaryFieldYear.value,
      summaryFieldSeason: exportSummaryFieldSeason.value,
      summaryFieldFavorites: exportSummaryFieldFavorites.value,
      summaryFieldCount: exportSummaryFieldCount.value,
    }
    try { localStorage.setItem('setting:exportWizardOptions', JSON.stringify(next)) } catch {}
  }

  // --- export name settings persistence ---
  function loadExportNameSettings() {
    try {
      exportNameTemplate.value = String(localStorage.getItem('setting:exportNameTemplate') || '').trim() || DEFAULT_EXPORT_NAME_TEMPLATE
    } catch { exportNameTemplate.value = DEFAULT_EXPORT_NAME_TEMPLATE }
    try { exportNamePrefix.value = String(localStorage.getItem('setting:exportNamePrefix') || '').trim() } catch {}
    try { exportNameSuffix.value = String(localStorage.getItem('setting:exportNameSuffix') || '').trim() } catch {}
    try { exportNameCustom.value = String(localStorage.getItem('setting:exportNameCustom') || '').trim() } catch {}
    try {
      const v = localStorage.getItem('setting:exportNameAutoTimestamp')
      exportNameAutoTimestamp.value = v == null ? true : (v === '1' || v === 'true')
    } catch { exportNameAutoTimestamp.value = true }
    try {
      const v = String(localStorage.getItem('setting:exportNameSectionStyle') || '').trim().toLowerCase()
      exportNameSectionStyle.value = v === 'raw' ? 'raw' : 'display'
    } catch { exportNameSectionStyle.value = 'display' }
    try { exportCropWorkers.value = clampInt(localStorage.getItem('setting:exportCropWorkers') ?? '0', 0, 32) } catch { exportCropWorkers.value = 0 }
    try { exportDefaultSaveDir.value = String(localStorage.getItem('setting:exportDefaultSaveDir') || '').trim() } catch {}
  }

  function saveExportSettings() {
    try { localStorage.setItem('setting:exportNameTemplate', exportNameTemplate.value) } catch {}
    try { localStorage.setItem('setting:exportNamePrefix', exportNamePrefix.value) } catch {}
    try { localStorage.setItem('setting:exportNameSuffix', exportNameSuffix.value) } catch {}
    try { localStorage.setItem('setting:exportNameCustom', exportNameCustom.value) } catch {}
    try { localStorage.setItem('setting:exportNameAutoTimestamp', exportNameAutoTimestamp.value ? '1' : '0') } catch {}
    try { localStorage.setItem('setting:exportNameSectionStyle', exportNameSectionStyle.value) } catch {}
    try { localStorage.setItem('setting:exportCropWorkers', String(exportCropWorkers.value)) } catch {}
    try { localStorage.setItem('setting:exportDefaultSaveDir', exportDefaultSaveDir.value) } catch {}
    persistExportWizardOptions()
  }

  function loadExportSettings() {
    loadExportNameSettings()
    hydrateExportWizardOptions()
  }

  function validateExportNameTemplate(template: string): string {
    const effective = String(template || '').trim() || DEFAULT_EXPORT_NAME_TEMPLATE
    const allowed = new Set([
      'mode', 'section', 'paper', 'year', 'season', 'fav', 'exclude', 'count',
      'ts', 'date', 'time', 'seq', 'custom',
    ])
    const unknown: string[] = []
    const seen = new Set<string>()
    const tokenRe = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g
    let m: RegExpExecArray | null
    while ((m = tokenRe.exec(effective)) !== null) {
      const key = String(m[1] || '').toLowerCase()
      if (!allowed.has(key) && !seen.has(key)) {
        seen.add(key)
        unknown.push(`{${key}}`)
      }
    }
    return unknown.length ? `导出文件名模板包含未知占位符：${unknown.join('、')}` : ''
  }

  function templateUsesSeq(template: string): boolean {
    const effective = String(template || '').trim() || DEFAULT_EXPORT_NAME_TEMPLATE
    return /\{seq\}/i.test(effective)
  }

  function getExportSeqState(): { exportSeqDate: string; exportSeqNum: number } {
    try {
      const raw = localStorage.getItem('setting:exportSeqState')
      const parsed = raw ? JSON.parse(raw) : null
      return {
        exportSeqDate: String(parsed?.exportSeqDate || ''),
        exportSeqNum: Math.max(0, Number(parsed?.exportSeqNum || 0)),
      }
    } catch {
      return { exportSeqDate: '', exportSeqNum: 0 }
    }
  }

  function getNextExportSeq(now = new Date()): number {
    const today = formatDateYmd(now)
    const seqState = getExportSeqState()
    return seqState.exportSeqDate === today ? Math.max(0, seqState.exportSeqNum) + 1 : 1
  }

  function commitExportSeq(now = new Date()) {
    const today = formatDateYmd(now)
    const next = getNextExportSeq(now)
    try {
      localStorage.setItem('setting:exportSeqState', JSON.stringify({ exportSeqDate: today, exportSeqNum: next }))
    } catch {}
    return next
  }

  function getYearSelectionInfo() {
    const filterStore = useFilterStore()
    const papersStore = usePapersStore()
    const selected = normalizeUniqueValues(
      (filterStore.filterYearMulti.length ? filterStore.filterYearMulti : (filterStore.filterYear ? [filterStore.filterYear] : []))
        .map((v) => String(v)),
    )
    const all = normalizeUniqueValues(
      papersStore.papers
        .map((p) => extractYearFromPaperName(p))
        .filter((v): v is string => !!v),
    )
    const allSelected = !selected.length || (!!all.length && selected.length === all.length && all.every((v) => selected.includes(v)))
    return { allSelected, values: allSelected ? [] : (all.length ? all.filter((v) => selected.includes(v)) : selected), all }
  }

  function getSeasonSelectionInfo() {
    const filterStore = useFilterStore()
    const selected = normalizeUniqueValues(
      (filterStore.filterSeasonMulti.length ? filterStore.filterSeasonMulti : (filterStore.filterSeason ? [filterStore.filterSeason] : []))
        .map((v) => String(v).toLowerCase()),
    )
    const all = ['m', 's', 'w']
    const allSelected = !selected.length || selected.length === all.length
    return { allSelected, values: allSelected ? [] : all.filter((v) => selected.includes(v)), all }
  }

  function getPaperSelectionInfo() {
    const filterStore = useFilterStore()
    const papersStore = usePapersStore()
    const selected = normalizeUniqueValues(
      (filterStore.filterPaperMulti.length ? filterStore.filterPaperMulti : (filterStore.filterPaper ? [filterStore.filterPaper] : []))
        .map((v) => String(v)),
    )
    const all = normalizeUniqueValues(papersStore.papers.map((p) => String(p.id)))
    const allSelected = !selected.length || (!!all.length && selected.length === all.length)
    if (allSelected) return { allSelected: true, values: [] as string[], labels: [] as string[] }
    const selectedSet = new Set(selected)
    const labels = papersStore.papers
      .filter((p) => selectedSet.has(String(p.id)))
      .map((p) => sanitizeExportTokenValue(papersStore.formatPaperName(p) || p.filename || p.id))
      .filter(Boolean)
    return { allSelected: false, values: selected, labels }
  }

  function getSectionToken() {
    const filterStore = useFilterStore()
    const sectionsStore = useSectionsStore()
    const section = String(filterStore.filterSection || '').trim()
    if (!section) return ''
    if (section === '__UNSET__') return 'unmarked'
    const display = exportNameSectionStyle.value === 'raw' ? section : sectionsStore.sectionDisplayName(section)
    return sanitizeExportTokenValue(display)
  }

  function buildExportNameContext({ idsCount = 0, fromRandom = false, now = new Date() } = {}) {
    const filterStore = useFilterStore()
    const yearInfo = getYearSelectionInfo()
    const seasonInfo = getSeasonSelectionInfo()
    const paperInfo = getPaperSelectionInfo()
    const seasonMap: Record<string, string> = { m: 'spring', s: 'summer', w: 'winter' }
    const date = formatDateYmd(now)
    const time = formatTimeHm(now)
    const ts = `${date}_${time}`
    const paper = !paperInfo.labels.length
      ? ''
      : (paperInfo.labels.length <= 2 ? paperInfo.labels.join('-') : `p${paperInfo.labels.length}`)
    return {
      mode: fromRandom ? 'Random' : 'Filter',
      section: getSectionToken(),
      paper,
      year: yearInfo.values.length ? sanitizeExportTokenValue(`y${yearInfo.values.join('-')}`) : '',
      season: seasonInfo.values.map((v) => seasonMap[v] || v).map(sanitizeExportTokenValue).filter(Boolean).join('-'),
      fav: (fromRandom ? randomExportFavoriteOnly.value : filterStore.filterFavOnly) ? 'fav' : '',
      exclude: fromRandom ? '' : (filterStore.filterExcludeMultiSection ? 'exclude-multi' : ''),
      count: idsCount > 0 ? `${idsCount}q` : '',
      ts,
      date,
      time,
      seq: String(getNextExportSeq(now)),
      custom: sanitizeExportTokenValue(exportNameCustom.value),
    }
  }

  function renderExportNameTemplate({ template, context }: { template: string; context: Record<string, unknown> }) {
    const effectiveTemplate = String(template || '').trim() || DEFAULT_EXPORT_NAME_TEMPLATE
    const templateError = validateExportNameTemplate(effectiveTemplate)
    const usedTemplate = templateError ? DEFAULT_EXPORT_NAME_TEMPLATE : effectiveTemplate
    const rendered = usedTemplate.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_m, rawKey) => {
      const key = String(rawKey || '').toLowerCase()
      return String(context?.[key] ?? '')
    })
    const name = sanitizeExportFileNameCore(rendered).slice(0, 150)
    return {
      name: name || `export_${context.ts || `${formatDateYmd()}_${formatTimeHm()}`}`,
      usedFallback: !!templateError,
      templateError,
      templateUsed: usedTemplate,
    }
  }

  function buildRecommendedExportFileNamePreview({ idsCount = 0, fromRandom = false } = {}) {
    let template = String(exportNameTemplate.value || '').trim() || DEFAULT_EXPORT_NAME_TEMPLATE
    const hasTimeToken = /\{(?:ts|date|time)\}/i.test(template)
    if (exportNameAutoTimestamp.value && !hasTimeToken) template = `${template}_{ts}`
    const context = buildExportNameContext({ idsCount, fromRandom, now: new Date() })
    return renderExportNameTemplate({ template, context })
  }

  function buildRecommendedExportFileName({ idsCount = 0, fromRandom = false } = {}) {
    const result = buildRecommendedExportFileNamePreview({ idsCount, fromRandom })
    exportNameTemplateError.value = result.templateError || ''
    return result.name
  }

  function buildExportFilterSummaryLines(idsCount = 0): string[] {
    const filterStore = useFilterStore()
    const sectionsStore = useSectionsStore()
    const paperInfo = getPaperSelectionInfo()
    const yearInfo = getYearSelectionInfo()
    const seasonInfo = getSeasonSelectionInfo()
    const seasonNameMap: Record<string, string> = { m: 'Spring', s: 'Summer', w: 'Winter' }
    const allText = '(All)'
    const sectionText = filterStore.filterSection === '__UNSET__'
      ? '(Unmarked)'
      : (filterStore.filterSection ? sectionsStore.sectionDisplayName(filterStore.filterSection) : allText)
    const expandedYears = yearInfo.values.length ? yearInfo.values : yearInfo.all
    const expandedSeasonsRaw = seasonInfo.values.length ? seasonInfo.values : ['m', 's', 'w']
    const expandedSeasons = expandedSeasonsRaw.map((v) => seasonNameMap[v] || String(v))
    const lines: string[] = []
    if (exportSummaryFieldSection.value) lines.push(`Section: ${sectionText}`)
    if (exportSummaryFieldPaper.value) lines.push(`Paper: ${paperInfo.labels.length ? paperInfo.labels.join(' / ') : allText}`)
    if (exportSummaryFieldYear.value) lines.push(`Year: ${expandedYears.length ? expandedYears.join(' / ') : allText}`)
    if (exportSummaryFieldSeason.value) lines.push(`Season: ${expandedSeasons.length ? expandedSeasons.join(' / ') : allText}`)
    if (exportSummaryFieldFavorites.value) {
      lines.push(`Favorites: ${filterStore.filterFavOnly ? 'Yes' : 'No'}    Exclude Multi: ${filterStore.filterExcludeMultiSection ? 'Yes' : 'No'}`)
    }
    if (exportSummaryFieldCount.value) lines.push(`Count: ${idsCount || 0}`)
    return lines
  }

  async function editExportSaveDir() {
    const appStore = useAppStore()
    const current = String(exportDefaultSaveDir.value || '').trim()
    try {
      const resp = await api('/export/pick_save_dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initial_dir: current || null }),
      })
      if (!resp || resp.cancelled) return
      const picked = String(resp.selected || '').trim()
      if (!picked) return
      exportDefaultSaveDir.value = picked
      saveExportSettings()
      appStore.setStatus(`已保存导出目录：${picked}`, 'ok')
    } catch {
      const t = i18n.global.t
      const next = await useDialogStore().prompt(t('exportWizard.saveDirPrompt'), current, {
        title: t('exportWizard.saveDirPromptTitle'),
        confirmText: t('dialog.save'),
      })
      if (next == null) return
      exportDefaultSaveDir.value = String(next || '').trim()
      saveExportSettings()
      appStore.setStatus(exportDefaultSaveDir.value ? `已保存导出目录：${exportDefaultSaveDir.value}` : '已清空默认导出目录', 'ok')
    }
  }

  // --- export job management ---
  function resetExportJobState() {
    exportJobId.value = ''
    exportJobStatus.value = ''
    exportJobPhase.value = ''
    exportJobQueuePos.value = 0
    exportJobProgressDone.value = 0
    exportJobProgressTotal.value = 0
    exportJobProgressPercent.value = 0
  }

  function clearExportPolling() {
    if (exportPollingTimer) {
      clearTimeout(exportPollingTimer)
      exportPollingTimer = null
    }
  }

  function openExportWizard() {
    clearExportPolling()
    resetExportJobState()
    hydrateExportWizardOptions()
    exportFromRandomMode.value = false
    if (!exportFileName.value || exportFileName.value === exportRecommendedName.value) {
      const name = buildRecommendedExportFileName({ idsCount: pendingExportIds.value.length, fromRandom: false })
      exportFileName.value = name
      exportRecommendedName.value = name
    }
    exportWizardOpen.value = true
  }

  function closeExportWizard() {
    exportWizardOpen.value = false
    if (!exportBusy.value) clearExportPolling()
  }

  function updateExportJobProgress(statusData: ExportJobStatus) {
    const p = statusData.progress ?? { done: 0, total: 0, percent: 0 }
    exportJobStatus.value = String(statusData.status || '')
    exportJobPhase.value = String(statusData.phase || '')
    exportJobQueuePos.value = Math.max(0, Number(statusData.queue_position || 0))
    exportJobProgressDone.value = Math.max(0, Number(p.done || 0))
    exportJobProgressTotal.value = Math.max(0, Number(p.total || 0))
    const pct = Number(p.percent)
    exportJobProgressPercent.value = Number.isFinite(pct)
      ? Math.max(0, Math.min(100, pct))
      : (exportJobProgressTotal.value > 0
        ? Math.max(0, Math.min(100, (exportJobProgressDone.value / exportJobProgressTotal.value) * 100))
        : 0)
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      exportPollingTimer = setTimeout(() => {
        exportPollingTimer = null
        resolve()
      }, Math.max(0, Number(ms) || 0))
    })
  }

  async function pollExportJobUntilDone(jobId: string): Promise<any> {
    const appStore = useAppStore()
    while (true) {
      if (!jobId || exportJobId.value !== jobId) throw new Error('导出任务已被中断')
      const statusData = await api(`/export/questions_pdf_job/${jobId}`)
      updateExportJobProgress(statusData || {})
      const st = String(statusData?.status || '')
      if (st === 'queued') {
        appStore.setStatus(
          exportJobQueuePos.value > 0 ? `导出排队中（前方 ${exportJobQueuePos.value} 个）` : '导出排队中',
          'info',
        )
      } else if (st === 'processing') {
        appStore.setStatus(`导出处理中 ${Math.round(exportJobProgressPercent.value || 0)}%`, 'info')
      } else if (st === 'done') {
        return statusData
      } else if (st === 'cancelled') {
        throw new Error(String(statusData?.message || '导出已取消'))
      } else if (st === 'error') {
        throw new Error(String(statusData?.message || '导出失败'))
      }
      await wait(500)
    }
  }

  async function cancelExportJob() {
    const appStore = useAppStore()
    const jobId = String(exportJobId.value || '')
    if (!jobId) return
    try {
      await api(`/export/questions_pdf_job/${jobId}/cancel`, { method: 'POST' })
      appStore.setStatus('已取消导出任务', 'info')
    } catch (e) {
      appStore.setStatus(`取消失败：${String(e)}`, 'err')
    } finally {
      clearExportPolling()
      exportBusy.value = false
      exportJobStatus.value = 'cancelled'
    }
  }

  async function startExport(ids: number[], options: Record<string, unknown>) {
    const appStore = useAppStore()
    clearExportPolling()
    resetExportJobState()
    appStore.setStatus(`正在创建导出任务（${ids.length} 题）`, 'info')
    const createData = await api('/export/questions_pdf_job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, options }),
    })
    const jobId = String(createData?.job_id || '')
    if (!jobId) throw new Error('导出任务创建失败：未返回任务 ID')
    exportJobId.value = jobId
    updateExportJobProgress({
      status: createData?.status || 'queued',
      queue_position: createData?.queue_position || 0,
      phase: '排队中',
      progress: { done: 0, total: 3, percent: 0 },
    })
    const doneData = await pollExportJobUntilDone(jobId)
    if (exportJobId.value !== jobId) throw new Error('导出任务状态已失效')
    return doneData
  }

  // --- export cache ---
  function getExportCacheTtlMs() { return 6 * 60 * 60 * 1000 }

  function loadExportCacheStatsFromStorage() {
    try {
      const raw = localStorage.getItem('cache:exportFilterIdsStats')
      if (!raw) return { hit: 0, miss: 0, expired: 0, write: 0, lastHitAt: 0, lastMissAt: 0, lastWriteAt: 0 }
      return JSON.parse(raw)
    } catch { return { hit: 0, miss: 0, expired: 0, write: 0, lastHitAt: 0, lastMissAt: 0, lastWriteAt: 0 } }
  }

  function bumpExportCacheStat(kind: 'hit' | 'miss' | 'expired' | 'write') {
    const now = Date.now()
    const s = loadExportCacheStatsFromStorage()
    if (kind === 'hit') { s.hit += 1; s.lastHitAt = now }
    else if (kind === 'miss') { s.miss += 1; s.lastMissAt = now }
    else if (kind === 'expired') { s.expired += 1 }
    else if (kind === 'write') { s.write += 1; s.lastWriteAt = now }
    exportCacheStats.value = s
    try { localStorage.setItem('cache:exportFilterIdsStats', JSON.stringify(s)) } catch {}
  }

  function invalidateExportFilterCache() {
    exportFilterIdsCacheKey.value = ''
    exportFilterIdsCacheIds.value = []
    exportFilterIdsCacheAt.value = 0
    const nextVersion = getExportFilterCacheVersion() + 1
    saveExportFilterCacheVersion(nextVersion)
    try {
      localStorage.removeItem('cache:exportFilterIdsByKey')
      localStorage.removeItem('cache:exportFilterIdsLatest')
    } catch {}
    refreshExportCacheOverview()
  }

  function getExportFilterCacheVersion(): number {
    let version = Number(exportFilterCacheVersion.value || 0)
    if (!Number.isFinite(version) || version < 0) version = 0
    try {
      const raw = localStorage.getItem('cache:exportFilterCacheVersion')
      if (raw != null) {
        const parsed = Number(raw)
        if (Number.isFinite(parsed) && parsed >= 0) {
          version = Math.floor(parsed)
          exportFilterCacheVersion.value = version
        }
      }
    } catch {}
    return version
  }

  function saveExportFilterCacheVersion(version: number) {
    const v = Math.max(0, Math.floor(Number(version) || 0))
    exportFilterCacheVersion.value = v
    try { localStorage.setItem('cache:exportFilterCacheVersion', String(v)) } catch {}
    return v
  }

  function buildFilterExportCacheKey(): string {
    const filterStore = useFilterStore()
    const payload = {
      version: getExportFilterCacheVersion(),
      section: filterStore.filterSection || '',
      paperMulti: normalizeUniqueValues(filterStore.filterPaperMulti.map(String)).sort(),
      yearMulti: normalizeUniqueValues(filterStore.filterYearMulti.map(String)).sort(),
      seasonMulti: normalizeUniqueValues(filterStore.filterSeasonMulti.map((v) => String(v).toLowerCase())).sort(),
      favOnly: !!filterStore.filterFavOnly,
      excludeMultiSection: !!filterStore.filterExcludeMultiSection,
    }
    try { return JSON.stringify(payload) } catch { return '' }
  }

  function loadPersistedFilterExportIds(cacheKey: string): number[] | null {
    if (!cacheKey) return null
    const ttlMs = getExportCacheTtlMs()
    try {
      const raw = localStorage.getItem('cache:exportFilterIdsByKey')
      const parsed = raw ? (JSON.parse(raw) || {}) : {}
      const item = parsed[cacheKey]
      if (!item || !Array.isArray(item.ids)) return null
      const ts = Number(item.ts || 0)
      if (!ts || (Date.now() - ts) > ttlMs) {
        bumpExportCacheStat('expired')
        return null
      }
      return item.ids.map((x: unknown) => Number(x)).filter((x: number) => Number.isFinite(x))
    } catch {
      return null
    }
  }

  function savePersistedFilterExportIds(cacheKey: string, ids: number[]) {
    if (!cacheKey) return
    try {
      const raw = localStorage.getItem('cache:exportFilterIdsByKey')
      const parsed = raw ? (JSON.parse(raw) || {}) : {}
      parsed[cacheKey] = { ids, ts: Date.now() }
      const entries = Object.entries(parsed as Record<string, any>)
        .sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0))
      const pruned = Object.fromEntries(entries.slice(0, 12))
      localStorage.setItem('cache:exportFilterIdsByKey', JSON.stringify(pruned))
      bumpExportCacheStat('write')
      refreshExportCacheOverview()
    } catch {}
  }

  function refreshExportCacheOverview() {
    const ttlMs = getExportCacheTtlMs()
    let entryCount = 0
    let newestAgeMs: number | null = null
    let oldestAgeMs: number | null = null
    try {
      const raw = localStorage.getItem('cache:exportFilterIdsByKey')
      const parsed = raw ? (JSON.parse(raw) || {}) : {}
      const now = Date.now()
      const ages: number[] = []
      for (const [, item] of Object.entries(parsed as Record<string, any>)) {
        if (!item || !Array.isArray(item.ids)) continue
        const ts = Number(item.ts || 0)
        if (!ts || (now - ts) > ttlMs) continue
        entryCount += 1
        ages.push(now - ts)
      }
      if (ages.length) {
        newestAgeMs = Math.min(...ages)
        oldestAgeMs = Math.max(...ages)
      }
    } catch {}
    exportCacheOverview.value = { entryCount, newestAgeMs, oldestAgeMs, ttlMs }
    exportCacheStats.value = loadExportCacheStatsFromStorage()
  }

  async function prepareFilterExportIds(): Promise<number[]> {
    const appStore = useAppStore()
    const filterStore = useFilterStore()
    exportBusy.value = true
    pendingExportIds.value = []
    exportWizardSummary.value = '正在统计可导出题目...'
    try {
      let ids: number[] = []
      const cacheKey = buildFilterExportCacheKey()
      if (
        cacheKey &&
        exportFilterIdsCacheKey.value === cacheKey &&
        exportFilterIdsCacheIds.value.length > 0 &&
        (Date.now() - Number(exportFilterIdsCacheAt.value || 0)) <= getExportCacheTtlMs()
      ) {
        ids = [...exportFilterIdsCacheIds.value]
        bumpExportCacheStat('hit')
      } else {
        const persisted = loadPersistedFilterExportIds(cacheKey)
        if (persisted && persisted.length) {
          ids = [...persisted]
          bumpExportCacheStat('hit')
        } else {
          bumpExportCacheStat('miss')
          ids = await filterStore.collectAllFilteredQuestionIds()
          savePersistedFilterExportIds(cacheKey, ids)
        }
        exportFilterIdsCacheKey.value = cacheKey
        exportFilterIdsCacheIds.value = [...ids]
        exportFilterIdsCacheAt.value = Date.now()
      }
      pendingExportIds.value = ids
      exportWizardSummary.value = `筛选模式：共 ${ids.length} 题`
      const shouldRefreshRecommended = !exportFileName.value || exportFileName.value === exportRecommendedName.value
      if (shouldRefreshRecommended) {
        const name = buildRecommendedExportFileName({ idsCount: ids.length, fromRandom: false })
        exportFileName.value = name
        exportRecommendedName.value = name
      }
      if (!ids.length) appStore.setStatus('没有可导出的题目', 'err')
      return ids
    } catch (e) {
      pendingExportIds.value = []
      exportWizardSummary.value = '统计失败'
      appStore.setStatus(String(e), 'err')
      return []
    } finally {
      exportBusy.value = false
      refreshExportCacheOverview()
    }
  }

  async function exportFilterPdf() {
    const appStore = useAppStore()
    const filterStore = useFilterStore()
    clearExportPolling()
    resetExportJobState()
    hydrateExportWizardOptions()
    exportFromRandomMode.value = false
    const initName = buildRecommendedExportFileName({ idsCount: 0, fromRandom: false })
    exportFileName.value = initName
    exportRecommendedName.value = initName
    if (exportNameTemplateError.value) {
      appStore.setStatus(`${exportNameTemplateError.value}，已回退为默认模板`, 'info')
    }
    if (filterStore.filterMultiSelect && filterStore.selectedQuestionIds.size > 0) {
      const ids = Array.from(filterStore.selectedQuestionIds).map(Number).filter(Number.isFinite)
      if (!ids.length) {
        appStore.setStatus('没有可导出的题目', 'err')
        return
      }
      exportWizardSummary.value = `已选 ${ids.length} 题`
      pendingExportIds.value = ids
      const name = buildRecommendedExportFileName({ idsCount: ids.length, fromRandom: false })
      exportFileName.value = name
      exportRecommendedName.value = name
      exportBusy.value = false
      exportWizardOpen.value = true
      return
    }
    exportWizardOpen.value = true
    prepareFilterExportIds().catch(() => {})
  }

  // --- random export ---
  async function openRandomExportSettings() {
    const appStore = useAppStore()
    try {
      exportBusy.value = false
      const stats = await getSectionStats(randomExportFavOnly.value)
      randomExportSections.value = buildRandomExportSections(stats || [])
      randomExportGroups.value = buildRandomExportGroups(randomExportSections.value)
      randomExportGroupOpen.value = Object.fromEntries(
        (randomExportGroups.value || []).map((g) => [g.label, false])
      )
      randomExportYearList.value = buildRandomExportYearList()
      randomExportOpen.value = true
    } catch (e) {
      appStore.setStatus('随机导出配置加载失败：' + String(e), 'err')
    }
  }

  async function getSectionStats(favoriteOnly = false): Promise<SectionStat[]> {
    const url = favoriteOnly ? '/section_stats?favorite_only=true' : '/section_stats'
    return await api(url)
  }

  function buildRandomExportSections(stats: SectionStat[], prevMap: Map<string, RandomExportSection> | null = null): RandomExportSection[] {
    const items = Array.isArray(stats) ? stats : []
    const aliasMap = buildRandomExportAliasMap()
    const merged = new Map<string, RandomExportSection>()
    for (const item of items) {
      const raw = item?.section || ''
      const norm = aliasMap.get(raw) || raw
      if (!merged.has(norm)) {
        merged.set(norm, { section: norm, count: 0, selected: false, value: 0, aliases: [] })
      }
      const entry = merged.get(norm)!
      entry.count += item?.count || 0
      entry.aliases.push({ name: raw, count: item?.count || 0 })
    }
    const prev = prevMap instanceof Map ? prevMap : new Map<string, RandomExportSection>()
    for (const entry of merged.values()) {
      const old = prev.get(entry.section)
      if (old) {
        entry.selected = !!old.selected
        entry.value = old.value || 0
      }
    }
    return Array.from(merged.values())
  }

  function buildRandomExportAliasMap() {
    const sectionsStore = useSectionsStore()
    const map = new Map<string, string>()
    const names = Array.isArray(sectionsStore.sectionNames) ? sectionsStore.sectionNames : []
    for (const name of names) {
      const label = sectionsStore.sectionLabelMap?.[name] || name
      if (label && label !== name) map.set(label, name)
    }
    return map
  }

  function buildRandomExportGroups(sections: RandomExportSection[]): RandomExportGroup[] {
    const sectionsStore = useSectionsStore()
    const items = Array.isArray(sections) ? sections : []
    if (!items.length) return []
    const labelBySection = new Map<string, string>()
    const orderedLabels: string[] = []
    const groupsFromDefs = sectionsStore.sectionOptionGroupsAll || []
    for (const g of groupsFromDefs) {
      if (!g || !g.label) continue
      orderedLabels.push(g.label)
      for (const opt of g.options || []) { labelBySection.set(opt, g.label) }
    }
    const fallbackLabel = '(未分类)'
    const groupMap = new Map<string, RandomExportSection[]>()
    for (const item of items) {
      const label = labelBySection.get(item.section) || fallbackLabel
      if (!groupMap.has(label)) groupMap.set(label, [])
      groupMap.get(label)!.push(item)
    }
    const out: RandomExportGroup[] = []
    for (const label of orderedLabels) {
      if (groupMap.has(label)) {
        const arr = groupMap.get(label)!
        out.push({ label, items: arr, totalCount: arr.reduce((s, it) => s + (it.count || 0), 0) })
        groupMap.delete(label)
      }
    }
    for (const [label, arr] of groupMap.entries()) {
      out.push({ label, items: arr, totalCount: arr.reduce((s, it) => s + (it.count || 0), 0) })
    }
    return out
  }

  function buildRandomExportYearList() {
    const papersStore = usePapersStore()
    const years = new Set<string>()
    papersStore.papers.forEach((p) => {
      const year = extractYearFromPaperName(p)
      if (year) years.add(String(year))
    })
    return Array.from(years)
      .sort((a, b) => Number(b) - Number(a))
      .map((y) => ({ year: y, checked: true }))
  }

  function randomExportUpdateTotal() {
    randomExportTotalCount.value = randomExportSections.value.reduce((sum, item) => sum + (parseInt(String(item.value), 10) || 0), 0)
  }

  function randomExportBatch(delta: number) {
    const val = clampInt(randomExportBatchValue.value, 1, 9999)
    randomExportSections.value.forEach((s) => {
      if (!s.selected) return
      s.value = Math.max(0, (parseInt(String(s.value), 10) || 0) + delta * val)
    })
    randomExportUpdateTotal()
  }

  function randomExportReset() {
    randomExportSections.value.forEach((s) => { s.value = 0; s.selected = false })
    randomExportUpdateTotal()
  }

  function randomExportSelectAll() {
    const allSelected = randomExportSections.value.every((s) => s.selected)
    randomExportSections.value.forEach((s) => { s.selected = !allSelected })
  }

  async function confirmRandomExport() {
    const appStore = useAppStore()
    const config: Record<string, number> = {}
    for (const item of randomExportSections.value) {
      const count = Math.max(0, parseInt(String(item.value), 10) || 0)
      if (count <= 0) continue
      const aliases = item.aliases?.length ? item.aliases : [{ name: item.section, count: item.count || 0 }]
      if (aliases.length === 1) {
        const key = aliases[0].name || ''
        config[key] = (config[key] || 0) + count
        continue
      }
      const totalStock = aliases.reduce((sum, a) => sum + (a.count || 0), 0) || 0
      let remaining = count
      for (let i = 0; i < aliases.length; i++) {
        const alias = aliases[i]
        const key = alias.name || ''
        if (i === aliases.length - 1) {
          if (remaining > 0) config[key] = (config[key] || 0) + remaining
          remaining = 0
          break
        }
        const share = totalStock > 0 ? Math.round(count * (alias.count || 0) / totalStock) : 0
        const applied = Math.min(share, remaining)
        if (applied > 0) config[key] = (config[key] || 0) + applied
        remaining -= applied
      }
    }
    if (Object.keys(config).length === 0) {
      await useDialogStore().alert(i18n.global.t('exportDialogs.randomNoConfig'))
      return
    }
    pendingExportIds.value = []
    randomExportConfig.value = config
    randomExportFavoriteOnly.value = !!randomExportFavOnly.value
    randomExportExcludeYears.value = randomExportYearList.value.filter((y) => !y.checked).map((y) => y.year)
    try {
      const totalCount = Object.values(config).reduce((sum, val) => sum + val, 0)
      exportWizardSummary.value = `随机导出模式：共 ${totalCount} 题`
      const resp = await api('/random_by_sections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sections: config,
          favorite_only: !!randomExportFavOnly.value,
          exclude_years: randomExportExcludeYears.value,
        }),
      })
      const ids = resp.question_ids || []
      if (!ids.length) {
        appStore.setStatus('没有可导出的题目', 'err')
        return
      }
      pendingExportIds.value = ids
      exportFromRandomMode.value = true
      exportIncludeFilterSummary.value = false
      const name = buildRecommendedExportFileName({ idsCount: ids.length, fromRandom: true })
      exportFileName.value = name
      exportRecommendedName.value = name
      if (exportNameTemplateError.value) {
        appStore.setStatus(`${exportNameTemplateError.value}，已回退为默认模板`, 'info')
      }
      exportBusy.value = false
      clearExportPolling()
      resetExportJobState()
      randomExportOpen.value = false
      exportWizardOpen.value = true
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  async function confirmExportWizard() {
    const appStore = useAppStore()
    try {
      if (exportBusy.value) {
        appStore.setStatus('正在统计题目，请稍后...', 'info')
        return
      }
      const ids = pendingExportIds.value || []
      if (!ids.length) {
        appStore.setStatus('没有可导出的题目', 'err')
        return
      }
      if (ids.length > 200) {
        const t = i18n.global.t
        const ok = await useDialogStore().confirm(t('exportDialogs.largeExportConfirm', { count: ids.length }), {
          title: t('exportDialogs.largeExportTitle'),
          confirmText: t('exportDialogs.largeExportButton'),
        })
        if (!ok) {
          appStore.setStatus('已取消导出', 'info')
          return
        }
      }
      if (!exportFileName.value) {
        const name = buildRecommendedExportFileName({ idsCount: ids.length, fromRandom: !!exportFromRandomMode.value })
        exportFileName.value = name
        exportRecommendedName.value = name
      }
      const filterStore = useFilterStore()
      const filterSection = filterStore.filterSection ? String(filterStore.filterSection).trim() : ''
      const filenameInput = exportFileName.value ? String(exportFileName.value).trim() : ''
      const shouldCommitSeq = templateUsesSeq(exportNameTemplate.value) && filenameInput && filenameInput === exportRecommendedName.value
      const selectedSummaryLines = (!exportFromRandomMode.value && exportIncludeFilterSummary.value)
        ? buildExportFilterSummaryLines(ids.length)
        : []
      const shouldIncludeSummary = !exportFromRandomMode.value && exportIncludeFilterSummary.value && selectedSummaryLines.length > 0
      // Merge composition-specific export metadata if present
      const composeMeta = composeExportMeta.value
      const options: Record<string, unknown> = {
        include_question_no: exportIncludeQno.value,
        include_section: exportIncludeSection.value,
        include_paper: exportIncludePaper.value,
        include_original_qno: exportIncludeOriginalQno.value,
        include_notes: exportIncludeNotes.value,
        include_answers: !!exportIncludeAnswers.value,
        answers_placement: exportAnsPlacement.value === 'interleaved' ? 'interleaved' : 'end',
        filter_section: filterSection || null,
        filename: filenameInput || null,
        save_dir: exportDefaultSaveDir.value || null,
        include_filter_summary: shouldIncludeSummary,
        filter_summary_lines: selectedSummaryLines,
        crop_workers: Math.max(0, Number(exportCropWorkers.value || 0)),
      }
      if (composeMeta) {
        options.title = composeMeta.title || null
        options.header_text = composeMeta.headerText || null
        options.footer_text = composeMeta.footerText || null
        options.blank_pages_per_question = composeMeta.blankPagesPerQuestion || null
        options.show_page_numbers = composeMeta.showPageNumbers !== false
        composeExportMeta.value = null
      }
      if (!exportFromRandomMode.value) persistExportWizardOptions()
      exportBusy.value = true
      const doneData = await startExport(ids, options)
      const savedCopyPath = String(doneData?.saved_copy_path || '')
      if (exportDefaultSaveDir.value) {
        if (!savedCopyPath) throw new Error('导出完成，但未返回保存路径')
        appStore.setStatus(`已保存到：${savedCopyPath}`, 'ok')
        if (shouldCommitSeq) commitExportSeq()
        exportWizardOpen.value = false
        exportFromRandomMode.value = false
        return
      }
      const url = String(doneData?.download_url || '')
      if (url) {
        if (savedCopyPath) appStore.setStatus(`已保存并开始下载：${savedCopyPath}`, 'ok')
        else appStore.setStatus('导出完成，开始下载', 'ok')
        try { window.location.assign(url) } catch { window.open(url, '_self') }
      } else {
        throw new Error('导出完成，但未返回下载链接')
      }
      if (shouldCommitSeq) commitExportSeq()
      exportWizardOpen.value = false
      exportFromRandomMode.value = false
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    } finally {
      exportBusy.value = false
      clearExportPolling()
    }
  }

  return {
    // export wizard state
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
    exportRecommendedName,
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
    exportNameTemplate,
    exportNamePrefix,
    exportNameSuffix,
    exportNameCustom,
    exportNameAutoTimestamp,
    exportNameSectionStyle,
    exportCropWorkers,
    exportNameTemplateError,
    pendingExportIds,
    // job state
    exportJobId,
    exportJobStatus,
    exportJobPhase,
    exportJobQueuePos,
    exportJobProgressDone,
    exportJobProgressTotal,
    exportJobProgressPercent,
    // cache
    exportFilterIdsCacheKey,
    exportFilterIdsCacheIds,
    exportFilterIdsCacheAt,
    exportFilterCacheVersion,
    exportCacheStats,
    exportCacheOverview,
    exportCacheHitRateText,
    // random export
    randomExportOpen,
    randomExportFavOnly,
    randomExportYearList,
    randomExportSections,
    randomExportGroups,
    randomExportGroupOpen,
    randomExportTotalCount,
    randomExportBatchValue,
    randomExportConfig,
    randomExportExcludeYears,
    randomExportFavoriteOnly,
    // compose export
    composeExportMeta,
    // actions
    openExportWizard,
    closeExportWizard,
    startExport,
    pollExportJobUntilDone,
    cancelExportJob,
    resetExportJobState,
    clearExportPolling,
    updateExportJobProgress,
    hydrateExportWizardOptions,
    persistExportWizardOptions,
    loadExportSettings,
    saveExportSettings,
    loadExportNameSettings,
    validateExportNameTemplate,
    buildRecommendedExportFileNamePreview,
    buildRecommendedExportFileName,
    buildExportFilterSummaryLines,
    editExportSaveDir,
    getExportCacheTtlMs,
    bumpExportCacheStat,
    invalidateExportFilterCache,
    getExportFilterCacheVersion,
    saveExportFilterCacheVersion,
    buildFilterExportCacheKey,
    prepareFilterExportIds,
    exportFilterPdf,
    refreshExportCacheOverview,
    openRandomExportSettings,
    getSectionStats,
    buildRandomExportSections,
    buildRandomExportAliasMap,
    buildRandomExportGroups,
    buildRandomExportYearList,
    randomExportUpdateTotal,
    randomExportBatch,
    randomExportReset,
    randomExportSelectAll,
    confirmRandomExport,
    confirmExportWizard,
  }
})
