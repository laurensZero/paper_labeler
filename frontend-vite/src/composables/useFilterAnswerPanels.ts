import type { Ref } from 'vue'
import { questionsApi } from '@/api/endpoints'
import { runLimited } from '@/utils/concurrency'

interface UseFilterAnswerPanelsOptions {
  results: Ref<any[]>
  onHeightMayChange?: () => void
  concurrency?: number
}

export function useFilterAnswerPanels(options: UseFilterAnswerPanelsOptions) {
  const answerLoadConcurrency = options.concurrency ?? 6

  async function ensureFilterAnswerLoaded(q: any) {
    if (q.__ansLoaded) return
    if (q.__ansLoadingPromise) return q.__ansLoadingPromise
    q.__ansMeta = 'Loading...'
    q.__ansLoadingPromise = (async () => {
      const d = await questionsApi.getAnswer(q.id)
      const a = (d as any).answer
      if (!a) {
        q.__ansMeta = 'No answer'
        q.__ansBoxes = []
        q.__ansLoaded = true
        return
      }
      const ab = a.boxes || []
      q.__ansMeta = `Boxes: ${ab.length} · MS#${a.ms_paper_id}`
      q.__ansBoxes = ab.map((b: any) => ({ image_url: b.image_url, bbox: b.bbox }))
      q.__ansLoaded = true
    })()
    try {
      await q.__ansLoadingPromise
    } catch {
      q.__ansMeta = 'Load failed'
    } finally {
      q.__ansLoadingPromise = null
      options.onHeightMayChange?.()
    }
  }

  async function toggleFilterAnswer(q: any) {
    if (q.__ansOpen) {
      q.__ansOpen = false
      options.onHeightMayChange?.()
      return
    }
    q.__ansOpen = true
    options.onHeightMayChange?.()
    await ensureFilterAnswerLoaded(q)
  }

  async function onShowAllAnswers() {
    const rows = options.results.value.filter((q: any) => !q.__ansOpen || !q.__ansLoaded)
    for (const q of rows) q.__ansOpen = true
    options.onHeightMayChange?.()
    await runLimited(rows, answerLoadConcurrency, ensureFilterAnswerLoaded)
  }

  function onHideAllAnswers() {
    for (const q of options.results.value) {
      q.__ansOpen = false
    }
    options.onHeightMayChange?.()
  }

  return {
    ensureFilterAnswerLoaded,
    toggleFilterAnswer,
    onShowAllAnswers,
    onHideAllAnswers,
  }
}
