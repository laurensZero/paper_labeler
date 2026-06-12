<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useMarkStore } from '@/stores/mark'
import { usePapersStore } from '@/stores/papers'
import { useSectionsStore } from '@/stores/sections'
import { useAppStore } from '@/stores/app'
import { useAnswerStore } from '@/stores/answer'
import { useFilterStore } from '@/stores/filter'
import SectionTagEditor from '@/components/ui/SectionTagEditor.vue'
import { useMarkKeyboard } from '@/composables/useMarkKeyboard'
import type { TagOptionGroup } from '@/components/ui/SectionTagEditor.vue'
import type { BoundingBox } from '@/types/common'
import { clamp01, normalizeBox, pointInBox } from '@/utils/geometry'

defineOptions({ name: 'MarkView' })

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const markStore = useMarkStore()
const papersStore = usePapersStore()
const sectionsStore = useSectionsStore()
const appStore = useAppStore()
const answerStore = useAnswerStore()
const filterStore = useFilterStore()

const {
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
  qNotes,
  editingQuestionId,
  selectedSectionsForNewQuestion,
  ocrDraftQuestions,
  selectedOcrDraftIdx,
  hasOcrDraftMode,
  boxListGroups,
  dragNewBoxOp,
  markPendingSnapshot,
} = storeToRefs(markStore)

const {
  currentPaperId,
  pages,
  currentPageIndex,
  paperOpening,
  paperTitleText,
  pageInfoText,
  canPrevPage,
  canNextPage,
  canOpenAnswer,
} = storeToRefs(papersStore)

const {
  sectionOptionGroupsVisible,
  sectionLabelMap,
} = storeToRefs(sectionsStore)

// --- refs ---
const pageImg = ref<HTMLImageElement | null>(null)
const overlayCanvas = ref<HTMLCanvasElement | null>(null)
const canvasArea = ref<HTMLElement | null>(null)
let pageImgResizeObserver: ResizeObserver | null = null
let overlayRefreshFrame = 0
let overlayDrawFrame = 0
let markCanvasInteractionActive = false

// --- page navigation ---
const jumpPageInput = ref('')

// --- computed ---
const pageImgUrl = computed(() => {
  const p = pages.value[currentPageIndex.value]
  return p?.image_url ?? ''
})
const pageImageLoaded = ref(false)
const pageImageKey = computed(() => `${currentPaperId.value ?? 'none'}:${currentPageIndex.value}:${pageImgUrl.value}`)
const pagePlaceholderText = computed(() => {
  if (paperOpening.value || pageImgUrl.value) return '正在加载页面...'
  return '暂无页面图片'
})

const canUndo = computed(() =>
  !markPersistBusy.value &&
  (markUndoStack.value.length > 0 || markSavedUndoStack.value.length > 0)
)
const canRedo = computed(() =>
  !markPersistBusy.value &&
  (markRedoStack.value.length > 0 || markSavedRedoStack.value.length > 0)
)
const canReturnToFilter = computed(() => appStore.navStack.some((x) => x.kind === 'filter'))

const sectionTagGroups = computed<TagOptionGroup[]>(() => {
  return (sectionOptionGroupsVisible.value || []).map((g) => ({
    label: g.label,
    options: g.options.map((name: string) => ({
      value: name,
      label: sectionLabelMap.value[name] || name,
    })),
  }))
})

// --- page navigation actions ---
function prevPage() {
  papersStore.prevPage()
}

function nextPage() {
  papersStore.nextPage()
}

async function prevOcrDraft() {
  if (!hasOcrDraftMode.value) return false
  const idx = Math.max(0, selectedOcrDraftIdx.value - 1)
  if (idx === selectedOcrDraftIdx.value) return true
  await selectOcrDraft(idx)
  return true
}

async function nextOcrDraft() {
  if (!hasOcrDraftMode.value) return false
  const maxIdx = Math.max(0, ocrDraftQuestions.value.length - 1)
  const idx = Math.min(maxIdx, selectedOcrDraftIdx.value + 1)
  if (idx === selectedOcrDraftIdx.value) return true
  await selectOcrDraft(idx)
  return true
}

useMarkKeyboard({
  isActive: () => route.name === 'mark',
  hasOcrDraftMode,
  selectedNewBox,
  nextPage,
  prevPage,
  nextOcrDraft,
  prevOcrDraft,
  undo: () => markStore.undoMark(),
  redo: () => markStore.redoMark(),
  deleteSelectedBox: () => markStore.deleteSelectedUnsavedBox(),
})

function jumpToPage() {
  const n = parseInt(jumpPageInput.value, 10)
  if (!Number.isFinite(n) || n < 1) return
  const idx = pages.value.findIndex((p) => p.page === n)
  if (idx >= 0) {
    papersStore.goToPage(idx)
  }
}

function jumpToBoxPage(pageNum: number) {
  const idx = pages.value.findIndex((p) => p.page === pageNum)
  if (idx >= 0) papersStore.goToPage(idx)
}

// --- canvas drawing ---
function setCanvasSize() {
  const img = pageImg.value
  const canvas = overlayCanvas.value
  if (!img || !canvas) return
  const w = img.clientWidth
  const h = img.clientHeight
  if (w === 0 || h === 0) return
  canvas.width = w
  canvas.height = h
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
}

function refreshOverlaySize() {
  if (overlayRefreshFrame) cancelAnimationFrame(overlayRefreshFrame)
  overlayRefreshFrame = requestAnimationFrame(() => {
    overlayRefreshFrame = 0
    setCanvasSize()
    drawOverlay()
  })
}

function queueOverlayDraw() {
  if (overlayDrawFrame) return
  overlayDrawFrame = requestAnimationFrame(() => {
    overlayDrawFrame = 0
    drawOverlay()
  })
}

function finishMarkCanvasInteractionSoon() {
  requestAnimationFrame(() => {
    markCanvasInteractionActive = false
  })
}

function observePageImageSize() {
  pageImgResizeObserver?.disconnect()
  const img = pageImg.value
  if (!img || typeof ResizeObserver === 'undefined') return
  pageImgResizeObserver = new ResizeObserver(() => refreshOverlaySize())
  pageImgResizeObserver.observe(img)
}

function clearOverlayCanvas() {
  if (overlayRefreshFrame) {
    cancelAnimationFrame(overlayRefreshFrame)
    overlayRefreshFrame = 0
  }
  const canvas = overlayCanvas.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
}

function canvasPointToNorm(evt: PointerEvent | MouseEvent): [number, number] {
  const canvas = overlayCanvas.value
  if (!canvas) return [0, 0]
  const rect = canvas.getBoundingClientRect()
  const x = (evt.clientX - rect.left) / rect.width
  const y = (evt.clientY - rect.top) / rect.height
  return [clamp01(x), clamp01(y)]
}

function hitTestNewBoxes(normX: number, normY: number) {
  const bxs = newBoxes.value || []
  const pageNum = pages.value[currentPageIndex.value]?.page
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
        return { kind: 'resize' as const, box: b, corner: c.corner }
      }
    }
    for (const c of mids) {
      if (Math.abs(normX - c.x) <= pad && Math.abs(normY - c.y) <= pad) {
        return { kind: 'resize' as const, box: b, corner: c.corner }
      }
    }
    if (pointInBox(normX, normY, b.bbox)) {
      return { kind: 'move' as const, box: b, offX: normX - x0, offY: normY - y0, w: x1 - x0, h: y1 - y0 }
    }
  }
  return null
}

function drawOverlay(tempBox: BoundingBox | null = null) {
  const canvas = overlayCanvas.value
  if (!canvas) return
  if (pageImgUrl.value && !pageImageLoaded.value) {
    clearOverlayCanvas()
    return
  }
  const img = pageImg.value
  if (img && (canvas.width !== img.clientWidth || canvas.height !== img.clientHeight)) {
    setCanvasSize()
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.lineWidth = 2

  const pageNum = pages.value[currentPageIndex.value]?.page
  if (pageNum == null) return

  // draw existing confirmed questions (non-OCR, non-edit mode)
  if (!hasOcrDraftMode.value && editingQuestionId.value == null) {
    for (const q of pageQuestions.value) {
      for (const b of q.boxes || []) {
        if (b.page !== pageNum) continue
        const [x0, y0, x1, y1] = b.bbox
        ctx.strokeStyle = q.status === 'confirmed' ? '#34c759' : '#ff9f0a'
        ctx.lineWidth = 1.5
        ctx.strokeRect(
          x0 * canvas.width,
          y0 * canvas.height,
          (x1 - x0) * canvas.width,
          (y1 - y0) * canvas.height,
        )
      }
    }
  }

  // draw new boxes
  ctx.lineWidth = 2
  for (const nb of newBoxes.value) {
    if (nb.page !== pageNum) continue
    if (hasOcrDraftMode.value && nb.source !== 'ocr') continue
    if (hasOcrDraftMode.value && Number(nb.draftIdx) !== Number(selectedOcrDraftIdx.value)) {
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.3)'
    } else {
      ctx.strokeStyle = '#ef4444'
    }
    const [x0, y0, x1, y1] = nb.bbox
    ctx.strokeRect(
      x0 * canvas.width,
      y0 * canvas.height,
      (x1 - x0) * canvas.width,
      (y1 - y0) * canvas.height,
    )
    // draw label if present
    if (nb.label != null && String(nb.label).trim()) {
      const text = String(nb.label).trim()
      ctx.save()
      ctx.font = '12px Inter, ui-sans-serif, system-ui, -apple-system, sans-serif'
      const pad = 4
      const tx = x0 * canvas.width + 2
      const ty = y1 * canvas.height - 2
      const m = ctx.measureText(text)
      const tw = Math.ceil(m.width)
      const th = 16
      ctx.fillStyle = 'rgba(239, 68, 68, 0.9)'
      ctx.beginPath()
      ctx.roundRect(tx, ty - th, tw + pad * 2, th, 3)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.fillText(text, tx + pad, ty - 4)
      ctx.restore()
    }
    // draw handles on selected box
    if (selectedNewBox.value === nb) {
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

  // draw temp box while drawing
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

function onPageImgLoad(evt: Event) {
  const img = evt.target as HTMLImageElement | null
  if (img && img.getAttribute('src') !== pageImgUrl.value) return
  pageImageLoaded.value = true
  nextTick(() => {
    observePageImageSize()
    if (canvasArea.value) {
      canvasArea.value.scrollTop = 0
      canvasArea.value.scrollLeft = 0
    }
    setCanvasSize()
    drawOverlay()
  })
}

// --- pointer event handlers ---
function onPointerDown(evt: PointerEvent) {
  if (currentPageIndex.value < 0) return
  evt.preventDefault()
  markCanvasInteractionActive = true
  const canvas = overlayCanvas.value
  if (canvas) canvas.setPointerCapture?.(evt.pointerId)

  const [x, y] = canvasPointToNorm(evt)
  const hit = hitTestNewBoxes(x, y)

  if (hit) {
    if (!markPendingSnapshot.value) {
      markPendingSnapshot.value = markStore.captureMarkSnapshot()
    }
    selectedNewBox.value = hit.box
    dragNewBoxOp.value = hit as any
    drawOverlay()
    return
  }

  // start drawing new box
  selectedNewBox.value = null
  dragNewBoxOp.value = null
  if (!markPendingSnapshot.value) {
    markPendingSnapshot.value = markStore.captureMarkSnapshot()
  }
  drawing.value = true
  startPt.value = [x, y]
}

function onPointerMove(evt: PointerEvent) {
  evt.preventDefault()
  const [x, y] = canvasPointToNorm(evt)

  // handle drag (move/resize)
  const op = dragNewBoxOp.value as any
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
    const bounds = markStore.getMarkAlignBoundsForBox(b, false)
    if (bounds && op.kind !== 'resize') {
      b.bbox = markStore.alignMarkBBoxToBoundsX(b.bbox, bounds) as BoundingBox
    }
    drawOverlay()
    return
  }

  // handle drawing
  if (drawing.value && startPt.value) {
    const [sx, sy] = startPt.value
    let temp = normalizeBox([sx, sy, x, y])
    const bounds = markStore.getMarkAlignBoundsForBox(null, true)
    if (bounds) temp = markStore.alignMarkBBoxToBoundsX(temp, bounds) as BoundingBox
    drawOverlay(temp)
  }
}

function onPointerUp(evt: PointerEvent) {
  evt.preventDefault()
  const pendingSnapshot = markPendingSnapshot.value

  if (drawing.value && startPt.value) {
    const [x, y] = canvasPointToNorm(evt)
    const [sx, sy] = startPt.value
    let finalBox = normalizeBox([sx, sy, x, y])
    const bounds = markStore.getMarkAlignBoundsForBox(null, true)
    if (bounds) finalBox = markStore.alignMarkBBoxToBoundsX(finalBox, bounds) as BoundingBox
    const minW = 0.005
    const minH = 0.0015
    if (Math.abs(finalBox[2] - finalBox[0]) > minW && Math.abs(finalBox[3] - finalBox[1]) > minH) {
      const pageNum = pages.value[currentPageIndex.value]?.page
      const payload: any = { page: pageNum, bbox: finalBox }
      if (hasOcrDraftMode.value) {
        const maxIdx = Math.max(0, ocrDraftQuestions.value.length - 1)
        const di = Math.max(0, Math.min(maxIdx, selectedOcrDraftIdx.value))
        const label = ocrDraftQuestions.value?.[di]?.label ?? null
        payload.source = 'ocr'
        payload.draftIdx = di
        payload.label = label
      }
      newBoxes.value.push(payload)
    }
    selectedNewBox.value = newBoxes.value[newBoxes.value.length - 1] || null
  }

  drawing.value = false
  startPt.value = null
  dragNewBoxOp.value = null
  markPendingSnapshot.value = null
  if (pendingSnapshot) markStore.commitMarkHistory(pendingSnapshot)
  drawOverlay()
  finishMarkCanvasInteractionSoon()
}

function onPointerCancel() {
  if (drawing.value) {
    drawing.value = false
    startPt.value = null
    drawOverlay()
  }
  if (dragNewBoxOp.value) {
    dragNewBoxOp.value = null
    drawOverlay()
  }
  markPendingSnapshot.value = null
  finishMarkCanvasInteractionSoon()
}

function onWindowResize() {
  refreshOverlaySize()
}

// --- watch page changes to reload data ---
watch(currentPageIndex, async () => {
  if (currentPaperId.value != null && currentPageIndex.value >= 0) {
    await markStore.loadPageQuestions()
    await nextTick()
    queueOverlayDraw()
  }
})

watch([currentPaperId, currentPageIndex, pageImgUrl], () => {
  pageImageLoaded.value = false
  pageImgResizeObserver?.disconnect()
  pageImgResizeObserver = null
  pageImg.value = null
  clearOverlayCanvas()
  if (canvasArea.value) {
    canvasArea.value.scrollTop = 0
    canvasArea.value.scrollLeft = 0
  }
}, { flush: 'sync' })

watch(newBoxes, () => {
  if (markCanvasInteractionActive) return
  queueOverlayDraw()
}, { deep: true })

watch(pageQuestions, () => {
  queueOverlayDraw()
}, { deep: true })

watch(selectedNewBox, () => {
  if (markCanvasInteractionActive) return
  queueOverlayDraw()
})

watch(editingQuestionId, () => {
  queueOverlayDraw()
})

// --- format helpers ---
function formatBbox(bbox: number[]): string {
  if (!Array.isArray(bbox)) return ''
  return bbox.map((v) => Number(v).toFixed(3)).join(', ')
}

function getQuestionSectionList(q: any): string[] {
  if (Array.isArray(q.sections)) return q.sections
  if (q.section) return [q.section]
  return []
}

// --- actions ---
async function handleSave() {
  try {
    await markStore.saveQuestion()
    await nextTick()
    drawOverlay()
  } catch (e: any) {
    appStore.setStatus(String(e?.message || e), 'err')
  }
}

async function openAnswerMode() {
  if (!currentPaperId.value) return
  try {
    await answerStore.openAnswerForPaper()
    if (answerStore.msPaperId) {
      router.push({ name: 'answer', params: { paperId: String(currentPaperId.value) } })
    }
  } catch (e: any) {
    appStore.setStatus(String(e?.message || e), 'err')
  }
}

async function returnToFilter() {
  await filterStore.returnToFilterFromNavStack()
}

async function handleAutoRecognize() {
  try {
    await markStore.autoRecognize()
  } catch (e: any) {
    appStore.setStatus(String(e?.message || e), 'err')
  }
}

async function cancelEditQuestion() {
  markStore.exitEditQuestionMode()
  await markStore.clearBoxes()
  appStore.setStatus('已取消修改', 'ok')
}

async function manualRefreshPageQuestions() {
  if (currentPaperId.value == null || currentPageIndex.value < 0) return
  await markStore.loadPageQuestions({ force: true })
  queueOverlayDraw()
}

function deleteBoxItem(box: any) {
  selectedNewBox.value = box
  nextTick(() => {
    markStore.deleteSelectedUnsavedBox()
  })
}

async function selectOcrDraft(idx: number) {
  await markStore.selectOcrDraft(idx)
  await nextTick()
  drawOverlay()
}

function highlightQuestion(q: any) {
  const canvas = overlayCanvas.value
  const img = pageImg.value
  if (!canvas) return
  const pageNum = pages.value[currentPageIndex.value]?.page
  if (!pageNum || !q || !Array.isArray(q.boxes)) return
  if (img && (canvas.width !== img.clientWidth || canvas.height !== img.clientHeight)) {
    setCanvasSize()
    drawOverlay()
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.save()
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(0, 113, 227, 0.8)'
  ctx.setLineDash([6, 4])
  for (const b of q.boxes) {
    if (!b || b.page !== pageNum || !Array.isArray(b.bbox) || b.bbox.length !== 4) continue
    const [x0, y0, x1, y1] = b.bbox
    ctx.strokeRect(
      x0 * canvas.width,
      y0 * canvas.height,
      (x1 - x0) * canvas.width,
      (y1 - y0) * canvas.height,
    )
  }
  ctx.restore()
}

// --- lifecycle ---
onMounted(async () => {
  window.addEventListener('resize', onWindowResize)

  // Handle route param: load paper if navigated directly via URL
  const routePaperId = route.params.paperId
  if (routePaperId && currentPaperId.value !== Number(routePaperId)) {
    await papersStore.openPaper(Number(routePaperId))
  }

  if (currentPaperId.value != null && currentPageIndex.value >= 0) {
    markStore.loadPageQuestions()
    nextTick(() => {
      setCanvasSize()
      drawOverlay()
    })
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  pageImgResizeObserver?.disconnect()
  if (overlayRefreshFrame) cancelAnimationFrame(overlayRefreshFrame)
  if (overlayDrawFrame) cancelAnimationFrame(overlayDrawFrame)
})
</script>

<template>
  <div class="mark-view">
    <!-- No paper selected: empty state -->
    <template v-if="!currentPaperId">
      <div class="card" style="flex: 1; display: flex; flex-direction: column; margin-bottom: 0">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
          <div style="display: flex; align-items: center; gap: 14px">
            <div class="card-title" style="margin-bottom: 0">{{ t('mark.title') }}</div>
            <span style="font-size: 12px; color: var(--text-tertiary)">{{ t('mark.noPaper') }}</span>
          </div>
        </div>
        <div class="canvas-placeholder">
          <div class="empty">
            <div class="empty-icon">&#9997;</div>
            <div class="empty-text">{{ t('mark.empty') }}</div>
          </div>
        </div>
      </div>
    </template>

    <!-- Paper selected: full layout -->
    <template v-else>
      <div class="mark-main">
        <!-- Left: canvas workspace -->
        <div class="card mark-canvas-card">
          <!-- Toolbar -->
          <div class="mark-toolbar">
            <div class="mark-toolbar-left">
              <div class="card-title" style="margin-bottom: 0">{{ t('mark.title') }}</div>
              <span class="paper-name">{{ paperTitleText }}</span>
              <span class="page-pill">{{ pageInfoText }}</span>
            </div>
            <div class="mark-toolbar-right">
              <button v-if="canReturnToFilter" class="btn btn-ghost" @click="returnToFilter">
                返回题库
              </button>
              <div v-if="canReturnToFilter" class="toolbar-divider"></div>

              <!-- Page navigation -->
              <button class="btn btn-ghost btn-icon" :disabled="!canPrevPage" title="上一页 (K)" @click="prevPage">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <button class="btn btn-ghost btn-icon" :disabled="!canNextPage" title="下一页 (J)" @click="nextPage">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
              <input
                v-model="jumpPageInput"
                class="jump-input"
                type="number"
                min="1"
                placeholder="页码"
                @keydown.enter="jumpToPage"
              />
              <button class="btn btn-ghost" @click="jumpToPage">跳页</button>

              <div class="toolbar-divider"></div>

              <!-- Auto recognize -->
              <button class="btn btn-ghost" :disabled="!currentPaperId" @click="handleAutoRecognize">
                自动识别
              </button>

              <!-- Open answer -->
              <button class="btn btn-ghost" :disabled="!canOpenAnswer" @click="openAnswerMode">
                标注答案
              </button>

              <div class="toolbar-divider"></div>

              <!-- Undo/Redo -->
              <button class="btn btn-ghost btn-icon" :disabled="!canUndo" title="撤销 (Ctrl+Z)" @click="markStore.undoMark()">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
              </button>
              <button class="btn btn-ghost btn-icon" :disabled="!canRedo" title="重做 (Ctrl+Y)" @click="markStore.redoMark()">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              </button>

              <div class="toolbar-divider"></div>

              <!-- Save -->
              <button class="btn btn-primary" :disabled="!newBoxes.length" @click="handleSave">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                {{ editingQuestionId == null && hasOcrDraftMode ? '一键保存' : t('mark.save') }}
              </button>
            </div>
          </div>

          <!-- Canvas area -->
          <div ref="canvasArea" class="mark-canvas-area">
            <div v-if="!pageImgUrl" class="canvas-placeholder">
              <div class="empty">
                <div class="empty-icon">&#128196;</div>
                <div class="empty-text">{{ pagePlaceholderText }}</div>
              </div>
            </div>
            <div v-else class="page-stage">
              <div v-show="!pageImageLoaded" class="canvas-placeholder canvas-placeholder-loading">
                <div class="empty">
                  <div class="empty-icon">&#128196;</div>
                  <div class="empty-text">{{ pagePlaceholderText }}</div>
                </div>
              </div>
              <div v-show="pageImageLoaded" :key="pageImageKey" class="img-wrap">
                <img
                  ref="pageImg"
                  :src="pageImgUrl"
                  alt="page"
                  class="page-img"
                  @load="onPageImgLoad"
                />
                <canvas
                  ref="overlayCanvas"
                  class="overlay-canvas"
                  @pointerdown="onPointerDown"
                  @pointermove="onPointerMove"
                  @pointerup="onPointerUp"
                  @pointercancel="onPointerCancel"
                />
              </div>
            </div>
          </div>
        </div>

        <!-- Right panel -->
        <div class="card mark-right-panel">
          <!-- Edit mode hint -->
          <div v-if="editingQuestionId != null" class="edit-mode-banner">
            <span>修改题目 #{{ editingQuestionId }}</span>
            <button class="btn btn-ghost btn-sm" @click="cancelEditQuestion">取消</button>
          </div>

          <!-- Section selector -->
          <div v-if="!hasOcrDraftMode" class="prop-section">
            <label class="form-label">模块</label>
            <SectionTagEditor
              :model-value="selectedSectionsForNewQuestion"
              :option-groups="sectionTagGroups"
              placeholder="选择模块..."
              @update:model-value="(val: string[]) => { selectedSectionsForNewQuestion = val }"
            />
          </div>

          <!-- Notes -->
          <div v-if="!hasOcrDraftMode" class="prop-section">
            <label class="form-label">备注</label>
            <input
              v-model="qNotes"
              class="prop-input"
              type="text"
              placeholder="可空"
            />
          </div>

          <div class="divider"></div>

          <!-- Box list -->
          <div class="prop-section">
            <div class="prop-section-header">
              <span class="card-title" style="margin-bottom: 0">{{ hasOcrDraftMode ? '批量分类（自动识别）' : '框选列表' }}</span>
              <div style="display: flex; align-items: center; gap: 6px">
                <button
                  v-if="hasOcrDraftMode"
                  class="btn btn-ghost btn-sm"
                  @click="markStore.addOcrDraftQuestion()"
                >
                  + 新增一题
                </button>
                <button
                  v-if="newBoxes.length"
                  class="btn btn-ghost btn-sm"
                  @click="markStore.clearBoxes()"
                >
                  清空
                </button>
              </div>
            </div>

            <template v-if="hasOcrDraftMode">
              <!-- OCR draft question list -->
              <div v-if="!newBoxes.length" class="empty-hint">暂无建议框</div>
              <div v-else class="ocr-draft-list">
                <div
                  v-for="(q, idx) in ocrDraftQuestions"
                  :key="idx"
                  class="ocr-draft-row"
                  :class="{ active: idx === selectedOcrDraftIdx }"
                  @click="selectOcrDraft(idx)"
                >
                  <div class="ocr-draft-row-header">
                    <span class="ocr-label-pill">题 {{ q.label || '?' }}</span>
                    <span class="ocr-box-count">{{ newBoxes.filter(b => b.source === 'ocr' && Number(b.draftIdx) === idx).length }} 框</span>
                  </div>
                  <SectionTagEditor
                    :model-value="Array.isArray(q.sections) ? q.sections : []"
                    :option-groups="sectionTagGroups"
                    placeholder="模块..."
                    @update:model-value="(val: string[]) => { q.sections = val }"
                  />
                </div>
              </div>
            </template>

            <template v-else>
              <!-- Manual box list grouped by page -->
              <div v-if="!newBoxes.length" class="empty-hint">
                暂无框选（支持跨页：翻页后可继续框选同一题）
              </div>
              <div v-else>
                <div v-for="group in boxListGroups" :key="group.page" class="box-group">
                  <div class="box-group-header">
                    <span class="page-label-pill">page {{ group.page }}</span>
                    <button class="btn btn-ghost btn-sm" @click="jumpToBoxPage(group.page)">跳到该页</button>
                  </div>
                  <div
                    v-for="item in group.items"
                    :key="item.index"
                    class="box-row"
                    :class="{ selected: selectedNewBox === item.box }"
                    @click="selectedNewBox = item.box; nextTick(() => drawOverlay())"
                  >
                    <span class="box-index">#{{ item.index }}</span>
                    <span v-if="item.label" class="box-label">{{ item.label }}</span>
                    <span class="box-bbox">[{{ formatBbox(item.box.bbox) }}]</span>
                    <button class="btn btn-ghost btn-icon btn-xs" @click.stop="deleteBoxItem(item.box)">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <div class="divider"></div>

          <!-- Page questions -->
          <div class="prop-section">
            <div class="prop-section-header">
              <span class="card-title" style="margin-bottom: 0">本页已标注题目</span>
              <button class="btn btn-ghost btn-sm" :disabled="!currentPaperId || currentPageIndex < 0" @click="manualRefreshPageQuestions">
                刷新
              </button>
            </div>

            <div v-if="!pageQuestions.length" class="empty-hint">本页暂无已标注题目</div>
            <div v-else class="page-questions-list">
              <div v-for="q in pageQuestions" :key="q.id" class="question-row">
                <div class="question-row-header">
                  <div class="question-info">
                    <strong>题号 {{ q.question_no || '(未填)' }}</strong>
                    <template v-if="getQuestionSectionList(q).length">
                      <span
                        v-for="s in getQuestionSectionList(q)"
                        :key="s"
                        class="section-pill"
                      >{{ sectionLabelMap[s] || s }}</span>
                    </template>
                    <span v-else class="section-pill muted">(未填模块)</span>
                  </div>
                  <div class="question-actions">
                    <button class="btn btn-ghost btn-xs" @click="markStore.editQuestion(q)">修改</button>
                    <button class="btn btn-ghost btn-xs" @click="highlightQuestion(q)">高亮</button>
                    <button class="btn btn-ghost btn-xs" @click="markStore.deleteQuestion(q)">删除</button>
                  </div>
                </div>
                <div v-if="q.notes" class="question-notes">{{ q.notes }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mark-view {
  display: flex;
  gap: 20px;
  height: calc(100vh - 100px);
  min-height: 0;
}

.mark-main {
  display: flex;
  gap: 20px;
  flex: 1;
  min-height: 0;
}

/* ── Canvas card ── */
.mark-canvas-card {
  flex: 1 1 720px;
  display: flex;
  flex-direction: column;
  margin-bottom: 0;
  min-width: 680px;
  overflow: hidden;
  padding: 16px;
}

.mark-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.mark-toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.mark-toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.paper-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
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

.mark-canvas-area {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  background: var(--bg-input);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px;
  scrollbar-gutter: stable;
}

.canvas-placeholder {
  flex: 1;
  align-self: stretch;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.page-stage {
  width: 100%;
  min-height: 100%;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}

.page-stage > .canvas-placeholder {
  min-height: 100%;
}

.canvas-placeholder-loading .empty-icon {
  animation: page-loading-pulse 1s ease-in-out infinite;
}

@keyframes page-loading-pulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}

.img-wrap {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  width: 100%;
  max-width: 1180px;
  max-height: none;
}

.page-img {
  display: block;
  max-width: 100%;
  max-height: none;
  width: 100%;
  height: auto;
  user-select: none;
  -webkit-user-drag: none;
}

.overlay-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: auto;
  cursor: crosshair;
  touch-action: none;
}

/* ── Right panel ── */
.mark-right-panel {
  width: 300px;
  flex-shrink: 0;
  margin-bottom: 0;
  max-height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.edit-mode-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--accent-soft);
  border-radius: var(--radius-sm);
  margin-bottom: 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-accent);
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

.prop-input {
  width: 100%;
  padding: 7px 10px;
  font-size: 13px;
  font-family: inherit;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  outline: none;
  transition: all var(--duration-fast) var(--ease-out);
}

.prop-input:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
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

/* ── Box list ── */
.box-group {
  margin-bottom: 10px;
}

.box-group-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.page-label-pill {
  display: inline-flex;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-hover);
  border-radius: var(--radius-xs);
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

.box-index {
  font-weight: 600;
  min-width: 24px;
}

.box-label {
  font-weight: 500;
  color: var(--text-accent);
}

.box-bbox {
  font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── OCR draft ── */
.ocr-draft-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ocr-draft-row {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
}

.ocr-draft-row:hover {
  border-color: var(--border-strong);
}

.ocr-draft-row.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.ocr-draft-row-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.ocr-label-pill {
  display: inline-flex;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  color: white;
  background: var(--accent);
  border-radius: var(--radius-xs);
}

.ocr-box-count {
  font-size: 11px;
  color: var(--text-tertiary);
}

/* ── Page questions ── */
.page-questions-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.question-row {
  padding: 8px 10px;
  background: var(--bg-input);
  border-radius: var(--radius-sm);
  transition: background var(--duration-fast) var(--ease-out);
}

.question-row:hover {
  background: var(--bg-hover);
}

.question-row-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}

.question-info {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  min-width: 0;
}

.question-info strong {
  font-weight: 600;
  white-space: nowrap;
}

.question-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.section-pill {
  display: inline-flex;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-accent);
  background: var(--accent-soft);
  border-radius: var(--radius-xs);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-pill.muted {
  color: var(--text-tertiary);
  background: var(--bg-hover);
}

.question-notes {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 4px;
  line-height: 1.4;
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

@media (max-width: 1320px) {
  .mark-view {
    height: auto;
    min-height: calc(100vh - 100px);
  }

  .mark-main {
    flex-direction: column;
  }

  .mark-canvas-card {
    flex: none;
    min-width: 0;
    min-height: min(760px, calc(100vh - 140px));
  }

  .mark-right-panel {
    width: 100%;
    max-height: 420px;
  }
}

@media (max-width: 760px) {
  .mark-canvas-card {
    padding: 12px;
  }

  .mark-canvas-area {
    padding: 8px;
  }

  .mark-toolbar-left,
  .mark-toolbar-right {
    width: 100%;
  }
}
</style>
