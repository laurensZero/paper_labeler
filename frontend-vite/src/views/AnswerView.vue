<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, onActivated, onDeactivated } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useAnswerStore, type AnswerDragOp } from '@/stores/answer'
import { usePapersStore } from '@/stores/papers'
import { api } from '@/api/client'
import CropPreview from '@/components/ui/CropPreview.vue'
import { useAnswerMsPageWindow } from '@/composables/useAnswerMsPageWindow'
import { clamp01, normalizeBox, pointInBox, clampInt } from '@/utils/geometry'
import { alignAnswerBBoxToBoundsX } from '@/utils/alignment'
import type { BoundingBox } from '@/types/common'
import type { Question, QuestionBox, PaperDetail } from '@/types'

defineOptions({ name: 'AnswerView' })

const { t } = useI18n()
const route = useRoute()
const answerStore = useAnswerStore()
const papersStore = usePapersStore()

const {
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
  answerPendingSnapshot,
  answerReplaceMode,
  answerReadyPaperId,
  answerOpening,
  currentAnswerQuestion,
  answerQInfoText,
  answerQuestionMetaText,
  answerBoxesHintText,
  canPrevAnswer,
  canNextAnswer,
} = storeToRefs(answerStore)

const { currentPaperId, currentQpPaperName } = storeToRefs(papersStore)

// --- local refs ---
const jumpMsPageInput = ref('')
const msPaperName = ref('')
const msPageCount = ref(0)
const msPageAspectRatio = ref('1.294 / 1')
let answerEnsuring = false

interface MsScrollTarget {
  page: number
  bbox?: BoundingBox | null
}

// --- computed ---
const canUndo = computed(() => answerUndoStack.value.length > 0)
const canRedo = computed(() => answerRedoStack.value.length > 0)
const hasNewBoxes = computed(() => answerNewBoxes.value.length > 0)
const answerNeedsSave = computed(() => answerStore.answerNeedsSave())
const answerEmptyText = computed(() => answerOpening.value ? '正在加载答案卷...' : (t('answer.empty') || '请先打开试卷'))
const noMsPagesText = computed(() => answerOpening.value ? '正在加载答案卷页面...' : (t('answer.noMsPages') || '暂无答案卷页面'))
const answerBackText = computed(() => answerReplaceMode.value ? '返回题库' : '返回标注')

const answerPaperTitleText = computed(() => {
  if (!currentPaperId.value) return t('answer.noPaper')
  const qpName = currentQpPaperName.value || `#${currentPaperId.value}`
  const msName = msPaperName.value || (msPaperId.value ? `MS #${msPaperId.value}` : '')
  return msName ? `${qpName} -> ${msName}` : qpName
})

const msPageInfoText = computed(() => {
  if (!msPages.value.length) return ''
  return `${msPageCount.value} ${t('answer.msPages') || '页'}`
})

// Question list with active state
const questionList = computed(() => {
  return answerQuestions.value.map((q, idx: number) => ({
    q,
    idx,
    active: idx === answerQIndex.value,
    hasExisting: answerExistingBoxes.value.length > 0 && idx === answerQIndex.value,
  }))
})

const currentAnswerQuestionBoxes = computed(() => {
  const q = currentAnswerQuestion.value
  const boxes: QuestionBox[] = Array.isArray(q?.boxes) ? q.boxes : []
  return boxes
    .filter((b) => b && Array.isArray(b.bbox) && b.bbox.length === 4)
    .map((b, idx: number) => ({
      key: b.id ?? `${b.page ?? 'p'}-${idx}`,
      imageUrl: b.image_url || (q?.paper_id && b.page ? `/data/pages/paper_${q.paper_id}/page_${b.page}.png` : ''),
      bbox: b.bbox as number[],
      page: b.page,
    }))
})

const answerPreviewBoxes = computed(() => [
  ...answerExistingBoxes.value.map((b, idx) => ({ key: `ex-${idx}`, kind: 'existing' as const, page: b.page, bbox: b.bbox })),
  ...answerNewBoxes.value.map((b, idx) => ({ key: `new-${idx}`, kind: 'new' as const, page: b.page, bbox: b.bbox })),
])

const answerPreviewMetaText = computed(() => `框数：${answerPreviewBoxes.value.length}`)

function msImageUrlForPage(page: number | string | null | undefined) {
  const pageNum = Number(page)
  if (!Number.isFinite(pageNum)) return ''
  const found = msPages.value.find((p) => Number(p.page) === pageNum)
  if (found?.image_url) return found.image_url
  return msPaperId.value ? `/data/pages/paper_${msPaperId.value}/page_${pageNum}.png` : ''
}

const answerWorkPageSet = computed(() => {
  const pages = new Set<number>()
  for (const b of answerExistingBoxes.value) {
    if (Number.isFinite(Number(b?.page))) pages.add(Number(b.page))
  }
  for (const b of answerNewBoxes.value) {
    if (Number.isFinite(Number(b?.page))) pages.add(Number(b.page))
  }
  if (answerDrawing.value && Number.isFinite(Number(answerDrawing.value.page))) {
    pages.add(Number(answerDrawing.value.page))
  }
  if (selectedAnswerNew.value && Number.isFinite(Number(selectedAnswerNew.value.page))) {
    pages.add(Number(selectedAnswerNew.value.page))
  }
  return pages
})

const {
  msScrollRef,
  markMsPageRendered,
  ensureAnswerWorkPagesRendered,
  isMsPageRendered,
  rebuildMsPageObserver,
  attachMsScrollRenderListener,
  detachMsScrollRenderListener,
  setMsPageItemRef,
  resetMsPageWindow,
  disposeMsPageWindow,
} = useAnswerMsPageWindow({
  msPages,
  answerWorkPageSet,
})

// --- canvas helpers ---
function setCanvasSizeFor(img: HTMLImageElement, canvas: HTMLCanvasElement) {
  const w = img.clientWidth
  const h = img.clientHeight
  if (w === 0 || h === 0) return
  canvas.width = w
  canvas.height = h
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  canvas.style.pointerEvents = 'auto'
  canvas.style.zIndex = '2'
}

function onMsImageLoad(pageNum: number, evt: Event) {
  const img = evt.target as HTMLImageElement
  const canvas = msCanvasByPage.value.get(pageNum)
  if (img?.naturalWidth && img?.naturalHeight) {
    msPageAspectRatio.value = `${img.naturalWidth} / ${img.naturalHeight}`
  }
  if (img && canvas) {
    setCanvasSizeFor(img, canvas)
    drawAnswerOverlayForPage(pageNum)
  }
}

function setMsCanvasRef(pageNum: number, el: unknown) {
  if (!el) {
    msCanvasByPage.value.delete(pageNum)
    return
  }
  const canvas = el as HTMLCanvasElement
  msCanvasByPage.value.set(pageNum, canvas)
  canvas.style.pointerEvents = 'auto'
  canvas.style.zIndex = '2'
  const parent = canvas.parentElement
  const img = parent?.querySelector('img') as HTMLImageElement | null
  if (img && img.complete && img.naturalWidth) {
    setCanvasSizeFor(img, canvas)
    drawAnswerOverlayForPage(pageNum)
  }
}

// --- drawing ---
function drawAnswerOverlayForPage(pageNum: number, tempBox: BoundingBox | null = null) {
  const canvas = msCanvasByPage.value.get(pageNum)
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  // resize if needed
  const parent = canvas.parentElement
  const img = parent?.querySelector('img') as HTMLImageElement | null
  if (img && (canvas.width !== img.clientWidth || canvas.height !== img.clientHeight)) {
    setCanvasSizeFor(img, canvas)
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.lineWidth = 2

  // existing boxes (green)
  for (const b of answerExistingBoxes.value) {
    if (b.page !== pageNum) continue
    const [x0, y0, x1, y1] = b.bbox
    ctx.strokeStyle = '#34c759'
    ctx.strokeRect(
      x0 * canvas.width,
      y0 * canvas.height,
      (x1 - x0) * canvas.width,
      (y1 - y0) * canvas.height,
    )
  }

  // new boxes (red) with selection handles
  for (const nb of answerNewBoxes.value) {
    if (nb.page !== pageNum) continue
    const [x0, y0, x1, y1] = nb.bbox
    ctx.strokeStyle = '#ef4444'
    ctx.lineWidth = 2
    ctx.strokeRect(
      x0 * canvas.width,
      y0 * canvas.height,
      (x1 - x0) * canvas.width,
      (y1 - y0) * canvas.height,
    )

    // draw selection handles
    if (selectedAnswerNew.value === nb) {
      ctx.fillStyle = '#0071e3'
      const hs = 5
      const pts: [number, number][] = [
        [x0, y0], [x1, y0], [x0, y1], [x1, y1],
        [(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1],
        [x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2],
      ]
      for (const [px, py] of pts) {
        ctx.fillRect(px * canvas.width - hs, py * canvas.height - hs, hs * 2, hs * 2)
      }
    }
  }

  // temp drawing box (dashed red)
  if (tempBox) {
    ctx.setLineDash([6, 4])
    ctx.strokeStyle = '#ef4444'
    ctx.lineWidth = 2
    const [x0, y0, x1, y1] = tempBox
    ctx.strokeRect(
      x0 * canvas.width,
      y0 * canvas.height,
      (x1 - x0) * canvas.width,
      (y1 - y0) * canvas.height,
    )
    ctx.setLineDash([])
  }
}

function redrawAllOverlays() {
  for (const pageNum of msCanvasByPage.value.keys()) {
    drawAnswerOverlayForPage(pageNum)
  }
}

// --- pointer event helpers ---
function canvasPointToNorm(evt: PointerEvent, canvas: HTMLCanvasElement): [number, number] {
  const rect = canvas.getBoundingClientRect()
  const x = (evt.clientX - rect.left) / rect.width
  const y = (evt.clientY - rect.top) / rect.height
  return [clamp01(x), clamp01(y)]
}

function hitTestNewBoxes(pageNum: number, normX: number, normY: number) {
  const bxs = answerNewBoxes.value
  for (let i = bxs.length - 1; i >= 0; i--) {
    const b = bxs[i]
    if (!b || b.page !== pageNum) continue
    if (!Array.isArray(b.bbox) || b.bbox.length !== 4) continue
    const [x0, y0, x1, y1] = b.bbox
    const pad = 0.012

    // corner handles
    const corners: { kind: 'resize'; corner: string; x: number; y: number }[] = [
      { kind: 'resize', corner: 'tl', x: x0, y: y0 },
      { kind: 'resize', corner: 'tr', x: x1, y: y0 },
      { kind: 'resize', corner: 'bl', x: x0, y: y1 },
      { kind: 'resize', corner: 'br', x: x1, y: y1 },
    ]
    const mids: { kind: 'resize'; corner: string; x: number; y: number }[] = [
      { kind: 'resize', corner: 'tm', x: (x0 + x1) / 2, y: y0 },
      { kind: 'resize', corner: 'bm', x: (x0 + x1) / 2, y: y1 },
      { kind: 'resize', corner: 'ml', x: x0, y: (y0 + y1) / 2 },
      { kind: 'resize', corner: 'mr', x: x1, y: (y0 + y1) / 2 },
    ]
    for (const c of corners) {
      if (Math.abs(normX - c.x) <= pad && Math.abs(normY - c.y) <= pad) {
        return { kind: 'resize' as const, box: b, corner: c.corner, idx: i }
      }
    }
    for (const c of mids) {
      if (Math.abs(normX - c.x) <= pad && Math.abs(normY - c.y) <= pad) {
        return { kind: 'resize' as const, box: b, corner: c.corner, idx: i }
      }
    }
    if (pointInBox(normX, normY, b.bbox)) {
      return { kind: 'move' as const, box: b, offX: normX - x0, offY: normY - y0, w: x1 - x0, h: y1 - y0, idx: i }
    }
  }
  return null
}

// --- pointer event handlers ---
function onAnswerPointerDown(pageNum: number, evt: PointerEvent) {
  const canvas = msCanvasByPage.value.get(pageNum)
  if (!canvas) return
  evt.preventDefault()
  canvas.setPointerCapture?.(evt.pointerId)

  const [x, y] = canvasPointToNorm(evt, canvas)
  const hit = hitTestNewBoxes(pageNum, x, y)

  if (hit) {
    if (!answerPendingSnapshot.value) {
      answerPendingSnapshot.value = answerStore.captureAnswerSnapshot()
    }
    selectedAnswerNew.value = hit.box
    dragAnswerOp.value = hit as AnswerDragOp
    drawAnswerOverlayForPage(pageNum)
    return
  }

  // start drawing new box
  selectedAnswerNew.value = null
  dragAnswerOp.value = null
  if (!answerPendingSnapshot.value) {
    answerPendingSnapshot.value = answerStore.captureAnswerSnapshot()
  }
  answerDrawing.value = { page: pageNum, startX: x, startY: y }
}

function onAnswerPointerMove(pageNum: number, evt: PointerEvent) {
  const canvas = msCanvasByPage.value.get(pageNum)
  if (!canvas) return
  evt.preventDefault()
  const [x, y] = canvasPointToNorm(evt, canvas)

  // handle drag (move/resize)
  const op = dragAnswerOp.value
  if (op && op.box) {
    const b = op.box
    const [x0, y0, x1, y1] = b.bbox
    if (op.kind === 'move') {
      const nx0 = clamp01(x - op.offX)
      const ny0 = clamp01(y - op.offY)
      const fx0 = clamp01(Math.min(nx0, 1 - op.w))
      const fy0 = clamp01(Math.min(ny0, 1 - op.h))
      b.bbox = normalizeBox([fx0, fy0, fx0 + op.w, fy0 + op.h])
    } else if (op.kind === 'resize') {
      let nx0 = x0, ny0 = y0, nx1 = x1, ny1 = y1
      if (op.corner === 'tl') { nx0 = x; ny0 = y }
      else if (op.corner === 'tr') { nx1 = x; ny0 = y }
      else if (op.corner === 'bl') { nx0 = x; ny1 = y }
      else if (op.corner === 'br') { nx1 = x; ny1 = y }
      else if (op.corner === 'tm') { ny0 = y }
      else if (op.corner === 'bm') { ny1 = y }
      else if (op.corner === 'ml') { nx0 = x }
      else if (op.corner === 'mr') { nx1 = x }
      b.bbox = normalizeBox([nx0, ny0, nx1, ny1])
    }
    b.bbox = answerStore.alignAnswerBBoxToCurrentBounds(b.bbox)
    const bounds = op.idx === 0 ? answerStore.getAnswerAlignBounds() : null
    if (bounds) {
      for (const box of answerNewBoxes.value) {
        box.bbox = alignAnswerBBoxToBoundsX(box.bbox, bounds) as BoundingBox
      }
      redrawAllOverlays()
    } else {
      drawAnswerOverlayForPage(pageNum)
    }
    return
  }

  // handle drawing
  const drawing = answerDrawing.value
  if (drawing && drawing.page === pageNum) {
    const temp = answerStore.alignAnswerBBoxToCurrentBounds(
      normalizeBox([drawing.startX, drawing.startY, x, y]),
    )
    drawAnswerOverlayForPage(pageNum, temp)
  }
}

function onAnswerPointerUp(pageNum: number, evt: PointerEvent) {
  const canvas = msCanvasByPage.value.get(pageNum)
  if (!canvas) return
  evt.preventDefault()

  const pendingSnapshot = answerPendingSnapshot.value
  const dragOp = dragAnswerOp.value

  if (answerDrawing.value && answerDrawing.value.page === pageNum) {
    const [x, y] = canvasPointToNorm(evt, canvas)
    const drawing = answerDrawing.value
    const finalBox = answerStore.alignAnswerBBoxToCurrentBounds(
      normalizeBox([drawing.startX, drawing.startY, x, y]),
    )
    const minW = 0.005
    const minH = 0.0015
    if (Math.abs(finalBox[2] - finalBox[0]) > minW && Math.abs(finalBox[3] - finalBox[1]) > minH) {
      answerNewBoxes.value.push({ page: pageNum, bbox: finalBox })
    }
    selectedAnswerNew.value = answerNewBoxes.value[answerNewBoxes.value.length - 1] || null
    drawAnswerOverlayForPage(pageNum)
  }

  if (dragOp?.box?.bbox) {
    dragOp.box.bbox = answerStore.alignAnswerBBoxToCurrentBounds(dragOp.box.bbox)
    drawAnswerOverlayForPage(pageNum)
  }

  answerDrawing.value = null
  dragAnswerOp.value = null
  answerPendingSnapshot.value = null
  if (pendingSnapshot) answerStore.commitAnswerHistory(pendingSnapshot)
}

function onAnswerPointerCancel() {
  if (answerDrawing.value) {
    answerDrawing.value = null
    redrawAllOverlays()
  }
  if (dragAnswerOp.value) {
    dragAnswerOp.value = null
    redrawAllOverlays()
  }
  answerPendingSnapshot.value = null
}

// --- scrolling ---
function getScrollContainer(): HTMLElement | null {
  return msScrollRef.value
}

function scrollToMsTarget(target: MsScrollTarget) {
  const pageNum = Number(target?.page)
  if (!Number.isFinite(pageNum)) return
  const bbox = Array.isArray(target.bbox) && target.bbox.length === 4
    ? normalizeBox(target.bbox)
    : null

  markMsPageRendered(pageNum)

  const attemptScroll = (retries = 8) => {
    const container = getScrollContainer()
    if (!container) return
    const el = container.querySelector(`.ms-page-item[data-page="${pageNum}"]`) as HTMLElement | null
    if (!el) return

    try {
      const cr = container.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      let top = container.scrollTop + (r.top - cr.top) - 80

      if (bbox) {
        const media = (el.querySelector('.ms-img-wrap') || el.querySelector('.ms-page-img') || el) as HTMLElement
        const mr = media.getBoundingClientRect()
        const img = el.querySelector('.ms-page-img') as HTMLImageElement | null
        const mediaHeight = mr.height || media.clientHeight || img?.clientHeight || 0
        if (mediaHeight > 1) {
          top = container.scrollTop + (mr.top - cr.top) + bbox[1] * mediaHeight - 120
        } else if (retries > 0) {
          const pageTop = container.scrollTop + (r.top - cr.top) - 80
          container.scrollTo({ top: Math.max(0, pageTop), behavior: 'auto' })
          const run = () => attemptScroll(retries - 1)
          if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(run)
          else setTimeout(run, 16)
          return
        }
      }

      container.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
    } catch {
      el.scrollIntoView({ behavior: 'auto', block: 'start' })
    }
  }

  nextTick(() => {
    attemptScroll()
    const img = getScrollContainer()
      ?.querySelector(`.ms-page-item[data-page="${pageNum}"] .ms-page-img`) as HTMLImageElement | null
    if (bbox && img && !img.complete) {
      img.addEventListener('load', () => attemptScroll(2), { once: true })
    }
  }).catch(() => {})
}

function scrollToMsPage(pageNum: number) {
  scrollToMsTarget({ page: pageNum })
}

function getVisibleMsPageNum(): number | null {
  const container = getScrollContainer()
  if (!container) return null
  const pages = Array.from(container.querySelectorAll('.ms-page-item')) as HTMLElement[]
  if (!pages.length) return null
  const cr = container.getBoundingClientRect()
  const targetY = cr.top + 120
  let best: HTMLElement | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const el of pages) {
    const r = el.getBoundingClientRect()
    if (r.bottom < cr.top + 32 || r.top > cr.bottom) continue
    const d = Math.abs(r.top - targetY)
    if (d < bestDist) {
      bestDist = d
      best = el
    }
  }
  const n = best?.dataset?.page != null ? parseInt(String(best.dataset.page), 10) : NaN
  return Number.isFinite(n) ? n : null
}

function jumpToMsPage() {
  const raw = clampInt(jumpMsPageInput.value, 1, 1000000)
  let pageNo = raw
  const container = getScrollContainer()
  if (!container) return

  // try direct match
  let pageDiv = container.querySelector(`.ms-page-item[data-page="${pageNo}"]`)
  // fallback: treat as index
  if (!pageDiv && raw >= 1 && raw <= msPages.value.length) {
    pageNo = msPages.value[raw - 1].page
    pageDiv = container.querySelector(`.ms-page-item[data-page="${pageNo}"]`)
  }
  if (!pageDiv) return
  markMsPageRendered(pageNo)
  nextTick(() => scrollToMsPage(pageNo))
}

// --- question navigation ---
async function answerPrev() {
  if (!canPrevAnswer.value) return
  answerStore.recordAnswerScrollProgress()
  await answerStore.loadAnswerQuestion(answerQIndex.value - 1)
}

async function answerNext() {
  const isLast = answerQIndex.value >= 0 && answerQIndex.value >= answerQuestions.value.length - 1
  const needSave = answerStore.answerNeedsSave()
  const shouldStopAfterSave = answerReplaceMode.value

  if (needSave) {
    answerStore.recordAnswerScrollProgress()
    const saved = await answerStore.saveAnswer({ preserveScroll: true })
    if (!saved) return
    if (shouldStopAfterSave) return
    if (!isLast) {
      await answerStore.loadAnswerQuestion(answerQIndex.value + 1, { preserveScroll: true })
    }
  } else if (!isLast) {
    answerStore.recordAnswerScrollProgress()
    await answerStore.loadAnswerQuestion(answerQIndex.value + 1, { preserveScroll: true })
  }
}

const answerNextButtonLabel = computed(() => {
  if (answerReplaceMode.value) return t('mark.save')
  const isLast = answerQIndex.value >= 0 && answerQIndex.value >= answerQuestions.value.length - 1
  if (isLast) return t('mark.save')
  return t('answer.nextAndSave') || '下一题(自动保存)'
})

const canNextAction = computed(() => {
  if (answerReplaceMode.value) return answerNeedsSave.value
  const isLast = answerQIndex.value >= 0 && answerQIndex.value >= answerQuestions.value.length - 1
  if (isLast) return answerNeedsSave.value
  return canNextAnswer.value
})

async function handleSave() {
  const saved = await answerStore.saveAnswer()
  if (!saved) return
  redrawAllOverlays()
  // Auto-advance to next question
  const isLast = answerQIndex.value >= 0 && answerQIndex.value >= answerQuestions.value.length - 1
  if (!isLast && !answerReplaceMode.value) {
    await answerStore.loadAnswerQuestion(answerQIndex.value + 1)
    redrawAllOverlays()
  }
}

async function handleBackFromAnswer() {
  await answerStore.backFromAnswer()
}

async function handleClearBoxes() {
  await answerStore.clearAnswerBoxes()
  redrawAllOverlays()
}

function handleUndo() {
  answerStore.undoAnswer()
  nextTick(() => redrawAllOverlays())
}

function handleRedo() {
  answerStore.redoAnswer()
  nextTick(() => redrawAllOverlays())
}

// --- question list click ---
async function goToQuestion(idx: number) {
  if (idx === answerQIndex.value) return
  const shouldStopAfterSave = answerReplaceMode.value
  if (answerStore.answerNeedsSave()) {
    answerStore.recordAnswerScrollProgress()
    const saved = await answerStore.saveAnswer({ preserveScroll: true })
    if (!saved) return
    if (shouldStopAfterSave) return
  }
  answerStore.recordAnswerScrollProgress()
  await answerStore.loadAnswerQuestion(idx)
  redrawAllOverlays()
}

// --- keyboard shortcuts ---
let answerNavCooldown = false

function guardedAnswerNav(fn: () => void | Promise<any>) {
  if (answerNavCooldown) return
  answerNavCooldown = true
  void fn()
  setTimeout(() => { answerNavCooldown = false }, 120)
}

function onKeyDown(evt: KeyboardEvent) {
  if (route.name !== 'answer') return
  const tag = (evt.target as HTMLElement)?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return
  const key = evt.key

  if (key === 'j' || key === 'J' || key === 'ArrowLeft') {
    evt.preventDefault()
    guardedAnswerNav(() => answerPrev())
  } else if (key === 'k' || key === 'K' || key === 'ArrowRight') {
    evt.preventDefault()
    guardedAnswerNav(() => answerNext())
  } else if ((evt.ctrlKey || evt.metaKey) && key === 'z' && !evt.shiftKey) {
    evt.preventDefault()
    handleUndo()
  } else if ((evt.ctrlKey || evt.metaKey) && (key === 'y' || (key === 'z' && evt.shiftKey))) {
    evt.preventDefault()
    handleRedo()
  } else if (key === 'Delete' || key === 'Backspace') {
    if (selectedAnswerNew.value || answerNewBoxes.value.length > 0) {
      evt.preventDefault()
      handleClearBoxes()
    }
  }
}

// --- watch for store changes to redraw ---
watch(answerExistingBoxes, () => nextTick(() => redrawAllOverlays()), { deep: true })
watch(answerNewBoxes, () => nextTick(() => redrawAllOverlays()), { deep: true })
watch(selectedAnswerNew, () => nextTick(() => redrawAllOverlays()))

watch(msPages, () => {
  msCanvasByPage.value.clear()
  resetMsPageWindow()
  nextTick(() => {
    rebuildMsPageObserver()
    ensureAnswerWorkPagesRendered()
    redrawAllOverlays()
  })
}, { deep: true })

watch(answerWorkPageSet, () => {
  ensureAnswerWorkPagesRendered()
  nextTick(() => redrawAllOverlays())
})

function routePaperId(): number | null {
  const raw = route.params.paperId
  const value = Array.isArray(raw) ? raw[0] : raw
  const paperId = Number(value)
  return Number.isFinite(paperId) && paperId > 0 ? paperId : null
}

async function refreshMsPaperInfo() {
  msPageCount.value = msPages.value.length
  if (!msPaperId.value) {
    msPaperName.value = ''
    return
  }
  try {
    const msDetail = await api(`/papers/${msPaperId.value}`) as PaperDetail
    msPaperName.value = papersStore.formatPaperName(msDetail)
  } catch {
    msPaperName.value = ''
  }
}

async function ensureAnswerReady() {
  if (route.name !== 'answer' || answerEnsuring) return
  answerEnsuring = true
  try {
    const paperId = routePaperId()
    if (paperId && currentPaperId.value !== paperId) {
      await papersStore.openPaper(paperId)
      answerReadyPaperId.value = null
    }

    const routePaperReady = currentPaperId.value && answerReadyPaperId.value === currentPaperId.value && !!msPaperId.value
    if (currentPaperId.value && !routePaperReady && !answerReplaceMode.value) {
      await answerStore.openAnswerForPaper()
    }

    await refreshMsPaperInfo()
    await nextTick()
    attachMsScrollRenderListener()
    rebuildMsPageObserver()
    ensureAnswerWorkPagesRendered()
    redrawAllOverlays()
  } finally {
    answerEnsuring = false
  }
}

watch(
  () => [route.name, route.params.paperId, currentPaperId.value],
  () => {
    void ensureAnswerReady()
  },
)

// --- lifecycle ---
let _keyListenerAttached = false
function attachKeyListener() {
  if (!_keyListenerAttached) {
    document.addEventListener('keydown', onKeyDown)
    _keyListenerAttached = true
  }
}
function detachKeyListener() {
  if (_keyListenerAttached) {
    document.removeEventListener('keydown', onKeyDown)
    _keyListenerAttached = false
  }
}

onMounted(async () => {
  attachKeyListener()
  answerStore.setAnswerViewBridge({ getVisibleMsPageNum, scrollToMsPage, scrollToMsTarget })
  await ensureAnswerReady()
  attachMsScrollRenderListener()
})

onActivated(() => {
  attachKeyListener()
  answerStore.setAnswerViewBridge({ getVisibleMsPageNum, scrollToMsPage, scrollToMsTarget })
  void ensureAnswerReady()
  nextTick(() => attachMsScrollRenderListener()).catch(() => {})
})

onDeactivated(() => {
  detachKeyListener()
  answerStore.setAnswerViewBridge(null)
  detachMsScrollRenderListener()
})

onBeforeUnmount(() => {
  detachKeyListener()
  answerStore.setAnswerViewBridge(null)
  disposeMsPageWindow()
})

// --- format helpers ---
function formatBbox(bbox: number[]): string {
  if (!Array.isArray(bbox)) return ''
  return bbox.map((v) => Number(v).toFixed(3)).join(', ')
}
</script>

<template>
  <div class="answer-view">
    <!-- No paper: empty state -->
    <template v-if="!currentPaperId || !msPaperId">
      <div class="card" style="flex: 1; display: flex; flex-direction: column; margin-bottom: 0">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
          <div style="display: flex; align-items: center; gap: 14px">
            <div class="card-title" style="margin-bottom: 0">{{ t('answer.title') }}</div>
            <span style="font-size: 12px; color: var(--text-tertiary)">{{ t('answer.noPaper') }}</span>
          </div>
        </div>
        <div class="canvas-placeholder">
          <div class="empty">
            <div class="empty-icon">&#128221;</div>
            <div class="empty-text">{{ answerEmptyText }}</div>
          </div>
        </div>
      </div>
    </template>

    <!-- Answer mode active -->
    <template v-else>
      <div class="answer-main">
        <!-- Left: MS page scroll + canvas -->
        <div class="card answer-canvas-card">
          <!-- Toolbar -->
          <div class="answer-toolbar">
            <div class="answer-toolbar-left">
              <div class="card-title" style="margin-bottom: 0">{{ t('answer.title') }}</div>
              <span class="paper-name">{{ answerPaperTitleText }}</span>
              <span v-if="msPageInfoText" class="page-pill">{{ msPageInfoText }}</span>
              <span class="q-info-pill">{{ answerQInfoText }}</span>
            </div>
            <div class="answer-toolbar-right">
              <button class="btn btn-ghost" @click="handleBackFromAnswer">
                {{ answerBackText }}
              </button>

              <div class="toolbar-divider"></div>

              <!-- Prev/Next question -->
              <button class="btn btn-ghost btn-icon" :disabled="!canPrevAnswer" title="上一题 (J / ←)" @click="answerPrev">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <button class="btn btn-ghost btn-icon" :disabled="!canNextAction" :title="`${answerNextButtonLabel} (K / →)`" @click="answerNext">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
              </button>

              <div class="toolbar-divider"></div>

              <!-- Jump to MS page -->
              <input
                v-model="jumpMsPageInput"
                class="jump-input"
                type="number"
                min="1"
                :placeholder="t('answer.jumpPagePlaceholder') || '页码'"
                @keydown.enter="jumpToMsPage"
              />
              <button class="btn btn-ghost" :disabled="!msPages.length" @click="jumpToMsPage">{{ t('answer.jumpPage') || '跳页' }}</button>

              <div class="toolbar-divider"></div>

              <!-- Undo/Redo -->
              <button class="btn btn-ghost btn-icon" :disabled="!canUndo" title="撤销 (Ctrl+Z)" @click="handleUndo">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
              </button>
              <button class="btn btn-ghost btn-icon" :disabled="!canRedo" title="重做 (Ctrl+Y)" @click="handleRedo">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              </button>

              <div class="toolbar-divider"></div>

              <!-- Clear -->
              <button class="btn btn-ghost" :disabled="!hasNewBoxes && !selectedAnswerNew" @click="handleClearBoxes">
                {{ t('answer.clearBoxes') || '清空框选' }}
              </button>

              <!-- Save & next -->
              <button class="btn btn-primary" :disabled="!answerNeedsSave" @click="handleSave">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                保存并下一题
              </button>
            </div>
          </div>

          <!-- MS pages scroll area -->
          <div ref="msScrollRef" class="ms-scroll">
            <div v-if="!msPages.length" class="canvas-placeholder">
              <div class="empty">
                <div class="empty-icon">&#128196;</div>
                <div class="empty-text">{{ noMsPagesText }}</div>
              </div>
            </div>
            <div
              v-for="p in msPages"
              :key="p.page"
              :ref="(el) => setMsPageItemRef(p.page, el)"
              class="ms-page-item"
              :data-page="p.page"
            >
              <div v-if="isMsPageRendered(p.page)" class="ms-img-wrap">
                <img
                  :src="p.image_url"
                  :alt="`MS page ${p.page}`"
                  class="ms-page-img"
                  :loading="p.page === msPages[0]?.page ? 'eager' : 'lazy'"
                  decoding="async"
                  @load="(evt: Event) => onMsImageLoad(p.page, evt)"
                />
                <canvas
                  :ref="(el) => setMsCanvasRef(p.page, el)"
                  class="ms-overlay-canvas"
                  @pointerdown="(evt: PointerEvent) => onAnswerPointerDown(p.page, evt)"
                  @pointermove="(evt: PointerEvent) => onAnswerPointerMove(p.page, evt)"
                  @pointerup="(evt: PointerEvent) => onAnswerPointerUp(p.page, evt)"
                  @pointercancel="onAnswerPointerCancel"
                />
                <span class="ms-page-label">page {{ p.page }}</span>
              </div>
              <div v-else class="ms-page-placeholder" :style="{ aspectRatio: msPageAspectRatio }">
                <span>page {{ p.page }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Right panel -->
        <div class="card answer-right-panel">
          <!-- Question info -->
          <div class="prop-section">
            <div class="prop-section-header">
              <span class="card-title" style="margin-bottom: 0">当前题目（QP）</span>
              <span class="meta-text">{{ answerQuestionMetaText }}</span>
            </div>
            <div v-if="currentAnswerQuestion" class="question-detail">
              <div class="question-detail-row">
                <span class="question-detail-label">题号</span>
                <span class="question-detail-value">第 {{ answerQIndex + 1 }} 题</span>
              </div>
              <div v-if="currentAnswerQuestion.section" class="question-detail-row">
                <span class="question-detail-label">模块</span>
                <span class="section-pill">{{ currentAnswerQuestion.section }}</span>
              </div>
              <div v-if="currentAnswerQuestionBoxes.length" class="question-crops">
                <div
                  v-for="b in currentAnswerQuestionBoxes"
                  :key="b.key"
                  class="question-crop"
                >
                  <CropPreview :image-url="b.imageUrl" :bbox="b.bbox" />
                </div>
              </div>
              <div v-else class="empty-hint question-crops-empty">暂无题目框选</div>
            </div>
            <div v-else class="empty-hint">暂无题目信息</div>
          </div>

          <div class="divider"></div>

          <!-- Answer boxes preview -->
          <div class="prop-section">
            <div class="prop-section-header">
              <span class="card-title" style="margin-bottom: 0">答案预览（MS）</span>
              <span class="meta-text">{{ answerPreviewMetaText }}</span>
            </div>

            <div v-if="answerPreviewBoxes.length" class="question-crops answer-preview-crops">
              <div
                v-for="b in answerPreviewBoxes"
                :key="b.key"
                class="question-crop answer-preview-crop"
              >
                <CropPreview :image-url="msImageUrlForPage(b.page)" :bbox="b.bbox" />
              </div>
            </div>

            <!-- Existing boxes -->
            <div v-if="answerExistingBoxes.length" class="box-group">
              <div class="box-group-label">已保存</div>
              <div
                v-for="(b, idx) in answerExistingBoxes"
                :key="`ex-${idx}`"
                class="box-row existing"
              >
                <span class="page-label-pill">p{{ b.page }}</span>
                <span class="box-bbox">[{{ formatBbox(b.bbox) }}]</span>
              </div>
            </div>

            <!-- New boxes -->
            <div v-if="answerNewBoxes.length" class="box-group">
              <div class="box-group-label">新增</div>
              <div
                v-for="(b, idx) in answerNewBoxes"
                :key="`new-${idx}`"
                class="box-row"
                :class="{ selected: selectedAnswerNew === b }"
                @click="selectedAnswerNew = b; nextTick(() => redrawAllOverlays())"
              >
                <span class="page-label-pill new">p{{ b.page }}</span>
                <span class="box-bbox">[{{ formatBbox(b.bbox) }}]</span>
                <button class="btn btn-ghost btn-icon btn-xs" @click.stop="selectedAnswerNew = b; nextTick(() => handleClearBoxes())">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>

            <div v-if="!answerExistingBoxes.length && !answerNewBoxes.length" class="empty-hint">
              暂无答案框选
            </div>

            <div class="boxes-hint">{{ answerBoxesHintText }}</div>
          </div>

          <div class="divider"></div>

          <!-- Question list -->
          <div class="prop-section">
            <div class="prop-section-header">
              <span class="card-title" style="margin-bottom: 0">题目列表</span>
              <span class="meta-text">{{ answerQuestions.length }} 题</span>
            </div>
            <div class="question-list">
              <div
                v-for="item in questionList"
                :key="item.q.id"
                class="question-row"
                :class="{ active: item.active }"
                @click="goToQuestion(item.idx)"
              >
                <span class="question-no">{{ item.idx + 1 }}</span>
                <span v-if="item.q.section" class="section-pill-sm">{{ item.q.section }}</span>
                <span v-if="item.idx === answerQIndex" class="current-indicator"></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.answer-view {
  display: flex;
  gap: 20px;
  height: 100%;
  min-height: 0;
}

.answer-main {
  display: flex;
  gap: 12px;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* ── Canvas card ── */
.answer-canvas-card {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  margin-bottom: 0;
  min-width: 0;
  overflow: hidden;
  padding: 12px;
}

.answer-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.answer-toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.answer-toolbar-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.paper-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 300px;
}

.page-pill {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-accent);
  background: var(--accent-soft);
  border-radius: var(--radius-sm);
  white-space: nowrap;
}

.q-info-pill {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
  white-space: nowrap;
}

.toolbar-divider {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 4px;
  flex-shrink: 0;
}

.jump-input {
  width: 64px;
  padding: 5px 8px;
  font-size: 12px;
  font-family: inherit;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  outline: none;
  transition: all var(--duration-fast) var(--ease-out);
}

.jump-input:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* ── MS scroll area ── */
.ms-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 6px;
  background: var(--bg-input);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}

.canvas-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ms-page-item {
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  flex-shrink: 0;
  content-visibility: auto;
  contain-intrinsic-size: auto 760px 588px;
}

.ms-img-wrap {
  position: relative;
  display: block;
  width: 100%;
  max-width: 100%;
}

.ms-page-img {
  display: block;
  max-width: 100%;
  width: 100%;
  height: auto;
  user-select: none;
  -webkit-user-drag: none;
}

.ms-page-placeholder {
  width: 100%;
  aspect-ratio: 1 / 1.414;
  min-height: 240px;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 6px;
  color: var(--text-tertiary);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-xs);
}

.ms-page-placeholder span {
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.82);
  border-radius: var(--radius-xs);
}

.dark .ms-page-placeholder span {
  background: rgba(44, 44, 46, 0.82);
}

.ms-overlay-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: auto;
  cursor: crosshair;
  touch-action: none;
}

.ms-page-label {
  position: absolute;
  top: 6px;
  right: 6px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(8px);
  border-radius: var(--radius-xs);
  pointer-events: none;
  box-shadow: var(--shadow-xs);
}

.dark .ms-page-label {
  background: rgba(44, 44, 46, 0.85);
}

/* ── Right panel ── */
.answer-right-panel {
  width: clamp(340px, 28vw, 430px);
  max-width: 100%;
  flex-shrink: 0;
  margin-bottom: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 12px;
}

.prop-section {
  margin-bottom: 12px;
}

.prop-section:last-child {
  margin-bottom: 0;
}

.prop-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.meta-text {
  font-size: 12px;
  color: var(--text-tertiary);
}

.divider {
  height: 1px;
  background: var(--border);
  margin: 12px 0;
}

.empty-hint {
  font-size: 13px;
  color: var(--text-tertiary);
  padding: 8px 0;
}

/* ── Question detail ── */
.question-detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.question-detail-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.question-detail-label {
  font-size: 12px;
  color: var(--text-tertiary);
  min-width: 36px;
}

.question-detail-value {
  font-weight: 600;
  color: var(--text-primary);
}

.section-pill {
  display: inline-flex;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-accent);
  background: var(--accent-soft);
  border-radius: var(--radius-xs);
}

.question-crops {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin-top: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-primary);
}

.question-crop + .question-crop {
  border-top: 1px solid var(--border);
}

.question-crop {
  width: 100%;
  background: var(--bg-primary);
}

.question-crop :deep(.crop-preview),
.question-crop :deep(.crop-canvas) {
  width: 100%;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  background: var(--bg-primary);
}

.answer-preview-crops {
  margin-bottom: 10px;
}

.question-crops-empty {
  padding: 4px 0 0;
}

/* ── Box list ── */
.box-group {
  margin-bottom: 8px;
}

.box-group-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-tertiary);
  margin-bottom: 4px;
}

.box-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
  font-size: 12px;
  color: var(--text-secondary);
}

.box-row:hover {
  background: var(--bg-hover);
}

.box-row.selected {
  background: var(--accent-soft);
  color: var(--text-accent);
}

.box-row.existing {
  cursor: default;
  opacity: 0.7;
}

.page-label-pill {
  display: inline-flex;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 600;
  color: #34c759;
  background: rgba(52, 199, 89, 0.1);
  border-radius: var(--radius-xs);
}

.page-label-pill.new {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}

.box-bbox {
  font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.boxes-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 8px;
}

/* ── Question list ── */
.question-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 300px;
  overflow-y: auto;
}

.question-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
  font-size: 13px;
  color: var(--text-secondary);
  position: relative;
}

.question-row:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.question-row.active {
  background: var(--accent-soft);
  color: var(--text-accent);
  font-weight: 600;
}

.question-no {
  font-weight: 600;
  min-width: 20px;
}

.section-pill-sm {
  display: inline-flex;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 500;
  color: var(--text-accent);
  background: var(--accent-soft);
  border-radius: var(--radius-xs);
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.current-indicator {
  margin-left: auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

/* ── Button variants ── */
.btn-icon {
  padding: 6px;
  min-width: 32px;
  min-height: 32px;
}

.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.btn-xs {
  padding: 2px 6px;
  font-size: 11px;
  min-height: 24px;
  min-width: 24px;
}

/* ── Empty state ── */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.5;
}

.empty-text {
  font-size: 14px;
  color: var(--text-secondary);
  max-width: 280px;
  line-height: 1.5;
}

@media (max-width: 900px) {
  .answer-view {
    height: 100%;
  }

  .answer-main {
    flex-direction: column;
    min-width: 0;
  }

  .answer-right-panel {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    max-height: none;
  }
}
</style>
