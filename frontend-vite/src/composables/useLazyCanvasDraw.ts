import { nextTick, onBeforeUnmount, onMounted } from 'vue'
import type { Ref } from 'vue'

interface UseLazyCanvasDrawOptions {
  rootEl: Ref<HTMLElement | null>
  draw: () => void
  getDrawnCssWidth: () => number
  resetDrawnCssWidth: () => void
  clampResizeWidth?: (width: number) => number
  onVisible?: () => void
  immediateFallbackDraw?: boolean
}

export function useLazyCanvasDraw(options: UseLazyCanvasDrawOptions) {
  let intersectionObserver: IntersectionObserver | null = null
  let resizeObserver: ResizeObserver | null = null
  let resizeFrame = 0

  function resolveContainerWidth(): number {
    let width = Math.round(options.rootEl.value?.clientWidth || 0)
    if (width < 10) {
      // Container not laid out yet, use parent width or fallback
      width = Math.round(options.rootEl.value?.parentElement?.clientWidth || 300)
    }
    return Math.max(10, width)
  }

  function scheduleResizeDraw() {
    if (resizeFrame) return
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0
      const rawWidth = Math.round(options.rootEl.value?.clientWidth || 0)
      const width = options.clampResizeWidth ? options.clampResizeWidth(rawWidth) : rawWidth
      if (!width || Math.abs(width - options.getDrawnCssWidth()) < 1) return
      options.draw()
    })
  }

  onMounted(() => {
    nextTick(() => {
      if (options.rootEl.value && typeof IntersectionObserver !== 'undefined') {
        intersectionObserver = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            options.onVisible?.()
            // Wait for two frames to ensure layout is complete
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                options.resetDrawnCssWidth()  // Force redraw with correct width
                options.draw()
              })
            })
            intersectionObserver?.disconnect()
            intersectionObserver = null
          }
        }, { rootMargin: '200px', threshold: 0.01 })
        intersectionObserver.observe(options.rootEl.value)
      } else {
        options.onVisible?.()
        if (options.immediateFallbackDraw) {
          options.draw()
        } else {
          requestAnimationFrame(() => requestAnimationFrame(() => options.draw()))
        }
      }
      if (options.rootEl.value && typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(scheduleResizeDraw)
        resizeObserver.observe(options.rootEl.value)
      }
    })
  })

  onBeforeUnmount(() => {
    intersectionObserver?.disconnect()
    intersectionObserver = null
    resizeObserver?.disconnect()
    resizeObserver = null
    if (resizeFrame) {
      window.cancelAnimationFrame(resizeFrame)
      resizeFrame = 0
    }
  })

  return {
    resolveContainerWidth,
  }
}
