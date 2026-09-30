import { ref, computed, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import router from '@/router'
import { useAppStore } from './app'
import { usePapersStore } from './papers'
import { useSettingsStore } from './settings'
import { useFilterStore } from './filter'
import { useDialogStore } from './dialog'
import { i18n } from '@/i18n'
import { api } from '@/api/client'
import { questionsApi } from '@/api/endpoints'
import type { BoundingBox } from '@/types/common'
import type { AnswerPaperListItem, Page, PaperDetail } from '@/types/paper'
import type { Question, AnswerBox as ApiAnswerBox } from '@/types'
import {
  alignAnswerBBoxToBoundsX,
} from '@/utils/alignment'
import type { AlignBounds } from '@/utils/alignment'
import { extractCacheBustToken, sortQuestionsByNoAsc, findFirstUnansweredIndex, clampAnswerProgressIndex, buildAnswerSaveBoxes } from '@/utils/paper'
import {
  createAnswerMachine,
  resolveStateName,
  type AnswerEvent,
} from '@/utils/answerMachine'

const ANSWER_HISTORY_LIMIT = 50

// Helpers matching old frontend/app/helpers.js
function deriveMsCode(codeOrFilename: string): string | null {
  const s = String(codeOrFilename || '').replace(/\.pdf$/i, '')
  if (/_qp_/i.test(s)) return s.replace(/_qp_/i, '_ms_')
  return null
}
function findMatchedMsPaper(paperDetail: PaperDetail, papers: AnswerPaperListItem[]) {
  const list = Array.isArray(papers) ? papers : []
  const pairedId = paperDetail?.paired_paper_id
  if (pairedId) return list.find((p) => p.id === pairedId) || { id: pairedId }
  const msCode = deriveMsCode(paperDetail?.exam_code || paperDetail?.filename)
  if (!msCode) return null
  const byExam = list.find((p) => String(p.exam_code || '') === msCode)
  if (byExam) return byExam
  return list.find((p) => String(p.filename || '').includes(msCode)) || null
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
  /** Stable identity for soft-delete (never an array index). */
  id?: string
  page: number
  bbox: BoundingBox
}

interface AnswerSnapshot {
  boxes: AnswerBoxState[]
  selectedIndex: number
}

export interface AnswerDragOp {
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

let _boxIdSeq = 0
function nextBoxId(prefix: string): string {
  _boxIdSeq += 1
  return `${prefix}-${_boxIdSeq}-${Date.now().toString(36)}`
}

function cloneAnswerBoxes(list: AnswerBoxState[]): AnswerBoxState[] {
  if (!Array.isArray(list)) return []
  return list.map((b) => ({
    id: b.id ?? nextBoxId('box'),
    page: b.page,
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
    id: b.id,
    page: b.page,
    bbox: alignAnswerBBoxToBoundsX(b.bbox, bounds) as BoundingBox,
  }))
}

export const useAnswerStore = defineStore('answer', () => {
  // --- state ---
  const msPaperId = ref<number | null>(null)
  const msPages = ref<Page[]>([])
  // DOM node registry only; mutations to the Map must not trigger component
  // renders from template ref callbacks (especially during OCR page swaps).
  const msCanvasByPage = shallowRef(new Map<number, HTMLCanvasElement>())
  const answerQuestions = ref<Question[]>([])
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
  const answerReadyPaperId = ref<number | null>(null)
  let _getVisibleMsPageNum: (() => number | null) | null = null
  let _scrollToMsTarget: ((target: AnswerMsScrollTarget) => void) | null = null
  let _pendingMsScrollTarget: AnswerMsScrollTarget | null = null

  // --- answer state machine (single source of truth for phase/seq/dirty/replace) ---
  const machine = createAnswerMachine()
  const machineState = shallowRef(machine.getState())

  function dispatch(event: AnswerEvent): boolean {
    const ok = machine.send(event)
    // Always refresh the reactive snapshot so computed state stays in sync
    // even when the event was ignored (snapshot identity is cheap).
    machineState.value = machine.getState()
    return ok
  }

  /** Stable-id set of soft-deleted existing boxes (never array indices). */
  const answerRemovedExistingIds = computed(() => machineState.value.removedBoxIds)
  const answerReplaceMode = computed(() => machineState.value.mode === 'replacing')
  const answerReplaceQuestionId = computed(() => machineState.value.replaceQuestionId)
  const answerOpening = computed(() => machineState.value.phase === 'opening')
  const answerStateName = computed(() => resolveStateName(machineState.value))

  // --- computed ---
  const currentAnswerQuestion = computed(() => {
    if (answerQIndex.value < 0 || answerQIndex.value >= answerQuestions.value.length) return null
    return answerQuestions.value[answerQIndex.value] || null
  })

  const t = i18n.global.t

  const answerQInfoText = computed(() => {
    if (answerQIndex.value < 0 || answerQIndex.value >= answerQuestions.value.length) return t('answer.questionNoEmpty')
    const q = answerQuestions.value[answerQIndex.value]
    return t('answer.questionNoInfo', { no: q.question_no || t('filter.noQuestionNo'), total: answerQuestions.value.length })
  })

  const answerQuestionMetaText = computed(() => {
    const q = answerQuestions.value[answerQIndex.value]
    if (!q) return ''
    return q.section || t('answer.noSection')
  })

  const answerBoxesHintText = computed(() =>
    t('answer.boxesHint', { existing: answerExistingBoxes.value.length, new: answerNewBoxes.value.length })
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

  function recordAnswerScrollProgress(q: Question | null = currentAnswerQuestion.value) {
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
    dispatch({ type: 'BACK' })
    resetAnswerWorkspace({ clearMs: true })
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
    dispatch({ type: 'REPLACE_ENTER', questionId: safeId })
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
    if (!dispatch({ type: 'UNDO' })) return
    const current = captureAnswerSnapshot()
    const prev = answerUndoStack.value.pop()!
    answerRedoStack.value.push(current)
    restoreAnswerSnapshot(prev)
  }

  function redoAnswer() {
    if (!answerRedoStack.value.length) return
    if (!dispatch({ type: 'REDO' })) return
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
  async function openAnswerForPaper(forcedMsId: number | null = null, forcedQuestionId: number | null = null): Promise<boolean> {
    const appStore = useAppStore()
    const papersStore = usePapersStore()
    if (!papersStore.currentPaperId) return false
    if (!dispatch({ type: 'OPEN' })) return false
    const openSeq = machine.getState().seq
    resetAnswerWorkspace({ clearMs: true })
    try {
      const qp = await api(`/papers/${papersStore.currentPaperId}`)
      if (!machine.isCurrentSeq(openSeq)) return false
      let answerPapers: AnswerPaperListItem[] = []
      if (!forcedMsId) {
        try {
          const answerData = await api('/answer_papers')
          answerPapers = Array.isArray(answerData?.papers) ? answerData.papers : []
          answerPaperList.value = answerPapers as AnswerPaperListItem[]
        } catch {
          answerPapers = []
        }
      }
      if (!machine.isCurrentSeq(openSeq)) return false
      const msMatch = forcedMsId ? { id: forcedMsId } : findMatchedMsPaper(qp, answerPapers)
      const msId = msMatch?.id || null
      if (!msId) {
        dispatch({ type: 'OPEN_FAIL', seq: openSeq })
        appStore.setStatus(t('answer.msNotFound'), 'err')
        return false
      }
      msPaperId.value = msId
      const msDetail = await api(`/papers/${msId}`)
      if (!machine.isCurrentSeq(openSeq)) return false
      papersStore.currentMsCacheToken = extractCacheBustToken(msDetail?.pdf_url)
      const msPagesData = await api(`/papers/${msId}/pages`)
      if (!machine.isCurrentSeq(openSeq)) return false
      msPages.value = msPagesData.pages || []
      const qData = await api(`/papers/${papersStore.currentPaperId}/questions`)
      if (!machine.isCurrentSeq(openSeq)) return false
      const qs = qData.questions || []
      if (!qs.length) {
        dispatch({ type: 'OPEN_FAIL', seq: openSeq })
        appStore.setStatus(t('answer.noQuestions'), 'err')
        return false
      }
      answerQuestions.value = sortQuestionsByNoAsc(qs)
      answerQIndex.value = 0
      if (forcedQuestionId) {
        const idx = answerQuestions.value.findIndex((q) => q.id === forcedQuestionId)
        if (idx >= 0) answerQIndex.value = idx
      } else {
        const savedIdx = getAnswerProgress('q', papersStore.currentPaperId, papersStore.currentPaperCacheToken, msId, papersStore.currentMsCacheToken)
        const restored = clampAnswerProgressIndex(savedIdx, answerQuestions.value.length)
        if (savedIdx != null && Number.isFinite(Number(savedIdx)) && restored >= 0 && restored === Math.floor(Number(savedIdx))) {
          answerQIndex.value = restored
        } else {
          try {
            const status = await questionsApi.getAnswerStatus(papersStore.currentPaperId)
            if (!machine.isCurrentSeq(openSeq)) return false
            const firstUnanswered = findFirstUnansweredIndex(answerQuestions.value, status.answered_ids)
            answerQIndex.value = firstUnanswered >= 0 ? firstUnanswered : 0
          } catch {
            answerQIndex.value = 0
          }
        }
      }
      answerAlignRef.value = loadAnswerAlignRef(papersStore.currentPaperId, msId)
      await ensureAnswerAlignRefFromFirstQuestion()
      if (!machine.isCurrentSeq(openSeq)) return false
      appStore.setView('answer')
      await loadAnswerQuestion(answerQIndex.value, { seq: openSeq })
      if (!machine.isCurrentSeq(openSeq)) return false
      dispatch({ type: 'OPEN_OK', seq: openSeq })
      answerReadyPaperId.value = papersStore.currentPaperId
      appStore.setStatus(t('answer.modeActive', { count: answerQuestions.value.length }), 'ok')
      return true
    } catch (e) {
      if (machine.isCurrentSeq(openSeq)) {
        dispatch({ type: 'OPEN_FAIL', seq: openSeq })
        appStore.setStatus(t('answer.loadFailed', { error: String(e) }), 'err')
      }
      return false
    }
  }

  async function loadAnswerQuestion(index: number, opts: { preserveScroll?: boolean; seq?: number } = {}) {
    if (index < 0 || index >= answerQuestions.value.length) return
    if (!dispatch({ type: 'LOAD_Q', index, seq: opts.seq })) return
    const loadSeq = machine.getState().requestSeq
    if (loadSeq == null) return
    const preserveScroll = !!opts.preserveScroll
    const prev = answerQuestions.value[answerQIndex.value]
    const q = answerQuestions.value[index]
    if (prev && prev.id !== q.id) recordAnswerScrollProgress(prev)
    answerQIndex.value = index
    answerNewBoxes.value = []
    answerExistingBoxes.value = []
    selectedAnswerNew.value = null
    resetAnswerHistory()
    try {
      const d = await api(`/questions/${q.id}/answer`)
      if (!dispatch({ type: 'LOAD_OK', seq: loadSeq })) return
      if (d && d.answer && d.answer.boxes) {
        answerExistingBoxes.value = d.answer.boxes.map((b: ApiAnswerBox) => ({
          id: b.id != null ? String(b.id) : nextBoxId('ex'),
          page: b.page,
          bbox: b.bbox,
        }))
        const settingsStore = useSettingsStore()
        if (settingsStore.answerAlignEnabled && answerAlignRef.value) {
          answerExistingBoxes.value = alignAnswerBoxStatesToBoundsX(answerExistingBoxes.value, answerAlignRef.value)
        }
      }
    } catch {
      // Keep going with empty boxes (matches prior behaviour) but only if
      // this response is still the active request.
      if (!dispatch({ type: 'LOAD_FAIL', seq: loadSeq })) return
    }
    if (answerReplaceMode.value && answerReplaceQuestionId.value === q.id) {
      answerNewBoxes.value = answerExistingBoxes.value.map((b) => ({
        id: b.id ?? nextBoxId('new'),
        page: b.page,
        bbox: [...b.bbox] as BoundingBox,
      }))
      answerExistingBoxes.value = []
      const settingsStore = useSettingsStore()
      if (settingsStore.answerAlignEnabled) {
        const bounds = getAnswerAlignBounds()
        answerNewBoxes.value = alignAnswerBoxStatesToBoundsX(answerNewBoxes.value, bounds)
      }
      selectedAnswerNew.value = answerNewBoxes.value[0] || null
      dispatch({ type: 'EDIT' })
      useAppStore().setStatus(t('answer.editingAnswer', { id: q.id }), 'ok')
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
    const idx = answerQIndex.value
    const q = answerQuestions.value[idx]
    if (!q || msPaperId.value == null) return false
    // Double-click safe: only the first SAVE enters `saving`.
    if (!dispatch({ type: 'SAVE' })) return false
    recordAnswerScrollProgress(q)
    const isReplace = answerReplaceMode.value && answerReplaceQuestionId.value === q.id
    const aligned = buildAnswerSaveBoxes({
      existing: answerExistingBoxes.value,
      newBoxes: answerNewBoxes.value,
      removedExistingIds: answerRemovedExistingIds.value,
      isReplace,
    })
    const settingsStore = useSettingsStore()
    if (settingsStore.answerAlignEnabled && aligned.length) {
      if (!answerAlignRef.value && papersStore.currentPaperId && msPaperId.value) {
        const bb = aligned[0].bbox
        answerAlignRef.value = [bb[0], bb[2]]
        saveAnswerAlignRef(papersStore.currentPaperId, msPaperId.value, answerAlignRef.value)
      }
      const bounds = getAnswerAlignBounds()
      for (const b of aligned) {
        b.bbox = alignAnswerBBoxToBoundsX(b.bbox as BoundingBox, bounds) as number[]
      }
    }
    try {
      appStore.setStatus(t('answer.savingAnswer', { id: q.id }))
      await api(`/questions/${q.id}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ms_paper_id: msPaperId.value, boxes: aligned }),
      })
      // Replace → replaceReturning; normal → ready.clean with dirty=false.
      dispatch({ type: 'SAVE_OK' })
      appStore.setStatus(t('answer.saved'), 'ok')
      answerExistingBoxes.value = aligned.map((b) => ({
        id: nextBoxId('ex'),
        page: b.page,
        bbox: b.bbox as BoundingBox,
      }))
      answerNewBoxes.value = []
      selectedAnswerNew.value = null
      resetAnswerHistory()
      setAnswerProgressIndex()
      if (isReplace) {
        await useFilterStore().returnToFilterFromNavStack()
        dispatch({ type: 'BACK' })
      }
      return true
    } catch (e) {
      dispatch({ type: 'SAVE_FAIL' })
      appStore.setStatus(String(e), 'err')
      return false
    }
  }

  async function navigateAnswer(direction: 'prev' | 'next') {
    const accepted = dispatch(direction === 'prev' ? { type: 'NAV_PREV' } : { type: 'NAV_NEXT' })
    if (!accepted) return
    if (direction === 'prev' && answerQIndex.value > 0) {
      await loadAnswerQuestion(answerQIndex.value - 1)
    } else if (direction === 'next' && answerQIndex.value < answerQuestions.value.length - 1) {
      const needSave = answerNeedsSave()
      if (needSave) await saveAnswer({ preserveScroll: true })
      await loadAnswerQuestion(answerQIndex.value + 1, { preserveScroll: true })
    }
  }

  /** Dispatch a machine event from the view (nav gates, etc.). */
  function sendAnswerEvent(event: AnswerEvent): boolean {
    return dispatch(event)
  }

  async function refreshAnswerPapers() {
    const appStore = useAppStore()
    try {
      appStore.setStatus(t('answer.loadingMs'))
      const data = await api('/answer_papers')
      const aps = data.papers || []
      const sortVal = (p: AnswerPaperListItem) => {
        const v = p.display_no != null ? Number(p.display_no) : Number(p.id)
        return Number.isFinite(v) ? v : 0
      }
      answerPaperList.value = (aps as AnswerPaperListItem[]).slice().sort((a, b) => sortVal(b) - sortVal(a))
      appStore.setStatus(t('answer.msCount', { count: aps.length }), 'ok')
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
      dispatch({ type: 'CLEAR' })
      commitAnswerHistory(snapshot)
      return
    }
    if (!answerNewBoxes.value.length) return
    const dialogStore = useDialogStore()
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
    // Replace stays dirty: clear and save judgments must agree (no silent exit).
    dispatch({ type: 'CLEAR' })
    commitAnswerHistory(snapshot)
  }

  function answerNeedsSave(): boolean {
    const s = machineState.value
    if (s.mode === 'replacing') return true
    return s.dirty
  }

  function deleteExistingAnswerBox(index: number) {
    const safe = Number(index)
    if (!Number.isFinite(safe) || safe < 0 || safe >= answerExistingBoxes.value.length) return
    const box = answerExistingBoxes.value[safe]
    const id = box?.id ?? `idx:${safe}`
    dispatch({ type: 'EDIT', removeBoxId: id })
    selectedAnswerNew.value = null
  }

  function restoreDeletedExistingAnswerBox(index: number) {
    const safe = Number(index)
    if (!Number.isFinite(safe)) return
    const box = answerExistingBoxes.value[safe]
    const id = box?.id ?? `idx:${safe}`
    if (!answerRemovedExistingIds.value.has(id)) return
    dispatch({ type: 'EDIT', restoreBoxId: id })
  }

  function visibleExistingAnswerBoxes() {
    return answerExistingBoxes.value
      .map((b, idx) => ({
        ...b,
        idx,
        removed: answerRemovedExistingIds.value.has(b.id ?? `idx:${idx}`),
      }))
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
    answerRemovedExistingIds,
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
    answerStateName,
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
    sendAnswerEvent,
    refreshAnswerPapers,
    clearAnswerBoxes,
    answerNeedsSave,
    deleteExistingAnswerBox,
    restoreDeletedExistingAnswerBox,
    visibleExistingAnswerBoxes,
  }
})
