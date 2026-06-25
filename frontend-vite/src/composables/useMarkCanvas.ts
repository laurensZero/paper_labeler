import { ref, nextTick, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import type { BoundingBox } from '@/types/common'
import type { Question, QuestionBox } from '@/types'
import { clamp01, normalizeBox, pointInBox } from '@/utils/geometry'

interface NewBox {
  page: number
  bbox: BoundingBox
  source?: string
  draftIdx?: number
  label?: string | null
}

interface DragOp {
  kind: 'move' | 'resize'
  box: NewBox
  offX?: number
  offY?: number
  w?: number
  h?: number
  corner?: string
}

interface UseMarkCanvasOptions {
  newBoxes: Ref<NewBox[]>
  selectedNewBox: Ref<NewBox | null>
  drawing: Ref<boolean>
  startPt: Ref<[number, number] | null>
  dragNewBoxOp: Ref<DragOp | null>
  markPendingSnapshot: Ref<unknown>
  pageQuestions: Ref<Question[]>
  hasOcrDraftMode: Ref<boolean>
  selectedOcrDraftIdx: Ref<number>
  ocrDraftQuestions: Ref<{ label: string; sections: string[] }[]>
  editingQuestionId: Ref<number | null>
  pages: Ref<{ page: number }[]>
  currentPageIndex: Ref<number>
  pageImgUrl: Ref<string>
  captureMarkSnapshot: () => unknown
  commitMarkHistory: (snapshot: unknown) => void
  getMarkAlignBoundsForBox: (box: NewBox | null, isDrawing: boolean) => unknown
  alignMarkBBoxToBoundsX: (bbox: BoundingBox, bounds: unknown) => BoundingBox
}

export function useMarkCanvas(options: UseMarkCanvasOptions) {
  const {
    newBoxes, selectedNewBox, drawing, startPt, dragNewBoxOp, markPendingSnapshot,
    pageQuestions, hasOcrDraftMode, selectedOcrDraftIdx, ocrDraftQuestions,
    editingQuestionId, pages, currentPageIndex, pageImgUrl,
    captureMarkSnapshot, commitMarkHistory, getMarkAlignBoundsForBox, alignMarkBBoxToBoundsX,
  } = options

  const pageImg = ref<HTMLImageElement | null>(null)
  const overlayCanvas = ref<HTMLCanvasElement | null>(null)
  const canvasArea = ref<HTMLElement | null>(null)
  const pageImageLoaded = ref(false)

  let pageImgResizeObserver: ResizeObserver | null = null
  let overlayRefreshFrame = 0
  let overlayDrawFrame = 0
  let markCanvasInteractionActive = false

  // --- canvas sizing ---
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

  // --- geometry ---
  function canvasPointToNorm(evt: PointerEvent | MouseEvent): [number, number] {
    const canvas = overlayCanvas.value
    if (!canvas) return [0, 0]
    const rect = canvas.getBoundingClientRect()
    const x = (evt.clientX - rect.left) / rect.width
    const y = (evt.clientY - rect.top) / rect.height
    return [clamp01(x), clamp01(y)]
  }

  function hitTestNewBoxes(normX: number, normY: number): DragOp | null {
    const bxs = newBoxes.value || []
    const pageNum = pages.value[currentPageIndex.value]?.page
    for (let i = bxs.length - 1; i >= 0; i--) {
      const b = bxs[i]
      if (!b || b.page !== pageNum) continue
      if (!Array.isArray(b.bbox) || b.bbox.length !== 4) continue
      const [x0, y0, x1, y1] = b.bbox
      const pad = 0.012
      const corners: { corner: string; x: number; y: number }[] = [
        { corner: 'tl', x: x0, y: y0 },
        { corner: 'tr', x: x1, y: y0 },
        { corner: 'bl', x: x0, y: y1 },
        { corner: 'br', x: x1, y: y1 },
      ]
      const mids: { corner: string; x: number; y: number }[] = [
        { corner: 'tm', x: (x0 + x1) / 2, y: y0 },
        { corner: 'bm', x: (x0 + x1) / 2, y: y1 },
        { corner: 'ml', x: x0, y: (y0 + y1) / 2 },
        { corner: 'mr', x: x1, y: (y0 + y1) / 2 },
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

  // --- drawing ---
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

    // draw existing confirmed questions
    if (!hasOcrDraftMode.value && editingQuestionId.value == null) {
      for (const q of pageQuestions.value) {
        for (const b of q.boxes || []) {
          if (b.page !== pageNum) continue
          const [x0, y0, x1, y1] = b.bbox
          ctx.strokeStyle = q.status === 'confirmed' ? '#34c759' : '#ff9f0a'
          ctx.lineWidth = 1.5
          ctx.strokeRect(x0 * canvas.width, y0 * canvas.height, (x1 - x0) * canvas.width, (y1 - y0) * canvas.height)
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
      ctx.strokeRect(x0 * canvas.width, y0 * canvas.height, (x1 - x0) * canvas.width, (y1 - y0) * canvas.height)
      // label
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
      // handles on selected box
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
      ctx.strokeRect(x0 * canvas.width, y0 * canvas.height, (x1 - x0) * canvas.width, (y1 - y0) * canvas.height)
      ctx.setLineDash([])
    }
  }

  function highlightQuestion(q: Question) {
    const canvas = overlayCanvas.value
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const pageNum = pages.value[currentPageIndex.value]?.page
    if (pageNum == null) return
    for (const b of q.boxes || []) {
      if (b.page !== pageNum) continue
      const [x0, y0, x1, y1] = b.bbox
      ctx.save()
      ctx.setLineDash([6, 4])
      ctx.strokeStyle = '#0071e3'
      ctx.lineWidth = 2.5
      ctx.strokeRect(x0 * canvas.width, y0 * canvas.height, (x1 - x0) * canvas.width, (y1 - y0) * canvas.height)
      ctx.restore()
    }
  }

  // --- lifecycle ---
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

  // --- pointer handlers ---
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
        markPendingSnapshot.value = captureMarkSnapshot()
      }
      selectedNewBox.value = hit.box
      dragNewBoxOp.value = hit
      drawOverlay()
      return
    }

    selectedNewBox.value = null
    dragNewBoxOp.value = null
    if (!markPendingSnapshot.value) {
      markPendingSnapshot.value = captureMarkSnapshot()
    }
    drawing.value = true
    startPt.value = [x, y]
  }

  function onPointerMove(evt: PointerEvent) {
    evt.preventDefault()
    const [x, y] = canvasPointToNorm(evt)

    const op = dragNewBoxOp.value
    if (op && op.box) {
      const b = op.box
      const [x0, y0, x1, y1] = b.bbox
      if (op.kind === 'move') {
        const nx0 = clamp01(x - (op.offX ?? 0))
        const ny0 = clamp01(y - (op.offY ?? 0))
        const fx0 = clamp01(Math.min(nx0, 1 - (op.w ?? 0)))
        const fy0 = clamp01(Math.min(ny0, 1 - (op.h ?? 0)))
        b.bbox = normalizeBox([fx0, fy0, fx0 + (op.w ?? 0), fy0 + (op.h ?? 0)])
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
      const bounds = getMarkAlignBoundsForBox(b, false)
      if (bounds && op.kind !== 'resize') {
        b.bbox = alignMarkBBoxToBoundsX(b.bbox, bounds)
      }
      drawOverlay()
      return
    }

    if (drawing.value && startPt.value) {
      const [sx, sy] = startPt.value
      let temp = normalizeBox([sx, sy, x, y])
      const bounds = getMarkAlignBoundsForBox(null, true)
      if (bounds) temp = alignMarkBBoxToBoundsX(temp, bounds)
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
      const bounds = getMarkAlignBoundsForBox(null, true)
      if (bounds) finalBox = alignMarkBBoxToBoundsX(finalBox, bounds)
      const minW = 0.005
      const minH = 0.0015
      if (Math.abs(finalBox[2] - finalBox[0]) > minW && Math.abs(finalBox[3] - finalBox[1]) > minH) {
        const pageNum = pages.value[currentPageIndex.value]?.page
        const payload: NewBox = { page: pageNum ?? 0, bbox: finalBox }
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
    if (pendingSnapshot) commitMarkHistory(pendingSnapshot)
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

  // cleanup
  onBeforeUnmount(() => {
    pageImgResizeObserver?.disconnect()
    pageImgResizeObserver = null
    if (overlayRefreshFrame) cancelAnimationFrame(overlayRefreshFrame)
    if (overlayDrawFrame) cancelAnimationFrame(overlayDrawFrame)
  })

  return {
    pageImg,
    overlayCanvas,
    canvasArea,
    pageImageLoaded,
    setCanvasSize,
    refreshOverlaySize,
    queueOverlayDraw,
    clearOverlayCanvas,
    drawOverlay,
    highlightQuestion,
    onPageImgLoad,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onWindowResize,
  }
}
