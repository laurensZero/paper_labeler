import { ref } from 'vue'

/**
 * Manages fullscreen mode with zoom, floating bar drag, and exit animation.
 */
export function useFullscreen() {
  const fullscreen = ref(false)
  const fsZoom = ref(1)
  const fsExiting = ref(false)
  const fsBarX = ref(-1) // -1 = use CSS default
  const fsBarY = ref(-1)

  let fsDragging = false
  let fsDragOffX = 0
  let fsDragOffY = 0

  function onFsBarPointerDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return
    const el = e.currentTarget as HTMLElement
    fsDragging = true
    fsDragOffX = e.clientX - el.offsetLeft
    fsDragOffY = e.clientY - el.offsetTop
    el.setPointerCapture(e.pointerId)
  }

  function onFsBarPointerMove(e: PointerEvent) {
    if (!fsDragging) return
    fsBarX.value = e.clientX - fsDragOffX
    fsBarY.value = e.clientY - fsDragOffY
  }

  function onFsBarPointerUp() {
    fsDragging = false
  }

  function toggleFullscreen() {
    if (fullscreen.value) {
      fsExiting.value = true
      setTimeout(() => {
        fullscreen.value = false
        fsExiting.value = false
        fsZoom.value = 1
      }, 280)
    } else {
      fullscreen.value = true
    }
  }

  function fsZoomIn() { fsZoom.value = Math.min(5, +(fsZoom.value + 0.25).toFixed(2)) }
  function fsZoomOut() { fsZoom.value = Math.max(0.25, +(fsZoom.value - 0.25).toFixed(2)) }
  function fsZoomReset() { fsZoom.value = 1 }

  function onFsWheel(e: WheelEvent) {
    if (!fullscreen.value || !e.ctrlKey) return
    e.preventDefault()
    if (e.deltaY < 0) fsZoomIn(); else fsZoomOut()
  }

  return {
    fullscreen,
    fsZoom,
    fsExiting,
    fsBarX,
    fsBarY,
    onFsBarPointerDown,
    onFsBarPointerMove,
    onFsBarPointerUp,
    toggleFullscreen,
    fsZoomIn,
    fsZoomOut,
    fsZoomReset,
    onFsWheel,
  }
}
