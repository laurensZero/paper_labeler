import { ref } from 'vue'
import { defineStore } from 'pinia'
import { usePapersStore } from './papers'
import { useSettingsStore } from './settings'
import { useDialogStore } from './dialog'
import { i18n } from '@/i18n'
import { api } from '@/api/client'
import { pendingOcrBoxesByPaperId, pendingOcrDraftByPaperId, pendingOcrWarningByPaperId } from './papers'
import { clampInt } from '@/utils/geometry'
import type { PaperListItem, AnswerPaperListItem } from '@/types'

function removeAdText(text: string): string {
  if (!text) return text
  return text.replace(/\s*-\s*\u{1F525}.*\u{1F525}\s*$/u, '').trim()
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

  // --- actions ---
  function openCieImport() {
    cieImportOpen.value = true
  }

  function closeCieImport() {
    cieImportOpen.value = false
  }

  async function ensureCieSubjectComboList() {
    if (cieSubjectComboList.value.length > 0) return cieSubjectComboList.value
    try {
      const data = await api('/cie_import/subject_combo', { method: 'GET' })
      if (Array.isArray(data)) cieSubjectComboList.value = data
      return cieSubjectComboList.value
    } catch {
      return []
    }
  }

  async function updateCieSubjectName() {
    const subjectCode = String(cieSubjectInput.value || '').trim()
    if (!subjectCode) {
      cieSubjectName.value = ''
      cieSubjectNameKind.value = ''
      return
    }
    const list = await ensureCieSubjectComboList()
    const matched = list.find((item) => String(item?.value || '').trim() === subjectCode)
    if (matched) {
      cieSubjectName.value = removeAdText(matched.text)
      cieSubjectNameKind.value = 'ok'
    } else {
      cieSubjectName.value = '未找到匹配科目'
      cieSubjectNameKind.value = 'err'
    }
  }

  async function fetchPapers() {
    const subject = String(cieSubjectInput.value || '').trim()
    const year = String(cieYearInput.value || '').trim()
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
    cieImportStatus.value = `正在导入 ${selected.length} 份试卷...`
    let successCount = 0
    let failCount = 0
    for (let i = 0; i < selected.length; i++) {
      const paper = selected[i]
      cieImportStatus.value = `导入中 ${i + 1}/${selected.length}: ${paper.filename}`
      try {
        const payload = {
          url: paper.url,
          ocr_auto: settingsStore.ocrAutoEnabled,
          ocr_min_height_px: clampInt(settingsStore.ocrMinHeightPx, 0, 2000),
          ocr_y_padding_px: clampInt(settingsStore.ocrYPaddingPx, 0, 500),
        }
        const data = await api('/cie_import/from_url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const importedPaper = data.paper
        const paperId = importedPaper && importedPaper.id
        const ocrWarning = data.ocr_warning ?? data.ocr_warn
        if (ocrWarning && paperId != null) pendingOcrWarningByPaperId.set(paperId, String(ocrWarning))
        if (paperId != null && Array.isArray(data.ocr_questions) && data.ocr_questions.length) {
          pendingOcrDraftByPaperId.set(paperId, data.ocr_questions)
        } else if (paperId != null && Array.isArray(data.ocr_boxes) && data.ocr_boxes.length) {
          pendingOcrBoxesByPaperId.set(paperId, data.ocr_boxes)
        }
        successCount++
      } catch {
        failCount++
      }
    }
    cieImportStatus.value = `导入完成：成功 ${successCount}，失败 ${failCount}`
    cieLoading.value = false
    await papersStore.refreshPapers()
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
    // actions
    openCieImport,
    closeCieImport,
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
