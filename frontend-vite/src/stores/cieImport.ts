import { ref } from 'vue'
import { defineStore } from 'pinia'
import { usePapersStore } from './papers'
import { useSettingsStore } from './settings'
import { useDialogStore } from './dialog'
import { i18n } from '@/i18n'
import { api } from '@/api/client'
import { pendingOcrBoxesByPaperId, pendingOcrDraftByPaperId, pendingOcrWarningByPaperId } from './papers'
import { clampInt } from '@/utils/geometry'
import { safeStorage } from '@/utils/storage'
import type { PaperListItem, AnswerPaperListItem } from '@/types'

function removeAdText(text: string): string {
  if (!text) return text
  // Drop ad suffix like " - 🔥视频课速通🔥"
  let s = text.replace(/\s*-\s*\u{1F525}[\s\S]*$/u, '').trim()
  if (!s) s = text.trim()
  return s
}

function formatSubjectLabel(item: { value?: unknown; text?: unknown }, code: string): string {
  const value = String(item?.value ?? '').trim() || code
  const cleaned = removeAdText(String(item?.text ?? ''))
  if (!cleaned || cleaned === value) return value
  return cleaned
}

/** Accept 23 / 2023 / '23 → 2023 for the CIE API. */
function normalizeYearInput(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (/^\d{4}$/.test(s)) return s
  if (/^\d{2}$/.test(s)) {
    const n = Number(s)
    // Exam years are 2000s; 00-99 → 2000-2099
    return String(2000 + n)
  }
  return s
}

const SUBJECT_HISTORY_KEY = 'cieImport:recentSubjects'
const YEAR_HISTORY_KEY = 'cieImport:recentYears'
const MAX_HISTORY = 12

function loadSubjectHistory(): CieSubjectCombo[] {
  return safeStorage.getJSON<CieSubjectCombo[]>(SUBJECT_HISTORY_KEY, [])
}

function pushSubjectHistory(entry: CieSubjectCombo) {
  const code = String(entry?.value || '').trim()
  if (!code) return
  const list = loadSubjectHistory().filter((x) => String(x?.value || '').trim() !== code)
  list.unshift({ value: code, text: String(entry?.text || code) })
  safeStorage.setJSON(SUBJECT_HISTORY_KEY, list.slice(0, MAX_HISTORY))
}

function loadYearHistory(): string[] {
  return safeStorage.getJSON<string[]>(YEAR_HISTORY_KEY, [])
}

function pushYearHistory(year4: string) {
  const y = String(year4 || '').trim()
  if (!/^\d{4}$/.test(y)) return
  const list = loadYearHistory().filter((x) => x !== y)
  list.unshift(y)
  safeStorage.setJSON(YEAR_HISTORY_KEY, list.slice(0, MAX_HISTORY))
}

export interface CiePaperItem {
  filename: string
  url: string
  kind: 'qp' | 'ms' | 'other'
  done: boolean
  existsLocally: boolean
  exists: boolean
  originalIdx: number
}

export interface CiePaperGroup {
  baseName: string
  qp: CiePaperItem | null
  ms: CiePaperItem | null
}

export interface CieSubjectCombo {
  value: string
  text: string
}

export const useCieImportStore = defineStore('cieImport', () => {
  // --- state ---
  const cieImportOpen = ref(false)
  const cieSubjectInput = ref('')
  const cieSubjectName = ref('')
  const cieSubjectNameKind = ref('')
  const cieYearInput = ref('')
  const cieSeason = ref('Jun')
  const cieImportStatus = ref('')
  const ciePaperListData = ref<CiePaperItem[]>([])
  const ciePaperGroups = ref<CiePaperGroup[]>([])
  const ciePaperUnpaired = ref<CiePaperItem[]>([])
  const ciePaperByFilename = ref<Map<string, CiePaperItem>>(new Map())
  const ciePaperCountText = ref('')
  const cieSelectedIds = ref<Set<number>>(new Set())
  const cieLoading = ref(false)
  const cieSubjectComboList = ref<CieSubjectCombo[]>([])
  const cieSubjectHistory = ref<CieSubjectCombo[]>(loadSubjectHistory())
  const cieYearHistory = ref<string[]>(loadYearHistory())
  // Import job progress (polled from backend)
  const cieImportProgress = ref(0)
  const cieImportStep = ref<string>('') // download|save|render|analyze|ocr|done
  const cieImportCurrent = ref(0)
  const cieImportTotal = ref(0)
  const cieImportFilename = ref('')
  const cieImportPhase = ref<'idle' | 'running' | 'done' | 'error'>('idle')
  const lastImportErrors = ref<string[]>([])

  // --- actions ---
  function openCieImport() {
    cieImportOpen.value = true
  }

  function closeCieImport() {
    cieImportOpen.value = false
  }

  let _comboLoad: Promise<CieSubjectCombo[]> | null = null

  async function ensureCieSubjectComboList(): Promise<CieSubjectCombo[]> {
    if (cieSubjectComboList.value.length > 0) return cieSubjectComboList.value
    if (_comboLoad) return _comboLoad
    _comboLoad = (async () => {
      try {
        const data = await api('/cie_import/subject_combo', { method: 'GET' })
        if (Array.isArray(data) && data.length) {
          cieSubjectComboList.value = data as CieSubjectCombo[]
        }
        return cieSubjectComboList.value
      } catch {
        return cieSubjectComboList.value
      } finally {
        _comboLoad = null
      }
    })()
    return _comboLoad
  }

  function matchSubject(list: CieSubjectCombo[], subjectCode: string): CieSubjectCombo | undefined {
    const code = subjectCode.trim()
    if (!code) return undefined
    const norm = (v: unknown) => String(v ?? '').trim()
    const loose = (v: unknown) => norm(v).replace(/^0+/, '')
    return list.find((item) => {
      const value = norm(item?.value)
      if (value === code || loose(value) === loose(code)) return true
      // Some rows put the code at the start of text instead of value
      const text = norm(item?.text)
      return text === code || text.startsWith(code + ' ') || text.startsWith(code + '-')
    })
  }

  async function updateCieSubjectName() {
    const subjectCode = String(cieSubjectInput.value || '').trim()
    if (!subjectCode) {
      cieSubjectName.value = ''
      cieSubjectNameKind.value = ''
      return
    }
    // History / known code first — never block on the remote combo list
    const hist = cieSubjectHistory.value.find(
      (x) => String(x?.value || '').trim() === subjectCode,
    )
    const histLabel = hist ? formatSubjectLabel(hist, subjectCode) : ''
    const histUsable = !!histLabel && histLabel !== subjectCode

    let list = await ensureCieSubjectComboList()
    if (!list.length) {
      await new Promise((r) => setTimeout(r, 300))
      list = await ensureCieSubjectComboList()
    }

    const matched = list.length ? matchSubject(list, subjectCode) : undefined
    if (matched) {
      cieSubjectName.value = formatSubjectLabel(matched, subjectCode)
      cieSubjectNameKind.value = 'ok'
      return
    }
    if (histUsable) {
      cieSubjectName.value = histLabel
      cieSubjectNameKind.value = 'ok'
      return
    }
    if (!list.length) {
      // Combo list unreachable: show the code as OK so search still works
      cieSubjectName.value = subjectCode
      cieSubjectNameKind.value = 'ok'
      return
    }
    // List loaded but code unknown — still allow fetch, just no pretty name
    cieSubjectName.value = subjectCode
    cieSubjectNameKind.value = 'ok'
  }

  async function fetchPapers() {
    const subject = String(cieSubjectInput.value || '').trim()
    const year = normalizeYearInput(cieYearInput.value)
    const season = cieSeason.value
    if (!subject) {
      cieImportStatus.value = '请输入科目代码（如 9709）'
      return
    }
    if (!year || !/^\d{4}$/.test(year)) {
      cieImportStatus.value = '请输入有效的年份（如 2023）'
      return
    }
    cieLoading.value = true
    cieImportStatus.value = '正在查询试卷列表...'
    try {
      const payload = { subject, year, season }
      const data = await api('/cie_import/fetch_papers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (data.success && data.papers) {
        // Remember subject / year for next time (23/24/25 shortcuts)
        const combo = cieSubjectComboList.value.find((x) => String(x?.value || '').trim() === subject)
        pushSubjectHistory(combo ? { value: subject, text: formatSubjectLabel(combo, subject) } : { value: subject, text: cieSubjectName.value || subject })
        pushYearHistory(year)
        cieSubjectHistory.value = loadSubjectHistory()
        cieYearHistory.value = loadYearHistory()
        ciePaperListData.value = data.papers
        await buildCiePaperGroups()
        cieSelectedIds.value = new Set()
        cieImportStatus.value = `查询成功，共 ${data.total} 份试卷`
      } else {
        ciePaperListData.value = []
        ciePaperGroups.value = []
        ciePaperUnpaired.value = []
        cieSelectedIds.value = new Set()
        cieImportStatus.value = '未找到试卷'
      }
    } catch (e) {
      ciePaperListData.value = []
      ciePaperGroups.value = []
      ciePaperUnpaired.value = []
      cieSelectedIds.value = new Set()
      cieImportStatus.value = `查询失败：${String(e)}`
    } finally {
      cieLoading.value = false
    }
  }

  async function buildCiePaperGroups() {
    const papersStore = usePapersStore()
    const localFilenames = new Set(papersStore.allPaperFilenames || [])
    const localPapersByFilename = new Map<string, PaperListItem | AnswerPaperListItem>()
    papersStore.papers.forEach((p) => { if (p.filename) localPapersByFilename.set(p.filename, p) })
    try {
      const ansData = await api('/answer_papers')
      if (ansData?.papers) {
        (ansData.papers as AnswerPaperListItem[]).forEach((p) => { if (p.filename) localPapersByFilename.set(p.filename, p) })
      }
    } catch {}

    const paperGroups = new Map<string, CiePaperGroup>()
    const unpaired: CiePaperItem[] = []
    const paperByFilename = new Map<string, CiePaperItem>()

    ciePaperListData.value.forEach((paper, idx: number) => {
      paper.originalIdx = idx
      paper.existsLocally = localFilenames.has(paper.filename)
      paper.exists = paper.existsLocally
      paperByFilename.set(paper.filename, paper)

      if (paper.filename.includes('_qp_')) {
        const baseName = paper.filename.replace('_qp_', '_')
        if (!paperGroups.has(baseName)) paperGroups.set(baseName, { baseName, qp: null, ms: null })
        paper.kind = 'qp'
        paper.done = !!localPapersByFilename.get(paper.filename)?.done
        paperGroups.get(baseName)!.qp = paper
      } else if (paper.filename.includes('_ms_')) {
        const baseName = paper.filename.replace('_ms_', '_')
        if (!paperGroups.has(baseName)) paperGroups.set(baseName, { baseName, qp: null, ms: null })
        const localPaper = localPapersByFilename.get(paper.filename)
        let done = false
        if (localPaper) {
          if (localPaper.done) done = true
          else if (
            localPaper.answers_marked != null && localPaper.question_count != null &&
            localPaper.answers_marked > 0 && localPaper.answers_marked === localPaper.question_count
          ) done = true
        }
        paper.kind = 'ms'
        paper.done = done
        paperGroups.get(baseName)!.ms = paper
      } else {
        paper.kind = 'other'
        paper.done = false
        unpaired.push(paper)
      }
    })

    const groups = Array.from(paperGroups.values()).sort((a, b) => a.baseName.localeCompare(b.baseName))
    ciePaperGroups.value = groups
    ciePaperUnpaired.value = unpaired
    ciePaperByFilename.value = paperByFilename
    ciePaperCountText.value = `找到 ${ciePaperListData.value.length} 份试卷`
  }

  function toggleSelectId(idx: number) {
    const next = new Set(cieSelectedIds.value)
    if (next.has(idx)) next.delete(idx)
    else next.add(idx)
    cieSelectedIds.value = next
  }

  function toggleCieSelection(paper: CiePaperItem, selected?: boolean) {
    if (!paper) return
    const next = new Set(cieSelectedIds.value)
    const shouldSelect = selected != null ? !!selected : !next.has(paper.originalIdx)
    if (shouldSelect) next.add(paper.originalIdx)
    else next.delete(paper.originalIdx)

    if (paper.filename && paper.filename.includes('_qp_')) {
      const msFilename = paper.filename.replace('_qp_', '_ms_')
      const msPaper = ciePaperByFilename.value.get(msFilename)
        || ciePaperListData.value.find((p) => p.filename === msFilename)
      if (msPaper && msPaper.originalIdx != null) {
        if (shouldSelect) next.add(msPaper.originalIdx)
        else next.delete(msPaper.originalIdx)
      }
    }
    cieSelectedIds.value = next
  }

  function cieSelectAll() {
    const next = new Set<number>()
    ciePaperListData.value.forEach((p) => next.add(p.originalIdx))
    cieSelectedIds.value = next
  }

  function cieDeselectAll() {
    cieSelectedIds.value = new Set()
  }

  async function importSelected() {
    const papersStore = usePapersStore()
    const settingsStore = useSettingsStore()
    const selected = Array.from(cieSelectedIds.value)
      .map((idx) => ciePaperListData.value[idx])
      .filter(Boolean)
    if (!selected.length) {
      await useDialogStore().alert(i18n.global.t('cieImport.importMinSelect'))
      return
    }

    cieLoading.value = true
    cieImportPhase.value = 'running'
    cieImportProgress.value = 0
    cieImportCurrent.value = 0
    cieImportTotal.value = selected.length
    cieImportStep.value = 'download'
    cieImportFilename.value = selected[0]?.filename || ''
    cieImportStatus.value = i18n.global.t('cieImport.importing', { count: selected.length })

    let successCount = 0
    let failCount = 0

    try {
      const created = await api('/cie_import/import_job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: selected.map((p) => ({ url: p.url, filename: p.filename })),
          ocr_auto: settingsStore.ocrAutoEnabled,
          ocr_min_height_px: clampInt(settingsStore.ocrMinHeightPx, 0, 2000),
          ocr_y_padding_px: clampInt(settingsStore.ocrYPaddingPx, 0, 500),
        }),
      })
      const jobId = created?.job_id
      if (!jobId) throw new Error('missing job_id')

      // Poll until terminal
      for (;;) {
        await new Promise((r) => setTimeout(r, 350))
        const job = await api(`/cie_import/import_job/${jobId}`)
        cieImportProgress.value = Number(job.percent) || 0
        cieImportStep.value = String(job.step || '')
        cieImportCurrent.value = Number(job.current) || 0
        cieImportTotal.value = Number(job.total) || selected.length
        cieImportFilename.value = String(job.filename || '')
        if (job.msg) cieImportStatus.value = String(job.msg)
        else {
          cieImportStatus.value = i18n.global.t('cieImport.importingItem', {
            current: cieImportCurrent.value,
            total: cieImportTotal.value,
            filename: cieImportFilename.value,
          })
        }

        if (job.status === 'done' || job.status === 'error') {
          successCount = Number(job.success) || 0
          failCount = Number(job.failed) || 0
          // Stash OCR payloads from job results if present
          const results = Array.isArray(job.results) ? job.results : []
          const errors: string[] = []
          for (const r of results) {
            if (!r?.ok) {
              if (r?.error) errors.push(`${r.filename || '?'}: ${r.error}`)
              continue
            }
            if (!r?.paper?.id) continue
            const paperId = r.paper.id
            if (Array.isArray(r.ocr_questions) && r.ocr_questions.length) {
              pendingOcrDraftByPaperId.set(paperId, r.ocr_questions)
            } else if (Array.isArray(r.ocr_boxes) && r.ocr_boxes.length) {
              pendingOcrBoxesByPaperId.set(paperId, r.ocr_boxes)
            }
            if (r.ocr_warn || r.ocr_warning) {
              pendingOcrWarningByPaperId.set(paperId, String(r.ocr_warn || r.ocr_warning))
            }
          }
          lastImportErrors.value = errors.slice(0, 3)
          break
        }
      }

      cieImportProgress.value = 100
      cieImportStep.value = 'done'
      cieImportPhase.value = failCount > 0 && successCount === 0 ? 'error' : 'done'
      cieImportStatus.value = i18n.global.t('cieImport.importDone', {
        success: successCount,
        fail: failCount,
      })
      if (lastImportErrors.value.length) {
        cieImportStatus.value += ' · ' + lastImportErrors.value.join('；')
      }
    } catch (e) {
      cieImportPhase.value = 'error'
      failCount = Math.max(1, failCount)
      cieImportStatus.value = i18n.global.t('cieImport.fetchFail', { error: String(e) })
    } finally {
      cieLoading.value = false
      await papersStore.refreshPapers({ silent: true })
    }

    if (successCount > 0 && failCount === 0) {
      closeCieImport()
    }
  }

  return {
    // state
    cieImportOpen,
    cieSubjectInput,
    cieSubjectName,
    cieSubjectNameKind,
    cieYearInput,
    cieSeason,
    cieImportStatus,
    ciePaperListData,
    ciePaperGroups,
    ciePaperUnpaired,
    ciePaperByFilename,
    ciePaperCountText,
    cieSelectedIds,
    cieLoading,
    cieSubjectComboList,
    cieSubjectHistory,
    cieYearHistory,
    cieImportProgress,
    cieImportStep,
    cieImportCurrent,
    cieImportTotal,
    cieImportFilename,
    cieImportPhase,
    lastImportErrors,
    // actions
    openCieImport,
    closeCieImport,
    normalizeYearInput,
    formatSubjectLabel,
    ensureCieSubjectComboList,
    updateCieSubjectName,
    fetchPapers,
    buildCiePaperGroups,
    toggleSelectId,
    toggleCieSelection,
    cieSelectAll,
    cieDeselectAll,
    importSelected,
  }
})
