import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import router from '@/router'
import { useAppStore } from './app'
import { usePapersStore } from './papers'
import { useSettingsStore } from './settings'
import { useFilterStore } from './filter'
import { useDialogStore } from './dialog'
import { i18n } from '@/i18n'
import { api } from '@/api/client'
import type { BoundingBox } from '@/types/common'
import type { AnswerPaperListItem, Page } from '@/types/paper'
import {
  alignAnswerBBoxToBoundsX,
} from '@/utils/alignment'
import type { AlignBounds } from '@/utils/alignment'
import { extractCacheBustToken } from '@/utils/paper'

const ANSWER_HISTORY_LIMIT = 50

// Helpers matching old frontend/app/helpers.js
function deriveMsCode(codeOrFilename: string): string | null {
  const s = String(codeOrFilename || '').replace(/\.pdf$/i, '')
  if (/_qp_/i.test(s)) return s.replace(/_qp_/i, '_ms_')
  return null
}
function findMatchedMsPaper(paperDetail: any, papers: any[]) {
  const list = Array.isArray(papers) ? papers : []
  const pairedId = paperDetail?.paired_paper_id
  if (pairedId) return list.find((p) => p.id === pairedId) || { id: pairedId }
  const msCode = deriveMsCode(paperDetail?.exam_code || paperDetail?.filename)
  if (!msCode) return null
  const byExam = list.find((p) => String(p.exam_code || '') === msCode)
  if (byExam) return byExam
  return list.find((p) => String(p.filename || '').includes(msCode)) || null
}
function sortQuestionsByNoAsc(qs: any[]) {
  const arr = Array.from(qs || [])
  arr.sort((a, b) => {
    const aNo = a.question_no
    const bNo = b.question_no
    const an = aNo != null && String(aNo).trim().match(/^\d+$/) ? parseInt(String(aNo).trim(), 10) : Number.POSITIVE_INFINITY
    const bn = bNo != null && String(bNo).trim().match(/^\d+$/) ? parseInt(String(bNo).trim(), 10) : Number.POSITIVE_INFINITY
    if (an !== bn) return an - bn
    return (a.id || 0) - (b.id || 0)
  })
  return arr
}
function answerProgressKey(kind: string, qpId: number, qpToken: string | null, msId: number, msToken: string | null) {
  if (!qpId || !msId) return null
  return `answerProgress:${kind}:${qpId}:${qpToken || ''}:${msId}:${msToken || ''}`
}
function getAnswerProgress(kind: string, qpId: number, qpToken: string | null, msId: number, msToken: string | null): number | null {
  const key = answerProgressKey(kind, qpId, qpToken, msId, msToken)
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    const n = raw != null ? parseInt(raw, 10) : NaN
    return Number.isFinite(n) ? n : null
  } catch { return null }
}
function setAnswerProgress(kind: string, qpId: number, qpToken: string | null, msId: number, msToken: string | null, value: number) {
  const key = answerProgressKey(kind, qpId, qpToken, msId, msToken)
  if (!key) return
  try { localStorage.setItem(key, String(value)) } catch {}
}

function answerAlignRefKey(qpId: number | null | undefined, msId: number | null | undefined): string | null {
  if (!qpId || !msId) return null
  return `setting:answerAlignRef:${qpId}:${msId}`
}

function loadAnswerAlignRef(qpId: number | null | undefined, msId: number | null | undefined): AlignBounds | null {
  const key = answerAlignRefKey(qpId, msId)
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : null
    const x0 = parsed?.[0]
    const x1 = parsed?.[1]
    if (typeof x0 !== 'number' || !Number.isFinite(x0) || typeof x1 !== 'number' || !Number.isFinite(x1)) return null
    return [Math.max(0, Math.min(1, Math.min(x0, x1))), Math.max(0, Math.min(1, Math.max(x0, x1)))]
  } catch {
    return null
  }
}

function saveAnswerAlignRef(qpId: number | null | undefined, msId: number | null | undefined, bounds: AlignBounds | null) {
  const key = answerAlignRefKey(qpId, msId)
  if (!key || !bounds) return
  try { localStorage.setItem(key, JSON.stringify(bounds)) } catch {}
}

export interface AnswerBoxState {
  page: number
  bbox: BoundingBox
}

interface AnswerSnapshot {
  boxes: AnswerBoxState[]
  selectedIndex: number
}

interface AnswerDragOp {
  kind: 'move' | 'resize'
  box: AnswerBoxState
  corner?: string
  offX?: number
  offY?: number
  w?: number
  h?: number
  idx?: number
}

interface AnswerMsScrollTarget {
  page: number
  bbox?: BoundingBox | null
}

function cloneAnswerBoxes(list: AnswerBoxState[]): AnswerBoxState[] {
  if (!Array.isArray(list)) return []
  return list.map((b) => ({
    ...b,
    bbox: Array.isArray(b?.bbox) ? ([...b.bbox] as BoundingBox) : [0, 0, 0, 0],
  }))
}

function answerBoxesEqual(a: AnswerBoxState[], b: AnswerBoxState[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i]
    if (!x || !y) return false
    if (x.page !== y.page) return false
    const xb = Array.isArray(x.bbox) ? x.bbox : []
    const yb = Array.isArray(y.bbox) ? y.bbox : []
    if (xb.length !== yb.length) return false
    for (let j = 0; j < xb.length; j++) { if (xb[j] !== yb[j]) return false }
  }
  return true
}

function alignAnswerBoxStatesToBoundsX(boxes: AnswerBoxState[], bounds: AlignBounds | null | undefined): AnswerBoxState[] {
  if (!bounds) return boxes
  return boxes.map((b) => ({
    page: b.page,
    bbox: alignAnswerBBoxToBoundsX(b.bbox, bounds) as BoundingBox,
  }))
}

export const useAnswerStore = defineStore('answer', () => {
  // --- state ---
  const msPaperId = ref<number | null>(null)
  const msPages = ref<Page[]>([])
  const msCanvasByPage = ref(new Map<number, HTMLCanvasElement>())
  const answerQuestions = ref<any[]>([])
  const answerQIndex = ref(-1)
  const answerExistingBoxes = ref<AnswerBoxState[]>([])
  const answerNewBoxes = ref<AnswerBoxState[]>([])
  const answerDrawing = ref<{ page: number; startX: number; startY: number } | null>(null)
  const selectedAnswerNew = ref<AnswerBoxState | null>(null)
  const dragAnswerOp = ref<AnswerDragOp | null>(null)
  const answerUndoStack = ref<AnswerSnapshot[]>([])
  const answerRedoStack = ref<AnswerSnapshot[]>([])
  const answerAlignRef = ref<[number, number] | null>(null)
  const answerPendingSnapshot = ref<AnswerSnapshot | null>(null)
  const answerPaperList = ref<AnswerPaperListItem[]>([])
  const answerReplaceMode = ref(false)
  const answerReplaceQuestionId = ref<number | null>(null)
  const answerReadyPaperId = ref<number | null>(null)
  const answerOpening = ref(false)
  let _getVisibleMsPageNum: (() => number | null) | null = null
  let _scrollToMsTarget: ((target: AnswerMsScrollTarget) => void) | null = null
  let _pendingMsScrollTarget: AnswerMsScrollTarget | null = null

  // --- computed ---
  const currentAnswerQuestion = computed(() => {
    if (answerQIndex.value < 0 || answerQIndex.value >= answerQuestions.value.length) return null
    return answerQuestions.value[answerQIndex.value] || null
  })

  const answerQInfoText = computed(() => {
    if (answerQIndex.value < 0 || answerQIndex.value >= answerQuestions.value.length) return '题号 -'
    const q = answerQuestions.value[answerQIndex.value]
    return `题号 ${q.question_no || '(未填)'} / 共 ${answerQuestions.value.length}`
  })

  const answerQuestionMetaText = computed(() => {
    const q = answerQuestions.value[answerQIndex.value]
    if (!q) return ''
    return q.section || '(未填模块)'
  })

  const answerBoxesHintText = computed(() =>
    `已保存框：${answerExistingBoxes.value.length}，本次新框：${answerNewBoxes.value.length}`
  )

  const canPrevAnswer = computed(() => answerQIndex.value > 0)
  const canNextAnswer = computed(() =>
    answerQIndex.value >= 0 && answerQIndex.value < answerQuestions.value.length - 1
  )

  // --- undo/redo ---
  function resetAnswerHistory() {
    answerUndoStack.value = []
    answerRedoStack.value = []
    answerPendingSnapshot.value = null
  }

  function resetAnswerWorkspace(options: { clearMs?: boolean } = {}) {
    const clearMs = options.clearMs !== false
    answerReadyPaperId.value = null
    answerQuestions.value = []
    answerQIndex.value = -1
    answerExistingBoxes.value = []
    answerNewBoxes.value = []
    selectedAnswerNew.value = null
    answerDrawing.value = null
    dragAnswerOp.value = null
    resetAnswerHistory()
    if (clearMs) {
      msPaperId.value = null
      msPages.value = []
      answerAlignRef.value = null
    }
  }

  function setAnswerViewBridge(bridge: { getVisibleMsPageNum?: (() => number | null) | null; scrollToMsPage?: ((pageNum: number) => void) | null; scrollToMsTarget?: ((target: AnswerMsScrollTarget) => void) | null } | null) {
    _getVisibleMsPageNum = bridge?.getVisibleMsPageNum || null
    const pageScroller = bridge?.scrollToMsPage || null
    _scrollToMsTarget = bridge?.scrollToMsTarget || (pageScroller ? (target: AnswerMsScrollTarget) => pageScroller(target.page) : null)
    if (_scrollToMsTarget && _pendingMsScrollTarget != null) {
      const target = _pendingMsScrollTarget
      _pendingMsScrollTarget = null
      _scrollToMsTarget(target)
    }
  }

  function scrollToAnswerMsTarget(target: AnswerMsScrollTarget | null | undefined) {
    const n = Number(target?.page)
    if (!Number.isFinite(n)) return
    const bbox = Array.isArray(target?.bbox) && target.bbox.length === 4
      ? ([...target.bbox] as BoundingBox)
      : null
    const safeTarget: AnswerMsScrollTarget = { page: n, bbox }
    if (_scrollToMsTarget) {
      _scrollToMsTarget(safeTarget)
    } else {
      _pendingMsScrollTarget = safeTarget
    }
  }

  function scrollToAnswerMsPage(pageNum: number | null | undefined) {
    const n = Number(pageNum)
    if (!Number.isFinite(n)) return
    scrollToAnswerMsTarget({ page: n })
  }

  function scrollToAnswerMsBox(box: AnswerBoxState | null | undefined) {
    if (!box) return
    scrollToAnswerMsTarget({ page: Number(box.page), bbox: box.bbox })
  }

  function recordAnswerScrollProgress(q: any = currentAnswerQuestion.value) {
    const papersStore = usePapersStore()
    if (!q || papersStore.currentPaperId == null || msPaperId.value == null) return
    let curMsPage = _getVisibleMsPageNum?.() ?? null
    if (curMsPage == null) {
      const all = answerNewBoxes.value.length ? answerNewBoxes.value : answerExistingBoxes.value
      if (all?.length) {
        curMsPage = all.reduce((max, b) => {
          const page = Number(b?.page)
          return Number.isFinite(page) && page > max ? page : max
        }, 0) || null
      }
    }
    if (curMsPage != null) {
      setAnswerProgress(`msPage:${q.id}`, papersStore.currentPaperId, papersStore.currentPaperCacheToken, msPaperId.value, papersStore.currentMsCacheToken, curMsPage)
      setAnswerProgress('lastMsPage', papersStore.currentPaperId, papersStore.currentPaperCacheToken, msPaperId.value, papersStore.currentMsCacheToken, curMsPage)
    }
  }

  async function backFromAnswer() {
    const appStore = useAppStore()
    const filterStore = useFilterStore()
    const wasReplace = answerReplaceMode.value
    const replaceQid = answerReplaceQuestionId.value
    recordAnswerScrollProgress()
    resetAnswerWorkspace({ clearMs: true })
    answerReplaceMode.value = false
    answerReplaceQuestionId.value = null
    answerOpening.value = false
    const restored = wasReplace || appStore.navStack.some((x) => x.kind === 'filter')
      ? await filterStore.returnToFilterFromNavStack()
      : false
    if (restored) return
    if (replaceQid != null) {
      filterStore.filterReturnQid = replaceQid
      const fallbackRestored = await filterStore.returnToFilterFromNavStack()
      if (fallbackRestored) return
      await router.push({ name: 'filter' })
      return
    }
    appStore.setView('mark')
    const paperId = usePapersStore().currentPaperId
    await router.push(paperId ? { name: 'mark', params: { paperId: String(paperId) } } : { name: 'mark' })
  }

  function beginAnswerReplaceMode(questionId: number) {
    const safeId = Number(questionId)
    if (!Number.isFinite(safeId)) return
    answerReplaceMode.value = true
    answerReplaceQuestionId.value = safeId
    answerOpening.value = true
    resetAnswerWorkspace({ clearMs: true })
  }

  function captureAnswerSnapshot(): AnswerSnapshot {
    const selectedIndex = selectedAnswerNew.value ? answerNewBoxes.value.indexOf(selectedAnswerNew.value) : -1
    return { boxes: cloneAnswerBoxes(answerNewBoxes.value), selectedIndex }
  }

  function restoreAnswerSnapshot(snapshot: AnswerSnapshot) {
    if (!snapshot) return
    answerNewBoxes.value = cloneAnswerBoxes(snapshot.boxes)
    const idx = typeof snapshot.selectedIndex === 'number' ? snapshot.selectedIndex : -1
    selectedAnswerNew.value = idx >= 0 && answerNewBoxes.value[idx] ? answerNewBoxes.value[idx] : null
    answerDrawing.value = null
    dragAnswerOp.value = null
  }

  function commitAnswerHistory(snapshot: AnswerSnapshot) {
    if (!snapshot) return
    if (answerBoxesEqual(snapshot.boxes, answerNewBoxes.value)) return
    answerUndoStack.value.push(snapshot)
    if (answerUndoStack.value.length > ANSWER_HISTORY_LIMIT) answerUndoStack.value.shift()
    answerRedoStack.value = []
  }

  function undoAnswer() {
    if (!answerUndoStack.value.length) return
    const current = captureAnswerSnapshot()
    const prev = answerUndoStack.value.pop()!
    answerRedoStack.value.push(current)
    restoreAnswerSnapshot(prev)
  }

  function redoAnswer() {
    if (!answerRedoStack.value.length) return
    const current = captureAnswerSnapshot()
    const next = answerRedoStack.value.pop()!
    answerUndoStack.value.push(current)
    restoreAnswerSnapshot(next)
  }

  function getAnswerAlignBounds(): AlignBounds | null {
    const settingsStore = useSettingsStore()
    if (!settingsStore.answerAlignEnabled) return null
    if (Array.isArray(answerAlignRef.value) && answerAlignRef.value.length === 2) {
      const [a, b] = answerAlignRef.value
      if (Number.isFinite(a) && Number.isFinite(b)) return [Math.max(0, Math.min(a, b)), Math.min(1, Math.max(a, b))]
    }
    const first = answerNewBoxes.value[0] || answerExistingBoxes.value[0] || null
    const bb = first?.bbox
    if (!Array.isArray(bb) || bb.length !== 4) return null
    return [Math.max(0, Math.min(bb[0], bb[2])), Math.min(1, Math.max(bb[0], bb[2]))]
  }

  function alignAnswerBBoxToCurrentBounds(bbox: BoundingBox): BoundingBox {
    const settingsStore = useSettingsStore()
    if (!settingsStore.answerAlignEnabled) return bbox
    const aligned = alignAnswerBBoxToBoundsX(bbox, getAnswerAlignBounds())
    return (Array.isArray(aligned) && aligned.length === 4 ? aligned : bbox) as BoundingBox
  }

  async function ensureAnswerAlignRefFromFirstQuestion() {
    const settingsStore = useSettingsStore()
    const papersStore = usePapersStore()
    if (!settingsStore.answerAlignEnabled || answerAlignRef.value != null) return
    if (!papersStore.currentPaperId || !msPaperId.value) return
    const loaded = loadAnswerAlignRef(papersStore.currentPaperId, msPaperId.value)
    if (loaded) {
      answerAlignRef.value = loaded
      return
    }
    const first = answerQuestions.value?.[0]
    if (!first?.id) return
    try {
      const d = await api(`/questions/${first.id}/answer`)
      const bb = d?.answer?.boxes?.[0]?.bbox
      if (Array.isArray(bb) && bb.length === 4) {
        answerAlignRef.value = [bb[0], bb[2]]
        saveAnswerAlignRef(papersStore.currentPaperId, msPaperId.value, answerAlignRef.value)
      }
    } catch {}
  }

  // --- open answer mode ---
  async function openAnswerForPaper(forcedMsId: number | null = null, forcedQuestionId: number | null = null) {
    const appStore = useAppStore()
    const papersStore = usePapersStore()
    if (!papersStore.currentPaperId) {
      answerOpening.value = false
      return
    }
    answerOpening.value = true
    resetAnswerWorkspace({ clearMs: true })
    try {
      const qp = await api(`/papers/${papersStore.currentPaperId}`)
      let answerPapers: any[] = []
      if (!forcedMsId) {
        try {
          const answerData = await api('/answer_papers')
          answerPapers = Array.isArray(answerData?.papers) ? answerData.papers : []
          answerPaperList.value = answerPapers as AnswerPaperListItem[]
        } catch {
          answerPapers = []
        }
      }
      const msMatch = forcedMsId ? { id: forcedMsId } : findMatchedMsPaper(qp, answerPapers)
      const msId = msMatch?.id || null
      if (!msId) {
        appStore.setStatus('未找到答案卷，请先上传答案卷（MS）。', 'err')
        return
      }
      msPaperId.value = msId
      const msDetail = await api(`/papers/${msId}`)
      papersStore.currentMsCacheToken = extractCacheBustToken(msDetail?.pdf_url)
      const msPagesData = await api(`/papers/${msId}/pages`)
      msPages.value = msPagesData.pages || []
      const qData = await api(`/papers/${papersStore.currentPaperId}/questions`)
      const qs = qData.questions || []
      if (!qs.length) {
        appStore.setStatus('该试卷还没有题目。', 'err')
        return
      }
      answerQuestions.value = sortQuestionsByNoAsc(qs)
      answerQIndex.value = 0
      if (forcedQuestionId) {
        const idx = answerQuestions.value.findIndex((q) => q.id === forcedQuestionId)
        if (idx >= 0) answerQIndex.value = idx
      } else {
        const last = getAnswerProgress('q', papersStore.currentPaperId, papersStore.currentPaperCacheToken, msId, papersStore.currentMsCacheToken)
        if (last != null && last >= 0 && last < answerQuestions.value.length) answerQIndex.value = last
      }
      answerAlignRef.value = loadAnswerAlignRef(papersStore.currentPaperId, msId)
      await ensureAnswerAlignRefFromFirstQuestion()
      appStore.setView('answer')
      await loadAnswerQuestion(answerQIndex.value)
      answerReadyPaperId.value = papersStore.currentPaperId
      appStore.setStatus(`答案模式：共 ${answerQuestions.value.length} 题`, 'ok')
    } catch (e) {
      appStore.setStatus('答案模式加载失败: ' + String(e), 'err')
    } finally {
      answerOpening.value = false
    }
  }

  async function loadAnswerQuestion(index: number, opts: { preserveScroll?: boolean } = {}) {
    if (index < 0 || index >= answerQuestions.value.length) return
    const preserveScroll = !!opts.preserveScroll
    const prev = answerQuestions.value[answerQIndex.value]
    const q = answerQuestions.value[index]
    if (prev && prev.id !== q.id) recordAnswerScrollProgress(prev)
    answerQIndex.value = index
    answerNewBoxes.value = []
    answerExistingBoxes.value = []
    resetAnswerHistory()
    try {
      const d = await api(`/questions/${q.id}/answer`)
      if (d && d.answer && d.answer.boxes) {
        answerExistingBoxes.value = d.answer.boxes.map((b: any) => ({ page: b.page, bbox: b.bbox }))
        const settingsStore = useSettingsStore()
        if (settingsStore.answerAlignEnabled && answerAlignRef.value) {
          answerExistingBoxes.value = alignAnswerBoxStatesToBoundsX(answerExistingBoxes.value, answerAlignRef.value)
        }
      }
    } catch {}
    if (answerReplaceMode.value && answerReplaceQuestionId.value === q.id) {
      answerNewBoxes.value = answerExistingBoxes.value.map((b) => ({ page: b.page, bbox: [...b.bbox] as BoundingBox }))
      answerExistingBoxes.value = []
      const settingsStore = useSettingsStore()
      if (settingsStore.answerAlignEnabled) {
        const bounds = getAnswerAlignBounds()
        answerNewBoxes.value = alignAnswerBoxStatesToBoundsX(answerNewBoxes.value, bounds)
      }
      selectedAnswerNew.value = answerNewBoxes.value[0] || null
      useAppStore().setStatus(`修改答案：题目 #${q.id}`, 'ok')
    }
    setAnswerProgressIndex()
    if (preserveScroll) return

    if (answerReplaceMode.value && answerReplaceQuestionId.value === q.id) {
      const list = answerNewBoxes.value.length ? answerNewBoxes.value : answerExistingBoxes.value
      const targetBox = list?.[0] || null
      if (targetBox?.page != null) {
        scrollToAnswerMsBox(targetBox)
        return
      }
    }

    const papersStore = usePapersStore()
    if (papersStore.currentPaperId && msPaperId.value) {
      const saved = getAnswerProgress(`msPage:${q.id}`, papersStore.currentPaperId, papersStore.currentPaperCacheToken, msPaperId.value, papersStore.currentMsCacheToken)
      if (saved != null) {
        scrollToAnswerMsPage(saved)
        return
      }
      const all = answerNewBoxes.value.length ? answerNewBoxes.value : answerExistingBoxes.value
      if (all?.length) {
        const targetBox = all.find((b) => Number.isFinite(Number(b?.page))) || null
        if (targetBox) {
          scrollToAnswerMsBox(targetBox)
          return
        }
      }
      const lastMs = getAnswerProgress('lastMsPage', papersStore.currentPaperId, papersStore.currentPaperCacheToken, msPaperId.value, papersStore.currentMsCacheToken)
      if (lastMs != null) scrollToAnswerMsPage(lastMs)
    }
  }

  function setAnswerProgressIndex() {
    const papersStore = usePapersStore()
    if (papersStore.currentPaperId && msPaperId.value) {
      setAnswerProgress('q', papersStore.currentPaperId, papersStore.currentPaperCacheToken, msPaperId.value, papersStore.currentMsCacheToken, answerQIndex.value)
    }
  }

  async function saveAnswer(_opts: { preserveScroll?: boolean } = {}): Promise<boolean> {
    const appStore = useAppStore()
    const papersStore = usePapersStore()
    const q = answerQuestions.value[answerQIndex.value]
    if (!q || msPaperId.value == null) return false
    recordAnswerScrollProgress(q)
    const isReplace = answerReplaceMode.value && answerReplaceQuestionId.value === q.id
    const merged: AnswerBoxState[] = []
    if (!isReplace) {
      for (const b of answerExistingBoxes.value) merged.push({ page: b.page, bbox: b.bbox })
    }
    for (const b of answerNewBoxes.value) merged.push({ page: b.page, bbox: b.bbox })
    const settingsStore = useSettingsStore()
    if (settingsStore.answerAlignEnabled && merged.length) {
      if (!answerAlignRef.value && papersStore.currentPaperId && msPaperId.value) {
        const bb = merged[0].bbox
        answerAlignRef.value = [bb[0], bb[2]]
        saveAnswerAlignRef(papersStore.currentPaperId, msPaperId.value, answerAlignRef.value)
      }
    }
    const bounds = getAnswerAlignBounds()
    const aligned = settingsStore.answerAlignEnabled
      ? alignAnswerBoxStatesToBoundsX(merged, bounds)
      : merged
    try {
      appStore.setStatus(`保存答案中：题目 #${q.id}...`)
      await api(`/questions/${q.id}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ms_paper_id: msPaperId.value, boxes: aligned }),
      })
      appStore.setStatus('已保存', 'ok')
      answerExistingBoxes.value = aligned.map((b) => ({ page: b.page, bbox: b.bbox }))
      answerNewBoxes.value = []
      resetAnswerHistory()
      setAnswerProgressIndex()
      if (isReplace) {
        answerReplaceMode.value = false
        answerReplaceQuestionId.value = null
        await useFilterStore().returnToFilterFromNavStack()
      }
      return true
    } catch (e) {
      appStore.setStatus(String(e), 'err')
      return false
    }
  }

  async function navigateAnswer(direction: 'prev' | 'next') {
    if (direction === 'prev' && answerQIndex.value > 0) {
      await loadAnswerQuestion(answerQIndex.value - 1)
    } else if (direction === 'next' && answerQIndex.value < answerQuestions.value.length - 1) {
      const needSave = answerNewBoxes.value.length > 0
      if (needSave) await saveAnswer({ preserveScroll: true })
      await loadAnswerQuestion(answerQIndex.value + 1, { preserveScroll: true })
    }
  }

  async function refreshAnswerPapers() {
    const appStore = useAppStore()
    try {
      appStore.setStatus('加载答案卷中...')
      const data = await api('/answer_papers')
      const aps = data.papers || []
      const sortVal = (p: any) => {
        const v = p.display_no != null ? Number(p.display_no) : Number(p.id)
        return Number.isFinite(v) ? v : 0
      }
      answerPaperList.value = aps.slice().sort((a: any, b: any) => sortVal(b) - sortVal(a))
      appStore.setStatus(`答案卷数量：${aps.length}`, 'ok')
    } catch (e) {
      appStore.setStatus(String(e), 'err')
      answerPaperList.value = []
    }
  }

  async function clearAnswerBoxes() {
    if (selectedAnswerNew.value) {
      const snapshot = captureAnswerSnapshot()
      answerNewBoxes.value = answerNewBoxes.value.filter((b) => b !== selectedAnswerNew.value)
      selectedAnswerNew.value = null
      dragAnswerOp.value = null
      answerDrawing.value = null
      if (answerReplaceMode.value && answerNewBoxes.value.length === 0) {
        answerReplaceMode.value = false
        answerReplaceQuestionId.value = null
      }
      commitAnswerHistory(snapshot)
      return
    }
    if (!answerNewBoxes.value.length) return
    const dialogStore = useDialogStore()
    const t = i18n.global.t
    if (!await dialogStore.confirm(t('answer.clearNewBoxesConfirm'), {
      title: t('answer.clearNewBoxesTitle'),
      confirmText: t('dialog.clear'),
      danger: true,
    })) return
    const snapshot = captureAnswerSnapshot()
    answerNewBoxes.value = []
    selectedAnswerNew.value = null
    dragAnswerOp.value = null
    answerDrawing.value = null
    if (answerReplaceMode.value) {
      answerReplaceMode.value = false
      answerReplaceQuestionId.value = null
    }
    commitAnswerHistory(snapshot)
  }

  function answerNeedsSave(): boolean {
    const q = answerQuestions.value[answerQIndex.value]
    if (answerReplaceMode.value && q?.id === answerReplaceQuestionId.value) return true
    return answerNewBoxes.value.length > 0
  }

  return {
    // state
    msPaperId,
    msPages,
    msCanvasByPage,
    answerQuestions,
    answerQIndex,
    answerExistingBoxes,
    answerNewBoxes,
    answerDrawing,
    selectedAnswerNew,
    dragAnswerOp,
    answerUndoStack,
    answerRedoStack,
    answerAlignRef,
    answerPendingSnapshot,
    answerPaperList,
    answerReplaceMode,
    answerReplaceQuestionId,
    answerReadyPaperId,
    answerOpening,
    // computed
    currentAnswerQuestion,
    answerQInfoText,
    answerQuestionMetaText,
    answerBoxesHintText,
    canPrevAnswer,
    canNextAnswer,
    // actions
    resetAnswerHistory,
    resetAnswerWorkspace,
    beginAnswerReplaceMode,
    setAnswerViewBridge,
    scrollToAnswerMsPage,
    scrollToAnswerMsBox,
    recordAnswerScrollProgress,
    backFromAnswer,
    captureAnswerSnapshot,
    restoreAnswerSnapshot,
    commitAnswerHistory,
    undoAnswer,
    redoAnswer,
    getAnswerAlignBounds,
    alignAnswerBBoxToCurrentBounds,
    ensureAnswerAlignRefFromFirstQuestion,
    openAnswerForPaper,
    loadAnswerQuestion,
    setAnswerProgressIndex,
    saveAnswer,
    navigateAnswer,
    refreshAnswerPapers,
    clearAnswerBoxes,
    answerNeedsSave,
  }
})
