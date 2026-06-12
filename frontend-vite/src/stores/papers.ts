import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useAppStore } from './app'
import { useSectionsStore } from './sections'
import { useMarkStore } from './mark'
import { useSettingsStore } from './settings'
import { useDialogStore } from './dialog'
import { i18n } from '@/i18n'
import { api } from '@/api/client'
import type { BoundingBox } from '@/types/common'
import type { PaperListItem, Page } from '@/types/paper'

// Helpers matching old frontend/app/helpers.js
function stripPdfSuffix(name: string): string {
  return String(name || '').trim().replace(/\.pdf$/i, '')
}

function formatPaperName(paper: { exam_code?: string | null; filename?: string }): string {
  const base = paper?.exam_code || paper?.filename || ''
  return stripPdfSuffix(base)
}

function extractCacheBustToken(url: string): string | null {
  try {
    const u = new URL(String(url || ''), window.location.origin)
    const v = u.searchParams.get('v')
    return v ? String(v) : null
  } catch {
    return null
  }
}

function lastMarkedPageKey(paperId: number, token: string | null): string | null {
  if (paperId == null) return null
  const t = token ? String(token) : ''
  return t ? `lastMarkedPage:${paperId}:${t}` : `lastMarkedPage:${paperId}`
}

function getLastMarkedPageNum(paperId: number, token: string | null): number | null {
  const key = lastMarkedPageKey(paperId, token)
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    const n = raw != null ? parseInt(raw, 10) : NaN
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function setLastMarkedPageNum(paperId: number, token: string | null, pageNum: number): void {
  const key = lastMarkedPageKey(paperId, token)
  if (!key) return
  try { localStorage.setItem(key, String(pageNum)) } catch {}
}

function clampInt(v: unknown, min: number, max: number): number {
  const n = parseInt(String(v), 10)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function toBoundingBox(value: unknown): BoundingBox | null {
  const arr = Array.isArray(value) ? value.map((v) => Number(v)) : []
  if (arr.length !== 4 || arr.some((v) => !Number.isFinite(v))) return null
  return arr as BoundingBox
}

// OCR pending maps (shared across paper opens within a session)
export const pendingOcrBoxesByPaperId = new Map<number, unknown[]>()
export const pendingOcrDraftByPaperId = new Map<number, unknown[]>()
export const pendingOcrWarningByPaperId = new Map<number, string>()
export const pendingOcrDraftSelectedIdxByPaperId = new Map<number, number>()

function stashPendingOcrUploadResult(item: any): string | null {
  const paperId = Number(item?.id ?? item?.paper_id)
  if (!Number.isFinite(paperId)) return null

  const drafts = Array.isArray(item?.ocr_questions) ? item.ocr_questions : []
  const boxes = Array.isArray(item?.ocr_boxes) ? item.ocr_boxes : []
  const warning = item?.ocr_warning ?? item?.ocr_warn ?? item?.warning ?? null

  if (drafts.length) {
    pendingOcrDraftByPaperId.set(paperId, drafts)
    pendingOcrDraftSelectedIdxByPaperId.set(paperId, 0)
    pendingOcrBoxesByPaperId.delete(paperId)
  } else if (boxes.length) {
    pendingOcrBoxesByPaperId.set(paperId, boxes)
    pendingOcrDraftByPaperId.delete(paperId)
    pendingOcrDraftSelectedIdxByPaperId.delete(paperId)
  } else {
    pendingOcrDraftByPaperId.delete(paperId)
    pendingOcrDraftSelectedIdxByPaperId.delete(paperId)
    pendingOcrBoxesByPaperId.delete(paperId)
  }

  if (warning) {
    pendingOcrWarningByPaperId.set(paperId, String(warning))
    return String(warning)
  }
  pendingOcrWarningByPaperId.delete(paperId)
  return null
}

export const usePapersStore = defineStore('papers', () => {
  // --- state ---
  const papers = ref<PaperListItem[]>([])
  const allPaperFilenames = ref<string[]>([])
  const currentPaperId = ref<number | null>(null)
  const currentQpPaperName = ref('')
  const currentMsPaperName = ref('')
  const currentPaperCacheToken = ref<string | null>(null)
  const currentMsCacheToken = ref<string | null>(null)
  const pages = ref<Page[]>([])
  const currentPageIndex = ref(-1)
  const paperOpening = ref(false)
  const uploading = ref(false)
  const uploadStatus = ref('')
  const showDonePapers = ref(false)
  const globalSuggestedNextNo = ref<number | null>(null)
  const suggestedNextNo = ref<number | null>(null)
  let openPaperSeq = 0

  // --- computed ---
  const currentPaper = computed(() => {
    return papers.value.find((p) => p.id === currentPaperId.value) || null
  })

  const viewPapers = computed(() => {
    return papers.value.filter((p) => (!!p.done) === !!showDonePapers.value)
  })

  const paperCountHint = computed(() => {
    const total = papers.value.length
    const done = papers.value.filter((p) => !!p.done).length
    const todo = total - done
    return `待做 ${todo} / 已做 ${done}`
  })

  const showDonePapersText = computed(() => {
    return showDonePapers.value ? '显示未完成' : '显示已完成'
  })

  const paperTitleText = computed(() => {
    const p = currentPaper.value
    if (!p) return '未选择'
    return `#${p.id} ${formatPaperName(p)}${p.done ? ' ✓' : ''}`
  })

  const pageInfoText = computed(() => {
    const p = pages.value[currentPageIndex.value]
    return p ? `page ${p.page} / ${pages.value.length}` : 'page -'
  })

  const canPrevPage = computed(() => currentPageIndex.value > 0)
  const canNextPage = computed(() =>
    currentPageIndex.value >= 0 && currentPageIndex.value < pages.value.length - 1
  )

  const canOpenAnswer = computed(() => {
    const p = currentPaper.value
    const qpHint = String(p?.exam_code || p?.filename || '')
    return /_qp_/i.test(qpHint)
  })

  // --- actions ---
  async function refreshStats() {
    const appStore = useAppStore()
    try {
      const d = await api('/stats')
      const maxNum =
        typeof d.max_question_no_numeric === 'number' && Number.isFinite(d.max_question_no_numeric)
          ? d.max_question_no_numeric
          : 0
      globalSuggestedNextNo.value = Math.max(1, Math.floor(maxNum) + 1)
      appStore.statsText = `试题卷：${d.qp_papers ?? 0} · 答案卷：${d.answer_papers ?? 0} · 已分类题目：${d.classified_questions ?? 0}`
    } catch {
      appStore.statsText = ''
    }
  }

  async function refreshPapers(options: { silent?: boolean } = {}) {
    const appStore = useAppStore()
    const silent = !!options.silent
    if (!silent) appStore.setStatus('加载试卷列表...')
    try {
      const data = await api('/papers')
      papers.value = Array.isArray(data.papers) ? data.papers : []
      try {
        const filenameData = await api('/papers/filenames')
        allPaperFilenames.value = filenameData.filenames || []
      } catch {
        allPaperFilenames.value = []
      }
      if (!silent) appStore.setStatus(`试卷数：${papers.value.length}`, 'ok')
      await refreshStats()
    } catch (e) {
      if (!silent) appStore.setStatus('列表加载失败: ' + String(e), 'err')
      papers.value = []
      allPaperFilenames.value = []
    }
  }

  function toggleShowDonePapers() {
    showDonePapers.value = !showDonePapers.value
  }

  async function openPaper(paperId: number) {
    const appStore = useAppStore()
    const sectionsStore = useSectionsStore()
    const markStore = useMarkStore()
    const seq = ++openPaperSeq
    appStore.setView('mark')
    paperOpening.value = true

    if (currentPaperId.value != null && currentPaperId.value !== paperId) {
      markStore.stashCurrentOcrDraftStateForPaper(currentPaperId.value)
    }

    currentPaperId.value = paperId
    const listPaper = papers.value.find((p) => p.id === paperId)
    if (listPaper) currentQpPaperName.value = formatPaperName(listPaper)
    currentPaperCacheToken.value = null
    pages.value = []
    currentPageIndex.value = -1

    markStore.exitEditQuestionMode()
    markStore.pageQuestions = []
    markStore.ocrDraftQuestions = []
    markStore.selectedOcrDraftIdx = 0
    markStore.newBoxes = []
    markStore.selectedNewBox = null
    markStore.resetMarkHistory()

    appStore.setStatus(`打开试卷 #${paperId}...`)

    const shouldRefreshSections =
      sectionsStore.sectionDefs.length === 0 &&
      sectionsStore.sectionGroups.length === 0 &&
      sectionsStore.sectionOptionGroupsVisible.length === 0
    const sectionsPromise = shouldRefreshSections
      ? sectionsStore.refreshSectionDefs()
      : Promise.resolve()

    let paper: any
    let pagesData: any
    try {
      const result = await Promise.all([
        api(`/papers/${paperId}`),
        api(`/papers/${paperId}/pages`),
      ])
      paper = result[0]
      pagesData = result[1]
    } catch (e) {
      if (seq === openPaperSeq && currentPaperId.value === paperId) {
        paperOpening.value = false
        currentPaperCacheToken.value = null
        pages.value = []
        currentPageIndex.value = -1
        markStore.pageQuestions = []
        appStore.setStatus('打开试卷失败: ' + String(e), 'err')
      }
      return
    }
    if (seq !== openPaperSeq || currentPaperId.value !== paperId) return

    currentPaperCacheToken.value = extractCacheBustToken(paper?.pdf_url)
    currentQpPaperName.value = formatPaperName(paper)
    pages.value = pagesData.pages || []
    let openedWithPendingMessage = false

    if (pendingOcrDraftByPaperId.has(paperId)) {
      const drafts = pendingOcrDraftByPaperId.get(paperId) || []
      if (Array.isArray(drafts) && drafts.length) {
        const validDrafts = drafts.filter((d) => d != null) as any[]
        markStore.ocrDraftQuestions = validDrafts
          .map((q: any) => ({
            label: String(q?.label ?? '?').trim() || '?',
            sections: Array.isArray(q?.sections) ? q.sections : (q?.section ? [q.section] : []),
            source: q?.source,
          }))
          .filter((q: any) => q && q.label)

        if (pendingOcrDraftSelectedIdxByPaperId.has(paperId)) {
          markStore.selectedOcrDraftIdx = clampInt(
            pendingOcrDraftSelectedIdxByPaperId.get(paperId),
            0,
            Math.max(0, markStore.ocrDraftQuestions.length - 1),
          )
        }

        const flat: any[] = []
        markStore.ocrDraftQuestions.forEach((q, draftIdx) => {
          if (!q || !validDrafts[draftIdx]) return
          const boxes = (validDrafts[draftIdx]?.boxes || [])
          for (const item of boxes) {
            const page = Number(item?.page)
            const bbox = toBoundingBox(item?.bbox)
            if (Number.isFinite(page) && bbox) {
              flat.push({ page, bbox, source: 'ocr', label: q.label, draftIdx })
            }
          }
        })

        markStore.newBoxes = flat
        markStore.selectedNewBox = markStore.newBoxes[0] || null
        const preferred = markStore.newBoxes.find(
          (b) => b && b.source === 'ocr' && Number(b.draftIdx) === Number(markStore.selectedOcrDraftIdx),
        )
        if (preferred) markStore.selectedNewBox = preferred

        const firstPage = markStore.selectedNewBox ? markStore.selectedNewBox.page : null
        if (firstPage != null && pages.value.length) {
          const idx = pages.value.findIndex((p) => p.page === firstPage)
          if (idx >= 0) currentPageIndex.value = idx
        }
        appStore.setStatus(
          `已自动识别 ${markStore.ocrDraftQuestions.length} 题 / ${markStore.newBoxes.length} 框（未保存，请检查后再保存）`,
          'ok',
        )
        openedWithPendingMessage = true
      }
    } else if (pendingOcrBoxesByPaperId.has(paperId)) {
      const ocrBoxes = pendingOcrBoxesByPaperId.get(paperId) || []
      pendingOcrBoxesByPaperId.delete(paperId)
      if (Array.isArray(ocrBoxes) && ocrBoxes.length) {
        markStore.newBoxes = ocrBoxes
          .map((b: any) => {
            const page = Number(b?.page)
            const bbox = toBoundingBox(b?.bbox)
            return Number.isFinite(page) && bbox
              ? { page, bbox, source: 'ocr', label: b?.label ?? null }
              : null
          })
          .filter((b): b is NonNullable<typeof b> => b != null)
        markStore.selectedNewBox = markStore.newBoxes[0] || null
        const firstPage = markStore.selectedNewBox ? markStore.selectedNewBox.page : null
        if (firstPage != null && pages.value.length) {
          const idx = pages.value.findIndex((p) => p.page === firstPage)
          if (idx >= 0) currentPageIndex.value = idx
        }
        appStore.setStatus(`已生成 ${markStore.newBoxes.length} 个建议框（未保存，请检查后再保存）`, 'ok')
        openedWithPendingMessage = true
      }
    }

    if (pendingOcrWarningByPaperId.has(paperId)) {
      const warning = pendingOcrWarningByPaperId.get(paperId)
      pendingOcrWarningByPaperId.delete(paperId)
      if (warning) {
        appStore.setStatus(String(warning), 'err')
        openedWithPendingMessage = true
      }
    }

    const lastPageNum = getLastMarkedPageNum(paperId, currentPaperCacheToken.value)
    if (pages.value.length && lastPageNum != null) {
      const idx = pages.value.findIndex((p) => p.page === lastPageNum)
      currentPageIndex.value = idx >= 0 ? idx : 0
    } else {
      currentPageIndex.value = pages.value.length ? 0 : -1
    }
    paperOpening.value = false

    let postOpenLoadFailed = false
    try {
      await Promise.all([
        sectionsPromise,
        markStore.loadPageQuestions(),
      ])
    } catch (e) {
      if (seq === openPaperSeq && currentPaperId.value === paperId) {
        postOpenLoadFailed = true
        appStore.setStatus('页面题目加载失败: ' + String(e), 'err')
      }
    }
    if (seq !== openPaperSeq || currentPaperId.value !== paperId) return
    markStore.ensurePaperAlignRefFromFirstQuestion(paperId).catch(() => {})
    if (!openedWithPendingMessage && !postOpenLoadFailed) {
      appStore.setStatus(`已打开：${formatPaperName(paper) || `#${paperId}`}`, 'ok')
    }
    markStore.resetMarkHistory()
  }

  async function openMsPaper(msPaperId: number) {
    const msDetail = await api(`/papers/${msPaperId}`)
    currentMsPaperName.value = formatPaperName(msDetail)
    currentMsCacheToken.value = extractCacheBustToken(msDetail?.pdf_url)
  }

  function closePaper() {
    const markStore = useMarkStore()
    currentPaperId.value = null
    currentQpPaperName.value = ''
    currentMsPaperName.value = ''
    currentPaperCacheToken.value = null
    currentMsCacheToken.value = null
    pages.value = []
    currentPageIndex.value = -1
    paperOpening.value = false
    suggestedNextNo.value = null
    markStore.exitEditQuestionMode()
    markStore.pageQuestions = []
    markStore.newBoxes = []
    markStore.selectedNewBox = null
    markStore.ocrDraftQuestions = []
    markStore.selectedOcrDraftIdx = 0
    markStore.qNotes = ''
    markStore.resetMarkHistory()
  }

  async function goToPage(idx: number) {
    if (idx < 0 || idx >= pages.value.length) return
    currentPageIndex.value = idx
    if (currentPaperId.value != null) {
      setLastMarkedPageNum(currentPaperId.value, currentPaperCacheToken.value, pages.value[idx].page)
    }
  }

  async function prevPage() {
    if (currentPageIndex.value > 0) {
      await goToPage(currentPageIndex.value - 1)
    }
  }

  async function nextPage() {
    if (currentPageIndex.value < pages.value.length - 1) {
      await goToPage(currentPageIndex.value + 1)
    }
  }

  async function refreshSuggestedNextNo() {
    if (!currentPaperId.value) return
    try {
      const data = await api(`/papers/${currentPaperId.value}/questions`)
      const qs = data.questions || []
      let maxNo = 0
      for (const q of qs) {
        const qNo = q.question_no
        if (qNo == null) continue
        const s = String(qNo).trim()
        if (!/^\d+$/.test(s)) continue
        const n = parseInt(s, 10)
        if (!Number.isNaN(n)) maxNo = Math.max(maxNo, n)
      }
      const paperNext = maxNo + 1
      const globalNext = globalSuggestedNextNo.value != null ? globalSuggestedNextNo.value : 1
      suggestedNextNo.value = Math.max(paperNext, globalNext)
    } catch {
      // ignore
    }
  }

  async function uploadPdf(files: FileList | File[]): Promise<number | null> {
    const appStore = useAppStore()
    const settingsStore = useSettingsStore()
    const maxSize = 100 * 1024 * 1024
    for (const f of Array.from(files)) {
      if (f.size > maxSize) {
        appStore.setStatus('存在超过 100MB 的文件', 'err')
        uploadStatus.value = '存在超过 100MB 的文件'
        return null
      }
    }
    const fd = new FormData()
    for (const f of Array.from(files)) fd.append('files', f)
    fd.append('ocr_auto', String(settingsStore.ocrAutoEnabled))
    fd.append('ocr_min_height_px', String(clampInt(settingsStore.ocrMinHeightPx, 0, 2000)))
    fd.append('ocr_y_padding_px', String(clampInt(settingsStore.ocrYPaddingPx, 0, 500)))
    uploading.value = true
    appStore.setStatus('上传中...')
    uploadStatus.value = '上传中...'
    try {
      const data = await api('/upload_pdfs', { method: 'POST', body: fd })
      const warnings = data?.warnings || []
      if (warnings.length) {
        if (warnings[0]?.warning) appStore.setStatus(String(warnings[0].warning), 'err')
        else appStore.setStatus(`上传完成，但有 ${warnings.length} 个文件自动识别被跳过/有提示`, 'err')
        uploadStatus.value = warnings[0]?.warning || `上传完成，但有 ${warnings.length} 个文件自动识别被跳过/有提示`
      } else {
        appStore.setStatus('上传完成', 'ok')
        uploadStatus.value = '上传完成'
      }
      let openedPaperId: number | null = null
      await refreshPapers()
      if (data?.papers?.length) {
        const ocrWarnings = data.papers
          .map((item: any) => stashPendingOcrUploadResult(item))
          .filter((msg: string | null): msg is string => !!msg)
        if (ocrWarnings.length && !warnings.length) {
          appStore.setStatus(String(ocrWarnings[0]), 'err')
          uploadStatus.value = String(ocrWarnings[0])
        }
        const last = data.papers[data.papers.length - 1]
        const lastId = Number(last?.id ?? last?.paper_id)
        if (Number.isFinite(lastId)) {
          openedPaperId = lastId
          await openPaper(lastId)
        }
      }
      return openedPaperId
    } catch (e) {
      appStore.setStatus(String(e), 'err')
      uploadStatus.value = String(e)
      return null
    } finally {
      uploading.value = false
    }
  }

  async function deletePaper(paperId: number): Promise<boolean> {
    const appStore = useAppStore()
    const dialogStore = useDialogStore()
    const t = i18n.global.t
    if (!await dialogStore.confirm(t('paperList.deleteConfirm', { id: paperId }), {
      title: t('paperList.deleteTitle'),
      confirmText: t('dialog.delete'),
      danger: true,
    })) return false
    const confirmText = await dialogStore.prompt(
      t('paperList.deletePrompt', { id: paperId }),
      '',
      {
        title: t('paperList.deletePromptTitle'),
        confirmText: t('dialog.delete'),
        danger: true,
      },
    )
    if (String(confirmText || '').trim() !== String(paperId)) return false
    try {
      appStore.setStatus(`删除整卷 #${paperId}...`)
      await api(`/papers/${paperId}`, { method: 'DELETE' })
      appStore.setStatus('已删除', 'ok')
      if (currentPaperId.value === paperId) closePaper()
      await refreshPapers()
      return true
    } catch (e) {
      appStore.setStatus(String(e), 'err')
      return false
    }
  }

  return {
    // state
    papers,
    allPaperFilenames,
    currentPaperId,
    currentQpPaperName,
    currentMsPaperName,
    currentPaperCacheToken,
    currentMsCacheToken,
    pages,
    currentPageIndex,
    paperOpening,
    uploading,
    uploadStatus,
    showDonePapers,
    globalSuggestedNextNo,
    suggestedNextNo,
    // computed
    currentPaper,
    viewPapers,
    paperCountHint,
    showDonePapersText,
    paperTitleText,
    pageInfoText,
    canPrevPage,
    canNextPage,
    canOpenAnswer,
    // actions
    refreshPapers,
    refreshStats,
    refreshSuggestedNextNo,
    toggleShowDonePapers,
    openPaper,
    openMsPaper,
    closePaper,
    goToPage,
    prevPage,
    nextPage,
    uploadPdf,
    deletePaper,
    formatPaperName,
  }
})
