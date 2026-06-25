import { computed, nextTick, ref } from 'vue'
import type { CSSProperties, Ref } from 'vue'
import type { FilterQuestion } from '@/types'

interface UseFilterVirtualListOptions {
  results: Ref<FilterQuestion[]>
  threshold: Ref<number>
  overscanPx: Ref<number>
  getScrollContainer: () => HTMLElement | null
  registerScroller?: (fn: ((questionId: number | string) => boolean) | null) => void
  storageKey?: string
}

export function useFilterVirtualList(options: UseFilterVirtualListOptions) {
  const filterResultsRoot = ref<HTMLElement | null>(null)
  const filterQItemEls = new Map<number, HTMLElement>()
  const virtualScrollTopInList = ref(0)
  const virtualViewportHeight = ref(0)
  const virtualHeights = ref<Record<number, number>>({})

  const virtualDefaultItemHeight = 300
  const virtualMinRowsForStability = 20
  const virtualHeightsCacheKey = options.storageKey || 'cache:filterVirtualHeights:v2'

  let virtualScrollTarget: HTMLElement | Window | null = null
  let virtualScrollHandler: (() => void) | null = null
  let virtualMeasureRaf = 0
  let virtualRefreshRaf = 0
  let virtualScrollRaf = 0
  let virtualResizeObserver: ResizeObserver | null = null
  let virtualObservedEls = new Set<Element>()
  let virtualHeightsSaveTimer: ReturnType<typeof setTimeout> | null = null
  let virtualRuntimeActive = false

  const virtualEstimatedItemHeight = computed(() => {
    const vals = Object.values(virtualHeights.value || {}).filter((v) => Number.isFinite(v) && v > 0)
    if (!vals.length) return virtualDefaultItemHeight
    const avg = Math.round(vals.reduce((sum, v) => sum + v, 0) / vals.length)
    return Math.max(220, Math.min(1200, avg))
  })

  const isVirtualizingFilterResults = computed(() => {
    const n = options.results.value?.length || 0
    if (n <= virtualMinRowsForStability) return false
    return n >= options.threshold.value
  })

  const virtualFilterState = computed(() => {
    const all = Array.isArray(options.results.value) ? options.results.value : []
    if (!isVirtualizingFilterResults.value) {
      return { totalHeight: 0, topById: {} as Record<number, number>, rows: all }
    }

    const starts = new Array(all.length)
    let total = 0
    for (let i = 0; i < all.length; i += 1) {
      starts[i] = total
      const id = Number(all[i]?.id)
      const h = Number.isFinite(id) && virtualHeights.value[id] > 0
        ? virtualHeights.value[id]
        : virtualEstimatedItemHeight.value
      total += h
    }

    const minY = Math.max(0, virtualScrollTopInList.value - options.overscanPx.value)
    const maxY = virtualScrollTopInList.value + virtualViewportHeight.value + options.overscanPx.value
    let start = 0
    while (start < all.length - 1 && starts[start + 1] < minY) start += 1
    let end = start
    while (end < all.length && starts[end] < maxY) end += 1
    if (end <= start) end = Math.min(all.length, start + 1)

    const topById: Record<number, number> = {}
    for (let i = 0; i < all.length; i += 1) {
      const id = Number(all[i]?.id)
      if (Number.isFinite(id) && topById[id] == null) topById[id] = starts[i]
    }

    return { totalHeight: total, topById, rows: all.slice(start, end) }
  })

  const virtualFilterRows = computed(() =>
    isVirtualizingFilterResults.value ? virtualFilterState.value.rows : options.results.value,
  )

  const virtualFilterContainerStyle = computed(() => {
    if (!isVirtualizingFilterResults.value) return null
    return {
      position: 'relative',
      minHeight: '120px',
      height: `${virtualFilterState.value.totalHeight}px`,
    } satisfies CSSProperties
  })

  function loadVirtualHeightsCache() {
    try {
      const raw = localStorage.getItem(virtualHeightsCacheKey)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return
      const next: Record<number, number> = {}
      for (const [k, v] of Object.entries(parsed)) {
        const id = Number(k)
        const h = Number(v)
        if (!Number.isFinite(id) || id <= 0) continue
        if (!Number.isFinite(h) || h < 120 || h > 5000) continue
        next[id] = Math.round(h)
      }
      virtualHeights.value = next
    } catch {}
  }

  function saveVirtualHeightsCache() {
    try { localStorage.setItem(virtualHeightsCacheKey, JSON.stringify(virtualHeights.value || {})) } catch {}
  }

  function queueSaveVirtualHeightsCache() {
    if (virtualHeightsSaveTimer) clearTimeout(virtualHeightsSaveTimer)
    virtualHeightsSaveTimer = setTimeout(() => {
      virtualHeightsSaveTimer = null
      saveVirtualHeightsCache()
    }, 220)
  }

  function queueVirtualRefresh() {
    if (!isVirtualizingFilterResults.value) {
      clearVirtualResizeObserverTargets()
      virtualScrollTopInList.value = 0
      return
    }
    if (typeof requestAnimationFrame === 'undefined') return
    if (virtualRefreshRaf) cancelAnimationFrame(virtualRefreshRaf)
    virtualRefreshRaf = requestAnimationFrame(() => {
      virtualRefreshRaf = 0
      refreshVirtualViewport()
      syncVirtualResizeObserverTargets()
      scheduleVirtualMeasure()
    })
  }

  function ensureVirtualResizeObserver() {
    if (virtualResizeObserver || typeof ResizeObserver === 'undefined') return
    virtualResizeObserver = new ResizeObserver((entries) => {
      if (!entries?.length) return
      refreshVirtualViewport()
      scheduleVirtualMeasure()
    })
  }

  function syncVirtualResizeObserverTargets() {
    if (!isVirtualizingFilterResults.value) {
      clearVirtualResizeObserverTargets()
      return
    }
    ensureVirtualResizeObserver()
    if (!virtualResizeObserver) return
    const nodes = currentFilterQItems()
    const nextSet = new Set<Element>(nodes)

    for (const el of virtualObservedEls) {
      if (!nextSet.has(el)) virtualResizeObserver.unobserve(el)
    }
    for (const el of nextSet) {
      if (!virtualObservedEls.has(el)) virtualResizeObserver.observe(el)
    }
    virtualObservedEls = nextSet
  }

  function clearVirtualResizeObserverTargets() {
    if (!virtualResizeObserver) {
      virtualObservedEls.clear()
      return
    }
    for (const el of virtualObservedEls) virtualResizeObserver.unobserve(el)
    virtualObservedEls.clear()
  }

  function destroyVirtualResizeObserver() {
    clearVirtualResizeObserverTargets()
    virtualResizeObserver?.disconnect()
    virtualResizeObserver = null
  }

  function attachVirtualScrollListener() {
    if (!isVirtualizingFilterResults.value) return
    detachVirtualScrollListener()
    const container = options.getScrollContainer()
    virtualScrollTarget = container || window
    virtualScrollHandler = () => {
      if (!isVirtualizingFilterResults.value || virtualScrollRaf) return
      virtualScrollRaf = requestAnimationFrame(() => {
        virtualScrollRaf = 0
        refreshVirtualViewport()
      })
    }
    virtualScrollTarget.addEventListener('scroll', virtualScrollHandler, { passive: true })
    window.addEventListener('resize', virtualScrollHandler)
    refreshVirtualViewport()
  }

  function detachVirtualScrollListener() {
    if (virtualScrollTarget && virtualScrollHandler) {
      virtualScrollTarget.removeEventListener('scroll', virtualScrollHandler)
    }
    if (virtualScrollHandler) {
      window.removeEventListener('resize', virtualScrollHandler)
    }
    virtualScrollTarget = null
    virtualScrollHandler = null
    if (virtualScrollRaf) cancelAnimationFrame(virtualScrollRaf)
    virtualScrollRaf = 0
  }

  function refreshVirtualViewport() {
    const root = filterResultsRoot.value
    if (!root) {
      virtualScrollTopInList.value = 0
      virtualViewportHeight.value = window.innerHeight || 800
      return
    }
    const container = options.getScrollContainer()
    const listRect = root.getBoundingClientRect()
    if (!container) {
      virtualScrollTopInList.value = Math.max(0, -listRect.top)
      virtualViewportHeight.value = window.innerHeight || 800
      return
    }
    const crect = container.getBoundingClientRect()
    virtualScrollTopInList.value = Math.max(0, crect.top - listRect.top)
    virtualViewportHeight.value = container.clientHeight || crect.height || 800
  }

  function scheduleVirtualMeasure() {
    if (!isVirtualizingFilterResults.value || typeof requestAnimationFrame === 'undefined') return
    if (virtualMeasureRaf) cancelAnimationFrame(virtualMeasureRaf)
    virtualMeasureRaf = requestAnimationFrame(() => {
      virtualMeasureRaf = 0
      measureVirtualHeights()
    })
  }

  function measureVirtualHeights() {
    const nodes = currentFilterQItems()
    if (!nodes.length) return
    const next = { ...(virtualHeights.value || {}) }
    let changed = false
    for (const el of nodes) {
      const id = Number(el?.getAttribute?.('data-qid'))
      if (!Number.isFinite(id)) continue
      const h = Math.max(280, Math.ceil(el.offsetHeight || 0))
      if (!h) continue
      const prev = Number(next[id]) || 0
      if (Math.abs(prev - h) >= 2) {
        next[id] = h
        changed = true
      }
    }
    if (changed) {
      virtualHeights.value = next
      queueSaveVirtualHeightsCache()
    }
  }

  function scrollToVirtualQuestion(qid: number | string) {
    if (!isVirtualizingFilterResults.value) return false
    const id = Number(qid)
    if (!Number.isFinite(id)) return false
    const top = virtualFilterState.value.topById?.[id]
    const root = filterResultsRoot.value
    if (top == null || !root) return false
    const container = options.getScrollContainer()
    if (!container) {
      const base = window.scrollY + root.getBoundingClientRect().top
      window.scrollTo({ top: Math.max(0, base + top - 140), behavior: 'auto' })
      return true
    }
    const crect = container.getBoundingClientRect()
    const baseTop = container.scrollTop + (root.getBoundingClientRect().top - crect.top)
    container.scrollTo({ top: Math.max(0, baseTop + top - 140), behavior: 'auto' })
    return true
  }

  function virtualFilterItemStyle(id: number | string) {
    if (!isVirtualizingFilterResults.value) return null
    const top = virtualFilterState.value.topById?.[Number(id)] || 0
    return {
      position: 'absolute',
      left: '0',
      right: '0',
      top: `${top}px`,
    } satisfies CSSProperties
  }

  function currentFilterQItems() {
    return Array.from(filterQItemEls.values()).filter(Boolean)
  }

  function setFilterResultsRootRef(el: Element | null) {
    filterResultsRoot.value = el instanceof HTMLElement ? el : null
  }

  function setFilterQItemRef(questionId: number | string, el: Element | null) {
    const id = Number(questionId)
    if (!Number.isFinite(id)) return
    if (!el) {
      filterQItemEls.delete(id)
      return
    }
    if (el instanceof HTMLElement) filterQItemEls.set(id, el)
  }

  function syncVirtualRuntime() {
    const shouldRun = isVirtualizingFilterResults.value
    if (shouldRun && !virtualRuntimeActive) {
      virtualRuntimeActive = true
      attachVirtualScrollListener()
      options.registerScroller?.(scrollToVirtualQuestion)
      nextTick(() => queueVirtualRefresh()).catch(() => {})
      return
    }
    if (!shouldRun && virtualRuntimeActive) {
      stopVirtualListRuntime()
      return
    }
    if (shouldRun) {
      nextTick(() => queueVirtualRefresh()).catch(() => {})
    }
  }

  function startVirtualListRuntime() {
    syncVirtualRuntime()
  }

  function stopVirtualListRuntime() {
    virtualRuntimeActive = false
    detachVirtualScrollListener()
    clearVirtualResizeObserverTargets()
    options.registerScroller?.(null)
  }

  function disposeVirtualList() {
    stopVirtualListRuntime()
    if (virtualMeasureRaf) cancelAnimationFrame(virtualMeasureRaf)
    if (virtualRefreshRaf) cancelAnimationFrame(virtualRefreshRaf)
    if (virtualHeightsSaveTimer) clearTimeout(virtualHeightsSaveTimer)
    destroyVirtualResizeObserver()
    filterQItemEls.clear()
  }

  return {
    setFilterResultsRootRef,
    setFilterQItemRef,
    isVirtualizingFilterResults,
    virtualFilterRows,
    virtualFilterContainerStyle,
    loadVirtualHeightsCache,
    queueVirtualRefresh,
    syncVirtualRuntime,
    startVirtualListRuntime,
    stopVirtualListRuntime,
    disposeVirtualList,
    virtualFilterItemStyle,
  }
}
