import { ref, onScopeDispose } from 'vue'
import type { Ref } from 'vue'
import type { Question } from '@/types'

interface UseDeferredQuestionPreviewOptions {
  results: Ref<Question[]>
  getScrollContainer: () => HTMLElement | null
  onHeightMayChange?: () => void
  renderMarginPx?: number
}

export function useDeferredQuestionPreview(options: UseDeferredQuestionPreviewOptions) {
  const previewVisibleQuestionIds = ref<Set<number>>(new Set())
  const previewTargets = new Map<number, Element>()
  const previewRenderMarginPx = options.renderMarginPx ?? 320
  let previewObserver: IntersectionObserver | null = null
  let previewObserverRoot: HTMLElement | null = null
  let previewRefreshRaf = 0

  function markQuestionPreviewReady(id: number) {
    if (!Number.isFinite(id) || previewVisibleQuestionIds.value.has(id)) return
    const next = new Set(previewVisibleQuestionIds.value)
    next.add(id)
    previewVisibleQuestionIds.value = next
  }

  function isPreviewTargetNearViewport(el: Element) {
    if (!(el instanceof HTMLElement)) return false
    const rect = el.getBoundingClientRect()
    const root = options.getScrollContainer()
    const rootRect = root?.getBoundingClientRect()
    const minY = (rootRect?.top ?? 0) - previewRenderMarginPx
    const maxY = (rootRect?.bottom ?? (window.innerHeight || document.documentElement.clientHeight || 800)) + previewRenderMarginPx
    return rect.bottom >= minY && rect.top <= maxY
  }

  function markNearPreviewTargetsReady() {
    for (const [id, el] of previewTargets.entries()) {
      if (!previewVisibleQuestionIds.value.has(id) && isPreviewTargetNearViewport(el)) {
        markQuestionPreviewReady(id)
        previewObserver?.unobserve(el)
      }
    }
  }

  function isQuestionPreviewReady(q: Question): boolean {
    if (typeof IntersectionObserver === 'undefined') return true
    const id = Number(q?.id)
    return Number.isFinite(id) && previewVisibleQuestionIds.value.has(id)
  }

  function disconnectPreviewObserver() {
    previewObserver?.disconnect()
    previewObserver = null
    previewObserverRoot = null
  }

  function ensurePreviewObserver() {
    if (typeof IntersectionObserver === 'undefined') {
      for (const id of previewTargets.keys()) markQuestionPreviewReady(id)
      return
    }
    const root = options.getScrollContainer()
    if (previewObserver && previewObserverRoot === root) return
    disconnectPreviewObserver()
    previewObserverRoot = root
    previewObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const el = entry.target as HTMLElement
        const id = Number(el.dataset.previewQid)
        markQuestionPreviewReady(id)
        previewObserver?.unobserve(entry.target)
      }
    }, {
      root,
      rootMargin: `${previewRenderMarginPx}px 0px`,
      threshold: 0.01,
    })
    for (const [id, el] of previewTargets.entries()) {
      if (previewVisibleQuestionIds.value.has(id)) continue
      if (isPreviewTargetNearViewport(el)) {
        markQuestionPreviewReady(id)
        continue
      }
      previewObserver.observe(el)
    }
  }

  function queuePreviewObserverRefresh() {
    if (typeof requestAnimationFrame === 'undefined') {
      ensurePreviewObserver()
      return
    }
    if (previewRefreshRaf) cancelAnimationFrame(previewRefreshRaf)
    previewRefreshRaf = requestAnimationFrame(() => {
      previewRefreshRaf = 0
      markNearPreviewTargetsReady()
      ensurePreviewObserver()
    })
  }

  function setPreviewTargetRef(questionId: number | string, el: Element | null) {
    const id = Number(questionId)
    if (!Number.isFinite(id)) return
    const old = previewTargets.get(id)
    if (old && old !== el) previewObserver?.unobserve(old)
    if (!el) {
      previewTargets.delete(id)
      return
    }
    previewTargets.set(id, el)
  if (el instanceof HTMLElement) el.dataset.previewQid = String(id)
  if (isPreviewTargetNearViewport(el)) {
    markQuestionPreviewReady(id)
    previewObserver?.unobserve(el)
    return
  }
  ensurePreviewObserver()
    if (previewVisibleQuestionIds.value.has(id)) return
    previewObserver?.observe(el)
  }

  function prunePreviewStateForResults() {
    const ids = new Set((options.results.value || []).map((q) => Number(q?.id)).filter(Number.isFinite))
    const nextVisible = new Set<number>()
    for (const id of previewVisibleQuestionIds.value) {
      if (ids.has(id)) nextVisible.add(id)
    }
    if (nextVisible.size !== previewVisibleQuestionIds.value.size) previewVisibleQuestionIds.value = nextVisible
    for (const [id, el] of previewTargets.entries()) {
      if (ids.has(id)) continue
      previewObserver?.unobserve(el)
      previewTargets.delete(id)
    }
  }

  function onQuestionPreviewError(q: Question & { __previewFailed?: boolean }) {
    q.__previewFailed = true
    options.onHeightMayChange?.()
  }

  function onQuestionPreviewLoaded() {
    options.onHeightMayChange?.()
  }

  function pauseDeferredQuestionPreview() {
    disconnectPreviewObserver()
    if (previewRefreshRaf) cancelAnimationFrame(previewRefreshRaf)
    previewRefreshRaf = 0
  }

  function disposeDeferredQuestionPreview() {
    pauseDeferredQuestionPreview()
    previewTargets.clear()
  }

  // Auto-cleanup when the owning component/effect scope is disposed
  onScopeDispose(() => {
    disposeDeferredQuestionPreview()
  })

  return {
    isQuestionPreviewReady,
    queuePreviewObserverRefresh,
    setPreviewTargetRef,
    prunePreviewStateForResults,
    onQuestionPreviewError,
    onQuestionPreviewLoaded,
    disconnectPreviewObserver,
    pauseDeferredQuestionPreview,
    disposeDeferredQuestionPreview,
  }
}
