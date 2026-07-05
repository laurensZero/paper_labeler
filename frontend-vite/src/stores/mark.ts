import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useAppStore } from './app'
import {
  pendingOcrDraftByPaperId,
  pendingOcrDraftSelectedIdxByPaperId,
  usePapersStore,
} from './papers'
import { useSectionsStore } from './sections'
import { useSettingsStore } from './settings'
import { useFilterStore } from './filter'
import { useDialogStore } from './dialog'
import { i18n } from '@/i18n'
import { api } from '@/api/client'
import type { BoundingBox } from '@/types/common'
import type { Question, QuestionBox, OcrQuestionDraft, OcrBoxDraft } from '@/types'
import { clamp01, clampInt, normalizeBox, pointInBox } from '@/utils/geometry'
import {
  alignBoxesPayloadToBoundsX,
  computeUnionAlignBoundsFromBoxesPayload,
  getActivePaperAlignBounds,
  getPaperAlignBounds,
} from '@/utils/alignment'
import type { AlignBounds } from '@/utils/alignment'

const MARK_HISTORY_LIMIT = 50
const MARK_SAVED_HISTORY_LIMIT = 30

export interface NewBox {
  page: number
  bbox: BoundingBox
  source?: string
  draftIdx?: number
  label?: string | null
}

export interface OcrDraftQuestion {
  label: string
  sections: string[]
  source?: string
}

interface MarkSnapshot {
  boxes: NewBox[]
  selectedIndex: number
  ocrDraftQuestions: OcrDraftQuestion[]
  selectedOcrDraftIdx: number
}

export interface SavedMarkEntry {
  type: 'create' | 'update'
  paperId: number
  questionId: number
  before: { sections: string[]; notes: string | null; boxes: { page: number; bbox: BoundingBox }[] } | null
  after: { sections: string[]; notes: string | null; boxes: { page: number; bbox: BoundingBox }[] }
}

interface DragOp {
  kind: 'move' | 'resize'
  box: NewBox
  corner?: string
  offX?: number
  offY?: number
  w?: number
  h?: number
}

type MarkBoxPayload = { page: number; bbox: BoundingBox }

function cloneMarkBoxes(list: NewBox[]): NewBox[] {
  if (!Array.isArray(list)) return []
  return list.map((b) => ({
    ...b,
    bbox: Array.isArray(b?.bbox) ? ([...b.bbox] as BoundingBox) : [0, 0, 0, 0],
  }))
}

function cloneOcrDrafts(list: OcrDraftQuestion[]): OcrDraftQuestion[] {
  if (!Array.isArray(list)) return []
  try { return JSON.parse(JSON.stringify(list)) } catch {
    return list.map((q) => ({
      ...q,
      sections: Array.isArray(q?.sections) ? [...q.sections] : [],
    }))
  }
}

function markBoxesEqual(a: NewBox[], b: NewBox[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i]
    if (!x || !y) return false
    if (x.page !== y.page || x.source !== y.source || x.draftIdx !== y.draftIdx || x.label !== y.label) return false
    const xb = Array.isArray(x.bbox) ? x.bbox : []
    const yb = Array.isArray(y.bbox) ? y.bbox : []
    if (xb.length !== yb.length) return false
    for (let j = 0; j < xb.length; j++) { if (xb[j] !== yb[j]) return false }
  }
  return true
}

function clonePersistedBoxPayload(boxes: { page: number; bbox: number[] }[]): { page: number; bbox: BoundingBox }[] {
  if (!Array.isArray(boxes)) return []
  return boxes
    .map((b) => ({ page: Number(b?.page), bbox: (Array.isArray(b?.bbox) ? [...b.bbox] : []) as BoundingBox }))
    .filter((b) => Number.isFinite(b.page) && Array.isArray(b.bbox) && b.bbox.length === 4)
}

interface PersistedQuestionPayload {
  sections?: unknown[]
  notes?: string | null
  boxes?: { page: number; bbox: BoundingBox }[]
}

function clonePersistedQuestionPayload(payload: PersistedQuestionPayload | null | undefined): { sections: string[]; notes: string | null; boxes: { page: number; bbox: BoundingBox }[] } {
  if (!payload || typeof payload !== 'object') return { sections: [] as string[], notes: null as string | null, boxes: [] as { page: number; bbox: BoundingBox }[] }
  const sections = Array.isArray(payload.sections)
    ? payload.sections.filter((s) => s != null && String(s).trim()).map((s) => String(s))
    : []
  const notes = payload.notes == null ? null : String(payload.notes)
  const boxes = clonePersistedBoxPayload(payload.boxes || [])
  return { sections, notes, boxes }
}

export const useMarkStore = defineStore('mark', () => {
  // --- state ---
  const newBoxes = ref<NewBox[]>([])
  const selectedNewBox = ref<NewBox | null>(null)
  const drawing = ref(false)
  const startPt = ref<[number, number] | null>(null)
  const markUndoStack = ref<MarkSnapshot[]>([])
  const markRedoStack = ref<MarkSnapshot[]>([])
  const markSavedUndoStack = ref<SavedMarkEntry[]>([])
  const markSavedRedoStack = ref<SavedMarkEntry[]>([])
  const markPersistBusy = ref(false)
  const pageQuestions = ref<any[]>([])
  const suggestedNextNo = ref<number | null>(null)
  const qNotes = ref('')
  const editingQuestionId = ref<number | null>(null)
  const editingQuestionOriginal = ref<any>(null)
  const isLocalEdit = ref(false)
  const answerReplaceMode = ref(false)
  const answerReplaceQuestionId = ref<number | null>(null)
  const selectedSectionsForNewQuestion = ref<string[]>([])
  const qSectionSelectValue = ref('')
  const ocrDraftQuestions = ref<OcrDraftQuestion[]>([])
  const selectedOcrDraftIdx = ref(0)
  const ocrWarning = ref('')
  const dragNewBoxOp = ref<DragOp | null>(null)
  const markPendingSnapshot = ref<MarkSnapshot | null>(null)

  let pageQuestionsRequestSeq = 0
  let pageQuestionsInFlightKey = ''
  let pageQuestionsInFlight: Promise<void> | null = null

  // --- computed ---
  const hasOcrDraftMode = computed(() =>
    Array.isArray(ocrDraftQuestions.value) && ocrDraftQuestions.value.length > 0
  )

  const boxListGroups = computed(() => {
    const boxesAll = newBoxes.value || []
    const grouped = new Map<number, NewBox[]>()
    for (const b of boxesAll) {
      if (!grouped.has(b.page)) grouped.set(b.page, [])
      grouped.get(b.page)!.push(b)
    }
    const pagesSorted = Array.from(grouped.keys()).sort((a, b) => a - b)
    let idx = 0
    const groups: { page: number; items: { index: number; box: NewBox; label?: string | null }[] }[] = []
    for (const pageNum of pagesSorted) {
      const items = grouped.get(pageNum) || []
      const out: { index: number; box: NewBox; label?: string | null }[] = []
      for (const b of items) {
        idx += 1
        out.push({ index: idx, box: b, label: b?.label })
      }
      groups.push({ page: pageNum, items: out })
    }
    return groups
  })

  // --- undo/redo ---
  function resetMarkHistory() {
    markUndoStack.value = []
    markRedoStack.value = []
    markPendingSnapshot.value = null
  }

  function captureMarkSnapshot(): MarkSnapshot {
    const selectedIndex = selectedNewBox.value ? newBoxes.value.indexOf(selectedNewBox.value) : -1
    return {
      boxes: cloneMarkBoxes(newBoxes.value),
      selectedIndex,
      ocrDraftQuestions: cloneOcrDrafts(ocrDraftQuestions.value),
      selectedOcrDraftIdx: selectedOcrDraftIdx.value,
    }
  }

  function restoreMarkSnapshot(snapshot: MarkSnapshot) {
    if (!snapshot) return
    newBoxes.value = cloneMarkBoxes(snapshot.boxes)
    const idx = typeof snapshot.selectedIndex === 'number' ? snapshot.selectedIndex : -1
    selectedNewBox.value = idx >= 0 && newBoxes.value[idx] ? newBoxes.value[idx] : null
    if (Array.isArray(snapshot.ocrDraftQuestions)) {
      ocrDraftQuestions.value = cloneOcrDrafts(snapshot.ocrDraftQuestions)
    }
    if (snapshot.selectedOcrDraftIdx != null) {
      const maxIdx = Math.max(0, (ocrDraftQuestions.value?.length || 1) - 1)
      selectedOcrDraftIdx.value = clampInt(snapshot.selectedOcrDraftIdx, 0, maxIdx)
    }
    drawing.value = false
    startPt.value = null
    dragNewBoxOp.value = null
  }

  function pushMarkUndoSnapshot(snapshot: MarkSnapshot) {
    if (!snapshot) return
    markUndoStack.value.push(snapshot)
    if (markUndoStack.value.length > MARK_HISTORY_LIMIT) markUndoStack.value.shift()
    markRedoStack.value = []
  }

  function commitMarkHistory(snapshot: MarkSnapshot) {
    if (!snapshot) return
    if (markBoxesEqual(snapshot.boxes, newBoxes.value)) return
    pushMarkUndoSnapshot(snapshot)
  }

  function pushSavedMarkUndo(entry: SavedMarkEntry) {
    if (!entry) return
    markSavedUndoStack.value.push(entry)
    if (markSavedUndoStack.value.length > MARK_SAVED_HISTORY_LIMIT) markSavedUndoStack.value.shift()
    markSavedRedoStack.value = []
  }

  async function undoMark() {
    if (markUndoStack.value.length) {
      const current = captureMarkSnapshot()
      const prev = markUndoStack.value.pop()!
      markRedoStack.value.push(current)
      restoreMarkSnapshot(prev)
      return
    }
    await undoSavedMark()
  }

  async function redoMark() {
    if (markRedoStack.value.length) {
      const current = captureMarkSnapshot()
      const next = markRedoStack.value.pop()!
      markUndoStack.value.push(current)
      restoreMarkSnapshot(next)
      return
    }
    await redoSavedMark()
  }

  async function applySavedQuestionPayload(questionId: number, payload: PersistedQuestionPayload | null | undefined) {
    const safeId = Number(questionId)
    if (!Number.isFinite(safeId)) throw new Error('题目 ID 无效')
    const nextPayload = clonePersistedQuestionPayload(payload)
    await api(`/questions/${safeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sections: nextPayload.sections, notes: nextPayload.notes }),
    })
    await api(`/questions/${safeId}/boxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boxes: nextPayload.boxes }),
    })
  }

  async function undoSavedMark() {
    if (markPersistBusy.value) return
    if (!markSavedUndoStack.value.length) return
    const entry = markSavedUndoStack.value[markSavedUndoStack.value.length - 1]
    if (!entry) return
    const papersStore = usePapersStore()
    const appStore = useAppStore()
    if (papersStore.currentPaperId !== entry.paperId) {
      appStore.setStatus('请先打开对应试卷再撤销已保存操作', 'info')
      return
    }
    markPersistBusy.value = true
    try {
      appStore.setStatus('撤销已保存操作中...')
      if (entry.type === 'create') {
        await api(`/questions/${entry.questionId}`, { method: 'DELETE' })
      } else if (entry.type === 'update') {
        await applySavedQuestionPayload(entry.questionId, entry.before)
      } else { return }
      markSavedUndoStack.value.pop()
      markSavedRedoStack.value.push(entry)
      useFilterStore().markQuestionDatasetChanged()
      await loadPageQuestions({ force: true })
      void papersStore.refreshPapers({ silent: true })
      void papersStore.refreshSuggestedNextNo()
      appStore.setStatus('已撤销', 'ok')
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    } finally {
      markPersistBusy.value = false
    }
  }

  async function redoSavedMark() {
    if (markPersistBusy.value) return
    if (!markSavedRedoStack.value.length) return
    const entry = markSavedRedoStack.value[markSavedRedoStack.value.length - 1]
    if (!entry) return
    const papersStore = usePapersStore()
    const appStore = useAppStore()
    if (papersStore.currentPaperId !== entry.paperId) {
      appStore.setStatus('请先打开对应试卷再重做已保存操作', 'info')
      return
    }
    markPersistBusy.value = true
    try {
      appStore.setStatus('重做已保存操作中...')
      if (entry.type === 'create') {
        const payload = clonePersistedQuestionPayload(entry.after)
        const created = await api(`/papers/${entry.paperId}/questions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sections: payload.sections, status: 'confirmed', notes: payload.notes, boxes: payload.boxes }),
        })
        const nextQuestionId = created?.question?.id
        if (nextQuestionId != null) entry.questionId = Number(nextQuestionId)
      } else if (entry.type === 'update') {
        await applySavedQuestionPayload(entry.questionId, entry.after)
      } else { return }
      markSavedRedoStack.value.pop()
      markSavedUndoStack.value.push(entry)
      useFilterStore().markQuestionDatasetChanged()
      await loadPageQuestions({ force: true })
      void papersStore.refreshPapers({ silent: true })
      void papersStore.refreshSuggestedNextNo()
      appStore.setStatus('已重做', 'ok')
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    } finally {
      markPersistBusy.value = false
    }
  }

  // --- alignment / OCR draft helpers ---
  function alignMarkBBoxToBoundsX(
    bbox: BoundingBox | number[] | null | undefined,
    bounds: AlignBounds | null,
  ): BoundingBox | number[] | null | undefined {
    if (!bounds || !Array.isArray(bbox) || bbox.length !== 4) return bbox
    const x0 = clamp01(bounds[0])
    const x1 = clamp01(bounds[1])
    return normalizeBox([x0, bbox[1], Math.max(x1, x0 + 0.01), bbox[3]] as BoundingBox)
  }

  function getMarkAlignBoundsForBox(targetBox: NewBox | null = null, isNew = false): AlignBounds | null {
    const papersStore = usePapersStore()
    const settingsStore = useSettingsStore()
    const allBoxes = (newBoxes.value || []).filter((b) => b && Array.isArray(b.bbox) && b.bbox.length === 4)
    const scopeBoxes = hasOcrDraftMode.value
      ? allBoxes.filter((b) => b.source === 'ocr' && Number(b.draftIdx) === Number(selectedOcrDraftIdx.value))
      : allBoxes

    if (settingsStore.alignPaperFirstEnabled && papersStore.currentPaperId != null) {
      return getActivePaperAlignBounds(settingsStore.paperAlignRef, papersStore.currentPaperId, allBoxes)
    }
    if (settingsStore.alignLeftEnabled) {
      const first = scopeBoxes[0] || null
      if (!first) return null
      if (isNew) {
        if (scopeBoxes.length === 0) return null
      } else if (targetBox && targetBox === first) {
        return null
      }
      return [first.bbox[0], first.bbox[2]]
    }
    return null
  }

  async function ensurePaperAlignRefFromFirstQuestion(paperId: number | null | undefined) {
    const settingsStore = useSettingsStore()
    if (!settingsStore.alignPaperFirstEnabled || paperId == null) return
    if (getPaperAlignBounds(settingsStore.paperAlignRef, paperId)) return
    try {
      const data = await api(`/papers/${paperId}/questions`)
      const list = data?.questions || []
      if (!Array.isArray(list) || !list.length) return
      let first: Question | null = null
      for (const q of list as Question[]) {
        if (!q || q.id == null) continue
        if (!first || Number(q.id) < Number(first.id)) first = q
      }
      const boxes = first?.boxes || []
      const bounds = computeUnionAlignBoundsFromBoxesPayload(boxes as any)
      if (bounds) settingsStore.savePaperAlignRef(paperId, bounds)
    } catch {
      // best effort only
    }
  }

  function alignBoxesForSave(boxesPayload: MarkBoxPayload[]): MarkBoxPayload[] {
    const papersStore = usePapersStore()
    const settingsStore = useSettingsStore()
    let next = boxesPayload
    if (settingsStore.alignLeftEnabled && next.length > 1) {
      const first = next[0]
      if (first && Array.isArray(first.bbox) && first.bbox.length === 4) {
        next = alignBoxesPayloadToBoundsX(next, [first.bbox[0], first.bbox[2]]) as MarkBoxPayload[]
      }
    }
    if (settingsStore.alignPaperFirstEnabled && papersStore.currentPaperId != null && next.length) {
      const ref = getPaperAlignBounds(settingsStore.paperAlignRef, papersStore.currentPaperId)
      const bounds = ref || computeUnionAlignBoundsFromBoxesPayload(next)
      if (bounds) next = alignBoxesPayloadToBoundsX(next, bounds) as MarkBoxPayload[]
    }
    return next
  }

  function savePaperAlignRefFromBoxes(boxesPayload: MarkBoxPayload[]) {
    const papersStore = usePapersStore()
    const settingsStore = useSettingsStore()
    if (!settingsStore.alignPaperFirstEnabled || papersStore.currentPaperId == null || !boxesPayload.length) return
    if (getPaperAlignBounds(settingsStore.paperAlignRef, papersStore.currentPaperId)) return
    const bounds = computeUnionAlignBoundsFromBoxesPayload(boxesPayload)
    if (bounds) settingsStore.savePaperAlignRef(papersStore.currentPaperId, bounds)
  }

  function stashCurrentOcrDraftStateForPaper(paperId: number | null | undefined) {
    if (paperId == null) return
    if (!hasOcrDraftMode.value) {
      pendingOcrDraftByPaperId.delete(paperId)
      pendingOcrDraftSelectedIdxByPaperId.delete(paperId)
      return
    }
    const drafts: { label: string; sections: string[]; boxes: MarkBoxPayload[] }[] = []
    for (let i = 0; i < ocrDraftQuestions.value.length; i++) {
      const q = ocrDraftQuestions.value[i]
      if (!q) continue
      const label = String(q.label ?? '?').trim() || '?'
      const sections = Array.isArray(q.sections) ? q.sections : []
      const boxes = (newBoxes.value || [])
        .filter((b) => b && b.source === 'ocr' && Number(b.draftIdx) === i)
        .filter((b) => Number.isFinite(b.page) && Array.isArray(b.bbox) && b.bbox.length === 4)
        .map((b) => ({ page: b.page, bbox: b.bbox }))
      drafts.push({ label, sections, boxes })
    }
    pendingOcrDraftByPaperId.set(paperId, drafts)
    pendingOcrDraftSelectedIdxByPaperId.set(
      paperId,
      clampInt(selectedOcrDraftIdx.value, 0, Math.max(0, ocrDraftQuestions.value.length - 1)),
    )
  }

  function addOcrDraftQuestion() {
    const papersStore = usePapersStore()
    const newIdx = ocrDraftQuestions.value.length
    ocrDraftQuestions.value.push({ label: String(newIdx + 1), sections: [], source: 'manual' })
    selectedOcrDraftIdx.value = newIdx
    if (papersStore.currentPaperId != null) {
      pendingOcrDraftSelectedIdxByPaperId.set(papersStore.currentPaperId, newIdx)
    }
  }

  async function selectOcrDraft(idx: number) {
    const papersStore = usePapersStore()
    const nextIdx = clampInt(idx, 0, Math.max(0, ocrDraftQuestions.value.length - 1))
    selectedOcrDraftIdx.value = nextIdx
    if (papersStore.currentPaperId != null) {
      pendingOcrDraftSelectedIdxByPaperId.set(papersStore.currentPaperId, nextIdx)
    }
    const first = (newBoxes.value || []).find(
      (b) => b && b.source === 'ocr' && Number(b.draftIdx) === nextIdx,
    )
    if (first && papersStore.pages.length) {
      selectedNewBox.value = first
      const targetIdx = papersStore.pages.findIndex((p) => p.page === first.page)
      if (targetIdx >= 0) await papersStore.goToPage(targetIdx)
    }
  }

  // --- page questions ---
  async function loadPageQuestions(options: { force?: boolean } = {}) {
    const papersStore = usePapersStore()
    if (!papersStore.currentPaperId || papersStore.currentPageIndex < 0) return
    const pageNum = papersStore.pages[papersStore.currentPageIndex].page
    const paperId = Number(papersStore.currentPaperId)
    const key = `${paperId}:${pageNum}`
    const force = !!options.force
    if (!force && pageQuestionsInFlight && pageQuestionsInFlightKey === key) {
      return pageQuestionsInFlight
    }
    const seq = ++pageQuestionsRequestSeq
    pageQuestionsInFlightKey = key
    const requestPromise = (async () => {
      const data = await api(`/papers/${paperId}/questions?page=${pageNum}`)
      const latestPaperId = Number(papersStore.currentPaperId)
      const latestPage = papersStore.pages[papersStore.currentPageIndex]?.page
      if (seq === pageQuestionsRequestSeq && latestPaperId === paperId && latestPage === pageNum) {
        pageQuestions.value = data.questions || []
      }
    })().finally(() => {
      if (pageQuestionsInFlight === requestPromise) {
        pageQuestionsInFlight = null
        pageQuestionsInFlightKey = ''
      }
    })
    pageQuestionsInFlight = requestPromise
    return pageQuestionsInFlight
  }

  // --- edit question ---
  function enterEditQuestionMode(questionId: number, original: PersistedQuestionPayload | null = null, isLocal = false) {
    editingQuestionId.value = questionId
    editingQuestionOriginal.value = original || null
    isLocalEdit.value = !!isLocal
  }

  function exitEditQuestionMode() {
    editingQuestionId.value = null
    editingQuestionOriginal.value = null
    isLocalEdit.value = false
    answerReplaceMode.value = false
    answerReplaceQuestionId.value = null
  }

  async function editQuestion(q: Question) {
    const appStore = useAppStore()
    if (hasOcrDraftMode.value) {
      appStore.setStatus('OCR 草稿模式下无法修改', 'err')
      return
    }
    try {
      appStore.setStatus(`加载题目 #${q.id} 中...`)
      const resp = await api(`/questions/${q.id}`)
      const full = resp?.question || q
      const boxes = Array.isArray(full?.boxes) ? full.boxes : (Array.isArray(q?.boxes) ? q.boxes : [])
      if (!boxes.length) {
        appStore.setStatus('题目没有框', 'err')
        return
      }
      newBoxes.value = boxes.map((b: QuestionBox) => ({ page: b.page, bbox: b.bbox }))
      selectedNewBox.value = newBoxes.value[0] || null
      qSectionSelectValue.value = (full?.section ?? null) || ''
      qNotes.value = (full?.notes ?? null) || ''
      selectedSectionsForNewQuestion.value = full?.sections && Array.isArray(full.sections) ? [...full.sections] : []
      resetMarkHistory()
      enterEditQuestionMode(q.id, {
        sections: full?.sections ?? [],
        notes: full?.notes ?? null,
        boxes: clonePersistedBoxPayload(boxes),
      }, true)
      appStore.setStatus('已进入修改模式：调整框后保存', 'ok')
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  async function deleteQuestion(q: Question) {
    const appStore = useAppStore()
    const papersStore = usePapersStore()
    const t = i18n.global.t
    if (!await useDialogStore().confirm(t('mark.deleteQuestionConfirm', { id: q.id }), {
      title: t('mark.deleteQuestionTitle'),
      confirmText: t('dialog.delete'),
      danger: true,
    })) return
    try {
      appStore.setStatus(`删除题目 #${q.id} 中...`)
      await api(`/questions/${q.id}`, { method: 'DELETE' })
      useFilterStore().markQuestionDatasetChanged()
      appStore.setStatus('已删除', 'ok')
      await papersStore.refreshPapers()
      await loadPageQuestions({ force: true })
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  // --- shared post-save refresh ---
  async function postSaveRefresh() {
    const papersStore = usePapersStore()
    const sectionsStore = useSectionsStore()
    useFilterStore().markQuestionDatasetChanged()
    await loadPageQuestions({ force: true })
    void sectionsStore.refreshSectionDefs()
    void papersStore.refreshPapers({ silent: true })
  }

  /** Update an existing question (PATCH metadata + POST boxes). */
  async function updateExistingQuestion(
    qid: number,
    sectionsToSave: string[],
    notes: string | null,
    boxesPayload: { page: number; bbox: BoundingBox }[],
    beforePayload: { sections: string[]; notes: string | null; boxes: { page: number; bbox: BoundingBox }[] },
  ) {
    const appStore = useAppStore()
    const papersStore = usePapersStore()
    appStore.setStatus(`保存题目 #${qid} 中...`)
    await api(`/questions/${qid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sections: sectionsToSave, notes }),
    })
    await api(`/questions/${qid}/boxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boxes: boxesPayload }),
    })
    pushSavedMarkUndo({
      type: 'update',
      paperId: papersStore.currentPaperId!,
      questionId: Number(qid),
      before: beforePayload,
      after: clonePersistedQuestionPayload({ sections: sectionsToSave, notes, boxes: boxesPayload }),
    })
    newBoxes.value = []
    resetMarkHistory()
    await postSaveRefresh()
    exitEditQuestionMode()
    appStore.setStatus('已保存', 'ok')
    const filterStore = useFilterStore()
    if (filterStore.filterReturnQid != null) {
      await filterStore.returnToFilterFromNavStack()
    }
  }

  /** Create a new question (POST to /papers/:id/questions). */
  async function createNewQuestion(
    sectionsToSave: string[],
    notes: string | null,
    boxesPayload: { page: number; bbox: BoundingBox }[],
  ) {
    const appStore = useAppStore()
    const papersStore = usePapersStore()
    const payload = {
      sections: sectionsToSave,
      status: 'confirmed' as const,
      notes,
      boxes: boxesPayload,
    }
    appStore.setStatus('保存题目中...')
    const created = await api(`/papers/${papersStore.currentPaperId}/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const createdId = Number(created?.question?.id)
    if (Number.isFinite(createdId)) {
      pushSavedMarkUndo({
        type: 'create',
        paperId: papersStore.currentPaperId!,
        questionId: createdId,
        before: null,
        after: clonePersistedQuestionPayload(payload),
      })
    }
    savePaperAlignRefFromBoxes(boxesPayload)
    newBoxes.value = []
    qNotes.value = ''
    qSectionSelectValue.value = ''
    selectedSectionsForNewQuestion.value = []
    resetMarkHistory()
    await postSaveRefresh()
    void papersStore.refreshSuggestedNextNo()
    appStore.setStatus('已保存', 'ok')
  }

  // --- save question ---
  async function saveQuestion() {
    if (editingQuestionId.value == null && hasOcrDraftMode.value) {
      await saveOcrDraftQuestionsBatch()
      return
    }
    if (!newBoxes.value.length) return
    let section = qSectionSelectValue.value || null
    let notes = qNotes.value || null
    const boxesPayload = alignBoxesForSave(newBoxes.value.map((b) => ({ page: b.page, bbox: b.bbox })))

    if (editingQuestionId.value != null) {
      const qid = editingQuestionId.value
      const original = editingQuestionOriginal.value || {}
      const beforePayload = clonePersistedQuestionPayload({
        sections: Array.isArray(original.sections) ? original.sections : (original.section ? [original.section] : []),
        notes: original.notes ?? null,
        boxes: Array.isArray(original.boxes) ? original.boxes : [],
      })
      let sectionsToSave = selectedSectionsForNewQuestion.value.length > 0
        ? selectedSectionsForNewQuestion.value
        : (section ? [section] : [])
      if (sectionsToSave.length === 0 && editingQuestionOriginal.value) {
        const origSections = editingQuestionOriginal.value.sections || (editingQuestionOriginal.value.section ? [editingQuestionOriginal.value.section] : [])
        sectionsToSave = origSections
      }
      if (editingQuestionOriginal.value && notes == null) {
        notes = editingQuestionOriginal.value.notes ?? null
      }
      await updateExistingQuestion(qid, sectionsToSave, notes, boxesPayload, beforePayload)
      return
    }

    const sectionsToSave = selectedSectionsForNewQuestion.value.length > 0
      ? selectedSectionsForNewQuestion.value
      : (section ? [section] : [])
    await createNewQuestion(sectionsToSave, notes, boxesPayload)
  }

  async function saveOcrDraftQuestionsBatch() {
    const appStore = useAppStore()
    const papersStore = usePapersStore()
    const sectionsStore = useSectionsStore()
    const settingsStore = useSettingsStore()
    if (!papersStore.currentPaperId || !hasOcrDraftMode.value) return

    const byIdx = new Map<number, NewBox[]>()
    for (const b of newBoxes.value) {
      if (!b || b.source !== 'ocr') continue
      const di = Number(b.draftIdx)
      if (!Number.isFinite(di)) continue
      if (!byIdx.has(di)) byIdx.set(di, [])
      byIdx.get(di)!.push(b)
    }

    const total = ocrDraftQuestions.value.length
    const t = i18n.global.t
    if (!await useDialogStore().confirm(t('mark.saveOcrDraftConfirm', { total }), {
      title: t('mark.saveOcrDraftTitle'),
      confirmText: t('dialog.save'),
    })) return

    let paperBounds = settingsStore.alignPaperFirstEnabled
      ? getPaperAlignBounds(settingsStore.paperAlignRef, papersStore.currentPaperId)
      : null
    if (settingsStore.alignPaperFirstEnabled && !paperBounds) {
      const firstBoxes = (byIdx.get(0) || []).map((b) => ({ bbox: b?.bbox }))
      const union = computeUnionAlignBoundsFromBoxesPayload(firstBoxes)
      if (union) {
        settingsStore.savePaperAlignRef(papersStore.currentPaperId, union)
        paperBounds = union
      }
    }

    try {
      appStore.setStatus(`保存中...（${total} 题）`)
      for (let i = 0; i < ocrDraftQuestions.value.length; i++) {
        const q = ocrDraftQuestions.value[i]
        if (!q) continue
        const boxes = (byIdx.get(i) || [])
          .filter((b) => b && Number.isFinite(b.page) && Array.isArray(b.bbox) && b.bbox.length === 4)
          .sort((a, b) => (a.page - b.page) || (a.bbox[1] - b.bbox[1]))
        if (!boxes.length) continue

        let boxesPayload: MarkBoxPayload[] = boxes.map((b) => ({ page: b.page, bbox: b.bbox }))
        if (settingsStore.alignPaperFirstEnabled && paperBounds) {
          boxesPayload = alignBoxesPayloadToBoundsX(boxesPayload, paperBounds) as MarkBoxPayload[]
        } else if (settingsStore.alignLeftEnabled && boxesPayload.length > 1) {
          const first = boxesPayload[0]
          boxesPayload = alignBoxesPayloadToBoundsX(boxesPayload, [first.bbox[0], first.bbox[2]]) as MarkBoxPayload[]
        }

        const sectionsToSave = Array.isArray(q.sections) && q.sections.length > 0
          ? q.sections
          : selectedSectionsForNewQuestion.value

        appStore.setStatus(`保存第 ${i + 1}/${total} 题（题号 ${q.label || '?'}）...`)
        await api(`/papers/${papersStore.currentPaperId}/questions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sections: sectionsToSave,
            status: 'confirmed',
            notes: null,
            boxes: boxesPayload,
          }),
        })
      }

      ocrDraftQuestions.value = []
      selectedOcrDraftIdx.value = 0
      newBoxes.value = []
      selectedNewBox.value = null
      selectedSectionsForNewQuestion.value = []
      resetMarkHistory()
      pendingOcrDraftByPaperId.delete(papersStore.currentPaperId)
      pendingOcrDraftSelectedIdxByPaperId.delete(papersStore.currentPaperId)
      useFilterStore().markQuestionDatasetChanged()
      await loadPageQuestions({ force: true })
      void sectionsStore.refreshSectionDefs()
      void papersStore.refreshPapers({ silent: true })
      void papersStore.refreshSuggestedNextNo()
      appStore.setStatus('已保存', 'ok')
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  // --- OCR auto-recognize ---
  async function autoRecognize() {
    const papersStore = usePapersStore()
    const appStore = useAppStore()
    if (!papersStore.currentPaperId) return
    if (hasOcrDraftMode.value || (newBoxes.value && newBoxes.value.length)) {
      const t = i18n.global.t
      if (!await useDialogStore().confirm(t('mark.regenerateOcrConfirm'), {
        title: t('mark.regenerateOcrTitle'),
        confirmText: t('dialog.confirm'),
        danger: true,
      })) return
    }
    try {
      appStore.setStatus('自动识别中...')
      const settingsStore = (await import('./settings')).useSettingsStore()
      const data = await api(`/papers/${papersStore.currentPaperId}/auto_suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          min_height_px: clampInt(settingsStore.ocrMinHeightPx, 0, 2000),
          y_padding_px: clampInt(settingsStore.ocrYPaddingPx, 0, 500),
        }),
      })

      ocrDraftQuestions.value = []
      selectedOcrDraftIdx.value = 0
      newBoxes.value = []
      selectedNewBox.value = null
      resetMarkHistory()

      const drafts = data?.ocr_questions || []
      Array.isArray(data?.skipped_pages) ? data.skipped_pages : []
      const warn = data?.ocr_warning

      if (Array.isArray(drafts) && drafts.length) {
        ocrDraftQuestions.value = (drafts as OcrQuestionDraft[])
          .map((q) => ({ label: String(q?.label ?? '?').trim() || '?', sections: [] }))
          .filter((q) => q && q.label)

        const flat: NewBox[] = []
        ocrDraftQuestions.value.forEach((q, draftIdx) => {
          if (!q || !drafts[draftIdx]) return
          const boxes = ((drafts[draftIdx]?.boxes || []) as OcrBoxDraft[]).map((b) => ({
            page: Number(b?.page),
            bbox: Array.from(b?.bbox || []) as BoundingBox,
            source: 'ocr',
            label: q.label,
            draftIdx,
          }))
          for (const b of boxes) {
            if (Number.isFinite(b.page) && Array.isArray(b.bbox) && b.bbox.length === 4) flat.push(b)
          }
        })
        newBoxes.value = flat
      } else {
        const flatBoxes = data?.ocr_boxes || []
        if (Array.isArray(flatBoxes) && flatBoxes.length) {
          newBoxes.value = (flatBoxes as OcrBoxDraft[])
            .map((b) => ({ page: Number(b.page), bbox: Array.from(b.bbox || []) as BoundingBox, source: 'ocr', label: b?.label ?? null }))
            .filter((b) => Number.isFinite(b.page) && Array.isArray(b.bbox) && b.bbox.length === 4)
        }
      }

      selectedNewBox.value = newBoxes.value.length ? newBoxes.value[0] : null
      if (warn) {
        appStore.setStatus(String(warn), 'err')
      } else {
        appStore.setStatus(
          `自动识别完成：${ocrDraftQuestions.value.length || '?'} 题 / ${newBoxes.value.length} 框（未保存）`,
          'ok',
        )
      }
      await papersStore.refreshSuggestedNextNo()
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  // --- drawing setup (pointer events) ---
  function canvasPointToNorm(evt: PointerEvent | MouseEvent, canvas: HTMLCanvasElement): [number, number] {
    const rect = canvas.getBoundingClientRect()
    const x = (evt.clientX - rect.left) / rect.width
    const y = (evt.clientY - rect.top) / rect.height
    return [clamp01(x), clamp01(y)]
  }

  function hitTestNewBoxes(normX: number, normY: number): DragOp | null {
    const papersStore = usePapersStore()
    const bxs = newBoxes.value || []
    const pageNum = papersStore.pages[papersStore.currentPageIndex]?.page
    for (let i = bxs.length - 1; i >= 0; i--) {
      const b = bxs[i]
      if (!b || b.page !== pageNum) continue
      if (!Array.isArray(b.bbox) || b.bbox.length !== 4) continue
      const [x0, y0, x1, y1] = b.bbox
      const pad = 0.01
      const corners = [
        { kind: 'resize' as const, corner: 'tl', x: x0, y: y0 },
        { kind: 'resize' as const, corner: 'tr', x: x1, y: y0 },
        { kind: 'resize' as const, corner: 'bl', x: x0, y: y1 },
        { kind: 'resize' as const, corner: 'br', x: x1, y: y1 },
      ]
      const mids = [
        { kind: 'resize' as const, corner: 'tm', x: (x0 + x1) / 2, y: y0 },
        { kind: 'resize' as const, corner: 'bm', x: (x0 + x1) / 2, y: y1 },
        { kind: 'resize' as const, corner: 'ml', x: x0, y: (y0 + y1) / 2 },
        { kind: 'resize' as const, corner: 'mr', x: x1, y: (y0 + y1) / 2 },
      ]
      for (const c of corners) {
        if (Math.abs(normX - c.x) <= pad && Math.abs(normY - c.y) <= pad) {
          return { kind: 'resize', box: b, corner: c.corner }
        }
      }
      for (const c of mids) {
        if (Math.abs(normX - c.x) <= pad && Math.abs(normY - c.y) <= pad) {
          return { kind: 'resize', box: b, corner: c.corner }
        }
      }
      if (pointInBox(normX, normY, b.bbox)) {
        return { kind: 'move', box: b, offX: normX - x0, offY: normY - y0, w: x1 - x0, h: y1 - y0 }
      }
    }
    return null
  }

  function deleteSelectedUnsavedBox() {
    if (!selectedNewBox.value) return
    const snapshot = captureMarkSnapshot()
    const deletedBoxDraftIdx =
      hasOcrDraftMode.value && selectedNewBox.value.source === 'ocr'
        ? Number(selectedNewBox.value.draftIdx)
        : null
    newBoxes.value = newBoxes.value.filter((x) => x !== selectedNewBox.value)
    selectedNewBox.value = null
    dragNewBoxOp.value = null
    drawing.value = false
    startPt.value = null
    if (editingQuestionId.value != null && newBoxes.value.length === 0) {
      exitEditQuestionMode()
    }
    if (hasOcrDraftMode.value && deletedBoxDraftIdx != null && Number.isFinite(deletedBoxDraftIdx)) {
      const remainingBoxCount = newBoxes.value.filter(
        (b) => b && b.source === 'ocr' && Number(b.draftIdx) === deletedBoxDraftIdx,
      ).length
      if (remainingBoxCount === 0 && ocrDraftQuestions.value[deletedBoxDraftIdx]) {
        ocrDraftQuestions.value.splice(deletedBoxDraftIdx, 1)
        newBoxes.value = newBoxes.value.filter((b) => b && Number(b.draftIdx) !== deletedBoxDraftIdx)
        newBoxes.value.forEach((b) => {
          if (b && b.source === 'ocr' && Number.isFinite(b.draftIdx) && Number(b.draftIdx) > deletedBoxDraftIdx) {
            b.draftIdx = Number(b.draftIdx) - 1
          }
        })
        if (selectedOcrDraftIdx.value >= deletedBoxDraftIdx) {
          selectedOcrDraftIdx.value = Math.max(0, selectedOcrDraftIdx.value - 1)
        }
      }
    }
    commitMarkHistory(snapshot)
  }

  async function clearBoxes() {
    if (selectedNewBox.value) {
      deleteSelectedUnsavedBox()
      return
    }
    if (newBoxes.value.length === 0) return
    const t = i18n.global.t
    const confirmMsg = hasOcrDraftMode.value
      ? t('mark.clearOcrBoxesConfirm', { questions: ocrDraftQuestions.value.length, boxes: newBoxes.value.length })
      : t('mark.clearBoxesConfirm', { count: newBoxes.value.length })
    if (!await useDialogStore().confirm(confirmMsg, {
      title: t('mark.clearBoxesTitle'),
      confirmText: t('dialog.clear'),
      danger: true,
    })) return
    const snapshot = captureMarkSnapshot()
    newBoxes.value = []
    if (hasOcrDraftMode.value) {
      ocrDraftQuestions.value = []
      selectedOcrDraftIdx.value = 0
      const papersStore = usePapersStore()
      if (papersStore.currentPaperId != null) {
        pendingOcrDraftByPaperId.delete(papersStore.currentPaperId)
        pendingOcrDraftSelectedIdxByPaperId.delete(papersStore.currentPaperId)
      }
    }
    commitMarkHistory(snapshot)
  }

  // --- section helpers ---
  function addSectionFromSelect() {
    const value = qSectionSelectValue.value
    if (value && !selectedSectionsForNewQuestion.value.includes(value)) {
      selectedSectionsForNewQuestion.value.push(value)
    }
    qSectionSelectValue.value = ''
  }

  function removeSelectedSection(section: string) {
    selectedSectionsForNewQuestion.value = selectedSectionsForNewQuestion.value.filter((s) => s !== section)
  }

  return {
    // state
    newBoxes,
    selectedNewBox,
    drawing,
    startPt,
    markUndoStack,
    markRedoStack,
    markSavedUndoStack,
    markSavedRedoStack,
    markPersistBusy,
    pageQuestions,
    suggestedNextNo,
    qNotes,
    editingQuestionId,
    editingQuestionOriginal,
    isLocalEdit,
    answerReplaceMode,
    answerReplaceQuestionId,
    selectedSectionsForNewQuestion,
    qSectionSelectValue,
    ocrDraftQuestions,
    selectedOcrDraftIdx,
    ocrWarning,
    dragNewBoxOp,
    markPendingSnapshot,
    // computed
    hasOcrDraftMode,
    boxListGroups,
    // undo/redo actions
    resetMarkHistory,
    captureMarkSnapshot,
    restoreMarkSnapshot,
    commitMarkHistory,
    pushSavedMarkUndo,
    undoMark,
    redoMark,
    undoSavedMark,
    redoSavedMark,
    // question actions
    loadPageQuestions,
    enterEditQuestionMode,
    exitEditQuestionMode,
    editQuestion,
    deleteQuestion,
    saveQuestion,
    saveOcrDraftQuestionsBatch,
    autoRecognize,
    stashCurrentOcrDraftStateForPaper,
    addOcrDraftQuestion,
    selectOcrDraft,
    deleteSelectedUnsavedBox,
    clearBoxes,
    // drawing helpers
    canvasPointToNorm,
    hitTestNewBoxes,
    getMarkAlignBoundsForBox,
    alignMarkBBoxToBoundsX,
    ensurePaperAlignRefFromFirstQuestion,
    // section helpers
    addSectionFromSelect,
    removeSelectedSection,
  }
})
