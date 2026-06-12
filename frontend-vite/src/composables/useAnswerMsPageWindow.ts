import { ref } from 'vue'
import type { Ref } from 'vue'

interface MsPageLike {
  page: number
}

interface UseAnswerMsPageWindowOptions {
  msPages: Ref<MsPageLike[]>
  answerWorkPageSet: Ref<Set<number>>
  bufferPx?: number
}

export function useAnswerMsPageWindow(options: UseAnswerMsPageWindowOptions) {
  const msScrollRef = ref<HTMLDivElement | null>(null)
  const renderedMsPages = ref<Set<number>>(new Set())
  const msPageItems = new Map<number, HTMLElement>()
  const msRenderBufferPx = options.bufferPx ?? 520
  let msPageObserver: IntersectionObserver | null = null
  let msRenderFrame = 0
  let msScrollListeningEl: HTMLElement | null = null

  function setsEqual(a: Set<number>, b: Set<number>) {
    if (a.size !== b.size) return false
    for (const value of a) {
      if (!b.has(value)) return false
    }
    return true
  }

  function markMsPageRendered(pageNum: number) {
    const safePage = Number(pageNum)
    if (!Number.isFinite(safePage)) return
    if (renderedMsPages.value.has(safePage)) return
    const next = new Set(renderedMsPages.value)
    next.add(safePage)
    renderedMsPages.value = next
  }

  function isMsPageRendered(pageNum: number) {
    return renderedMsPages.value.has(pageNum) || options.answerWorkPageSet.value.has(pageNum)
  }

  function computeVisibleMsPages() {
    const next = new Set<number>()
    const container = msScrollRef.value
    if (!container) {
      if (options.msPages.value.length) next.add(options.msPages.value[0].page)
    } else {
      const minY = container.scrollTop - msRenderBufferPx
      const maxY = container.scrollTop + (container.clientHeight || 800) + msRenderBufferPx
      for (const [pageNum, el] of msPageItems.entries()) {
        const top = el.offsetTop
        const bottom = top + (el.offsetHeight || 0)
        if (bottom >= minY && top <= maxY) next.add(pageNum)
      }
      if (!next.size && options.msPages.value.length) next.add(options.msPages.value[0].page)
    }
    for (const pageNum of options.answerWorkPageSet.value) next.add(pageNum)
    if (!setsEqual(next, renderedMsPages.value)) renderedMsPages.value = next
  }

  function ensureAnswerWorkPagesRendered() {
    computeVisibleMsPages()
  }

  function scheduleMsRenderWindowRefresh() {
    if (msRenderFrame) return
    msRenderFrame = requestAnimationFrame(() => {
      msRenderFrame = 0
      computeVisibleMsPages()
    })
  }

  function rebuildMsPageObserver() {
    msPageObserver?.disconnect()
    msPageObserver = null
    if (typeof IntersectionObserver === 'undefined') {
      computeVisibleMsPages()
      return
    }
    msPageObserver = new IntersectionObserver(
      () => scheduleMsRenderWindowRefresh(),
      {
        root: msScrollRef.value,
        rootMargin: `${msRenderBufferPx}px 0px`,
        threshold: 0,
      },
    )
    for (const el of msPageItems.values()) {
      msPageObserver.observe(el)
    }
    scheduleMsRenderWindowRefresh()
  }

  function attachMsScrollRenderListener() {
    const el = msScrollRef.value
    if (msScrollListeningEl === el) return
    if (msScrollListeningEl) {
      msScrollListeningEl.removeEventListener('scroll', scheduleMsRenderWindowRefresh)
    }
    msScrollListeningEl = el
    if (msScrollListeningEl) {
      msScrollListeningEl.addEventListener('scroll', scheduleMsRenderWindowRefresh, { passive: true })
    }
  }

  function detachMsScrollRenderListener() {
    if (msScrollListeningEl) {
      msScrollListeningEl.removeEventListener('scroll', scheduleMsRenderWindowRefresh)
    }
    msScrollListeningEl = null
  }

  function setMsPageItemRef(pageNum: number, el: unknown) {
    const safePage = Number(pageNum)
    if (!Number.isFinite(safePage)) return
    if (!el) {
      const oldEl = msPageItems.get(safePage)
      if (oldEl) msPageObserver?.unobserve(oldEl)
      msPageItems.delete(safePage)
      return
    }
    const node = el as HTMLElement
    msPageItems.set(safePage, node)
    msPageObserver?.observe(node)
  }

  function resetMsPageWindow() {
    msPageItems.clear()
    renderedMsPages.value = options.msPages.value.length ? new Set([options.msPages.value[0].page]) : new Set()
  }

  function disposeMsPageWindow() {
    detachMsScrollRenderListener()
    msPageObserver?.disconnect()
    msPageObserver = null
    if (msRenderFrame) cancelAnimationFrame(msRenderFrame)
    msRenderFrame = 0
    msPageItems.clear()
  }

  return {
    msScrollRef,
    renderedMsPages,
    markMsPageRendered,
    ensureAnswerWorkPagesRendered,
    isMsPageRendered,
    rebuildMsPageObserver,
    attachMsScrollRenderListener,
    detachMsScrollRenderListener,
    setMsPageItemRef,
    resetMsPageWindow,
    disposeMsPageWindow,
  }
}
