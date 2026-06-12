<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'

defineOptions({ name: 'CropCanvas' })

const imageCache = new Map<string, Promise<HTMLImageElement>>()
const IMAGE_CACHE_LIMIT = 120

const props = withDefaults(defineProps<{
  imageUrl: string
  bbox: number[]
  label?: string
}>(), {
  label: '',
})

const canvasEl = ref<HTMLCanvasElement | null>(null)
const rootEl = ref<HTMLElement | null>(null)
const isLoading = ref(true)
const hasError = ref(false)
let drawSeq = 0
let resizeObserver: ResizeObserver | null = null
let resizeFrame: number | null = null
let lastDrawCssWidth = 0

function clamp01(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
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

function drawCrop() {
  const canvas = canvasEl.value
  if (!canvas || !props.imageUrl || !props.bbox || props.bbox.length < 4) return
  const seq = ++drawSeq

  isLoading.value = true
  hasError.value = false

  loadImage(props.imageUrl).then((img) => {
    if (seq !== drawSeq) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const [rawX0, rawY0, rawX1, rawY1] = props.bbox
    const x0 = clamp01(Math.min(Number(rawX0), Number(rawX1)))
    const y0 = clamp01(Math.min(Number(rawY0), Number(rawY1)))
    const x1 = clamp01(Math.max(Number(rawX0), Number(rawX1)))
    const y1 = clamp01(Math.max(Number(rawY0), Number(rawY1)))
    const sx = x0 * img.naturalWidth
    const sy = y0 * img.naturalHeight
    const sw = (x1 - x0) * img.naturalWidth
    const sh = (y1 - y0) * img.naturalHeight

    if (sw <= 0 || sh <= 0) {
      isLoading.value = false
      hasError.value = true
      return
    }

    const dpr = window.devicePixelRatio || 1
    const rootWidth = rootEl.value?.clientWidth || 0
    const displayWidth = Math.max(1, Math.round(rootWidth || canvas.clientWidth || 300))
    const aspect = sh / sw
    const displayHeight = Math.max(1, Math.round(displayWidth * aspect))
    lastDrawCssWidth = displayWidth

    canvas.width = Math.round(displayWidth * dpr)
    canvas.height = Math.round(displayHeight * dpr)
    canvas.style.width = '100%'
    canvas.style.height = 'auto'
    canvas.style.aspectRatio = `${sw} / ${sh}`

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, displayWidth, displayHeight)

    isLoading.value = false
  }).catch(() => {
    if (seq !== drawSeq) return
    isLoading.value = false
    hasError.value = true
  })
}

function scheduleResizeDraw() {
  if (resizeFrame != null) return
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = null
    const width = Math.round(rootEl.value?.clientWidth || 0)
    if (!width || Math.abs(width - lastDrawCssWidth) < 1) return
    drawCrop()
  })
}

onMounted(() => {
  nextTick(() => {
    drawCrop()
    if (rootEl.value && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(scheduleResizeDraw)
      resizeObserver.observe(rootEl.value)
    }
  })
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (resizeFrame != null) {
    window.cancelAnimationFrame(resizeFrame)
    resizeFrame = null
  }
})

watch(() => [props.imageUrl, props.bbox], () => {
  nextTick(drawCrop)
}, { deep: true })
</script>

<template>
  <div ref="rootEl" class="crop-canvas">
    <div v-if="isLoading" class="crop-canvas-loading">
      <div class="crop-canvas-spinner" />
    </div>
    <div v-else-if="hasError" class="crop-canvas-error">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
      </svg>
      <span>加载失败</span>
    </div>
    <canvas
      ref="canvasEl"
      class="crop-canvas-element"
      :class="{ 'crop-canvas-visible': !isLoading && !hasError }"
    />
    <div v-if="label && !isLoading && !hasError" class="crop-canvas-label">
      {{ label }}
    </div>
  </div>
</template>

<style scoped>
.crop-canvas {
  position: relative;
  width: 100%;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-input);
  border: 1px solid var(--border);
}

.crop-canvas-element {
  display: block;
  width: 100%;
  height: auto;
  opacity: 0;
  transition: opacity var(--duration-normal) var(--ease-out);
}

.crop-canvas-visible {
  opacity: 1;
}

.crop-canvas-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 80px;
}

.crop-canvas-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: crop-spin 0.6s linear infinite;
}

@keyframes crop-spin {
  to { transform: rotate(360deg); }
}

.crop-canvas-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 80px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.crop-canvas-label {
  position: absolute;
  bottom: 6px;
  left: 6px;
  padding: 2px 8px;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: white;
  font-size: 11px;
  font-weight: 500;
  border-radius: var(--radius-xs);
  pointer-events: none;
}
</style>
