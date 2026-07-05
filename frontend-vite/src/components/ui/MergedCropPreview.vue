<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

defineOptions({ name: 'MergedCropPreview' })

interface CropBox {
  id?: number | string
  page?: number
  bbox?: number[]
  image_url?: string
}

const imageCache = new Map<string, Promise<HTMLImageElement>>()
const IMAGE_CACHE_LIMIT = 120
const GAP_CSS_PX = 0
const MAX_CANVAS_DPR = 2
const MAX_RENDER_CSS_WIDTH = 1200

const drawQueue: Array<() => Promise<void>> = []
let activeDrawTask = false

function scheduleIdleTask(fn: () => void) {
  const ric = (window as unknown as { requestIdleCallback?: (fn: () => void, opts?: { timeout?: number }) => void }).requestIdleCallback
  if (typeof ric === 'function') {
    ric(fn, { timeout: 700 })
    return
  }
  window.setTimeout(fn, 80)
}

function enqueueDrawTask(task: () => Promise<void>) {
  drawQueue.push(task)
  pumpDrawQueue()
}

function pumpDrawQueue() {
  if (activeDrawTask) return
  const task = drawQueue.shift()
  if (!task) return
  activeDrawTask = true
  scheduleIdleTask(() => {
    task()
      .catch(() => {})
      .finally(() => {
        activeDrawTask = false
        pumpDrawQueue()
      })
  })
}

const props = defineProps<{
  boxes: CropBox[]
}>()

const rootEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const isLoading = ref(true)
const hasError = ref(false)
const estimatedHeight = ref(160)
let drawSeq = 0
let isVisible = false
let disposed = false
let drawQueued = false
let intersectionObserver: IntersectionObserver | null = null
let resizeObserver: ResizeObserver | null = null
let resizeFrame = 0
let lastDrawCssWidth = 0

function clamp01(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function normalizeBoxes() {
  return (Array.isArray(props.boxes) ? props.boxes : [])
    .map((box, index) => {
      const bbox = Array.isArray(box?.bbox) ? box.bbox : []
      const imageUrl = String(box?.image_url || '')
      if (!imageUrl || bbox.length < 4) return null
      const x0 = clamp01(Math.min(Number(bbox[0]), Number(bbox[2])))
      const y0 = clamp01(Math.min(Number(bbox[1]), Number(bbox[3])))
      const x1 = clamp01(Math.max(Number(bbox[0]), Number(bbox[2])))
      const y1 = clamp01(Math.max(Number(bbox[1]), Number(bbox[3])))
      if (x1 <= x0 || y1 <= y0) return null
      return {
        key: String(box?.id ?? `${imageUrl}:${box?.page ?? 0}:${index}`),
        page: Number(box?.page || 0),
        imageUrl,
        x0,
        y0,
        x1,
        y1,
      }
    })
    .filter(Boolean) as Array<{
      key: string
      page: number
      imageUrl: string
      x0: number
      y0: number
      x1: number
      y1: number
    }>
}

function estimateMergedHeight(width: number) {
  const boxes = normalizeBoxes()
  if (!boxes.length || !width) return 160
  const total = boxes.reduce((sum, box) => {
    const aspect = (box.y1 - box.y0) / Math.max(0.001, box.x1 - box.x0)
    return sum + Math.max(48, Math.round(width * aspect))
  }, 0)
  return Math.max(80, Math.min(2400, total + GAP_CSS_PX * Math.max(0, boxes.length - 1)))
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const key = String(url || '')
  const cached = imageCache.get(key)
  if (cached) return cached

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = key
  }).catch((err) => {
    imageCache.delete(key)
    throw err
  })

  imageCache.set(key, promise)
  while (imageCache.size > IMAGE_CACHE_LIMIT) {
    const firstKey = imageCache.keys().next().value
    if (firstKey == null) break
    imageCache.delete(firstKey)
  }
  return promise
}

function requestDraw() {
  if (disposed || !isVisible || drawQueued) return
  drawQueued = true
  enqueueDrawTask(async () => {
    drawQueued = false
    if (disposed || !isVisible) return
    await drawMergedCrops()
  })
}

async function drawMergedCrops() {
  const canvas = canvasEl.value
  const root = rootEl.value
  if (!canvas || !root) return

  const boxes = normalizeBoxes()
  if (!boxes.length) {
    isLoading.value = false
    hasError.value = true
    return
  }

  const seq = ++drawSeq
  if (!lastDrawCssWidth) isLoading.value = true
  hasError.value = false

  try {
    const imageEntries = await Promise.all(boxes.map(async (box) => ({
      box,
      img: await loadImage(box.imageUrl),
    })))
    if (seq !== drawSeq || disposed || !isVisible) return

    // Wait for container to have a valid width
    let containerWidth = Math.round(root.clientWidth || 0)
    if (containerWidth < 10) {
      // Container not laid out yet, use parent width or fallback
      containerWidth = Math.round(root.parentElement?.clientWidth || 300)
    }
    containerWidth = Math.max(10, containerWidth)
    const cssWidth = Math.min(MAX_RENDER_CSS_WIDTH, containerWidth)
    estimatedHeight.value = estimateMergedHeight(cssWidth)
    const dpr = Math.min(MAX_CANVAS_DPR, window.devicePixelRatio || 1)
    const rows = imageEntries.map(({ box, img }) => {
      const sx = box.x0 * img.naturalWidth
      const sy = box.y0 * img.naturalHeight
      const sw = (box.x1 - box.x0) * img.naturalWidth
      const sh = (box.y1 - box.y0) * img.naturalHeight
      const scale = cssWidth / sw
      const dh = Math.max(1, Math.round(sh * scale))
      return { box, img, sx, sy, sw, sh, dw: cssWidth, dh }
    }).filter((row) => row.sw > 0 && row.sh > 0)

    if (!rows.length) {
      isLoading.value = false
      hasError.value = true
      return
    }

    const cssHeight = rows.reduce((sum, row) => sum + row.dh, 0) + GAP_CSS_PX * Math.max(0, rows.length - 1)
    lastDrawCssWidth = cssWidth
    canvas.width = Math.round(cssWidth * dpr)
    canvas.height = Math.round(cssHeight * dpr)
    canvas.style.width = '100%'
    canvas.style.height = `${cssHeight}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssWidth, cssHeight)
    ctx.fillStyle = getComputedStyle(root).getPropertyValue('--bg-input') || '#f5f5f5'
    ctx.fillRect(0, 0, cssWidth, cssHeight)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    let y = 0
    for (const row of rows) {
      ctx.drawImage(row.img, row.sx, row.sy, row.sw, row.sh, 0, y, row.dw, row.dh)
      y += row.dh + GAP_CSS_PX
    }

    isLoading.value = false
  } catch {
    if (seq !== drawSeq) return
    isLoading.value = false
    hasError.value = true
  }
}

function scheduleResizeDraw() {
  if (resizeFrame) return
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = 0
    const width = Math.min(MAX_RENDER_CSS_WIDTH, Math.round(rootEl.value?.clientWidth || 0))
    if (!width || Math.abs(width - lastDrawCssWidth) < 1) return
    requestDraw()
  })
}

onMounted(() => {
  nextTick(() => {
    const width = Math.min(MAX_RENDER_CSS_WIDTH, Math.round(rootEl.value?.clientWidth || 0) || 300)
    estimatedHeight.value = estimateMergedHeight(width)
    if (rootEl.value && typeof IntersectionObserver !== 'undefined') {
      intersectionObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          isVisible = true
          // Wait for two frames to ensure layout is complete
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              lastDrawCssWidth = 0  // Force redraw with correct width
              requestDraw()
            })
          })
          intersectionObserver?.disconnect()
          intersectionObserver = null
        }
      }, { rootMargin: '200px', threshold: 0.01 })
      intersectionObserver.observe(rootEl.value)
    } else {
      isVisible = true
      requestDraw()
    }
    if (rootEl.value && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(scheduleResizeDraw)
      resizeObserver.observe(rootEl.value)
    }
  })
})

onBeforeUnmount(() => {
  disposed = true
  drawSeq += 1
  intersectionObserver?.disconnect()
  intersectionObserver = null
  resizeObserver?.disconnect()
  resizeObserver = null
  if (resizeFrame) window.cancelAnimationFrame(resizeFrame)
})

watch(() => props.boxes, () => {
  nextTick(() => {
    const width = Math.min(MAX_RENDER_CSS_WIDTH, Math.round(rootEl.value?.clientWidth || 0) || 300)
    estimatedHeight.value = estimateMergedHeight(width)
    requestDraw()
  })
}, { deep: true })
</script>

<template>
  <div ref="rootEl" class="merged-crop-preview">
    <div v-if="isLoading" class="merged-crop-preview-state" :style="{ minHeight: `${estimatedHeight}px` }">
      <div class="merged-crop-preview-spinner" />
    </div>
    <div v-else-if="hasError" class="merged-crop-preview-state merged-crop-preview-error">
      加载失败
    </div>
    <canvas
      ref="canvasEl"
      class="merged-crop-preview-canvas"
      :class="{ 'merged-crop-preview-canvas--visible': !isLoading && !hasError }"
    />
  </div>
</template>

<style scoped>
.merged-crop-preview {
  position: relative;
  width: 100%;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: var(--bg-input);
}

.merged-crop-preview-canvas {
  display: block;
  width: 100%;
  opacity: 0;
  transition: opacity var(--duration-normal) var(--ease-out);
}

.merged-crop-preview-canvas--visible {
  opacity: 1;
}

.merged-crop-preview-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 80px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.merged-crop-preview-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: merged-crop-spin 0.6s linear infinite;
}

@keyframes merged-crop-spin {
  to { transform: rotate(360deg); }
}
</style>
