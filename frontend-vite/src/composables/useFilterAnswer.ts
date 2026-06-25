import { ref } from 'vue'
import { questionsApi } from '@/api/endpoints'
import type { Answer, AnswerBox } from '@/types'

/**
 * Manages answer preview state for the filter view:
 * loading answer boxes from the API, toggling visibility, and scrolling.
 */
export function useFilterAnswer() {
  const ansOpen = ref(false)
  const ansLoaded = ref(false)
  const ansLoading = ref(false)
  const ansBoxes = ref<Pick<AnswerBox, 'image_url' | 'bbox'>[]>([])
  const ansMeta = ref('')
  const ansSectionRef = ref<HTMLElement | null>(null)

  function scrollToAnswer() {
    requestAnimationFrame(() => {
      ansSectionRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  async function loadAnswer(questionId: number) {
    ansLoading.value = true
    ansMeta.value = '加载中...'
    try {
      const d = await questionsApi.getAnswer(questionId) as { answer?: Answer } | null
      const a = d?.answer
      if (!a) {
        ansMeta.value = '未标注'
        ansBoxes.value = []
      } else {
        const ab = a.boxes || []
        ansMeta.value = `MS #${a.ms_paper_id} · ${ab.length} 框`
        ansBoxes.value = ab.map((b) => ({ image_url: b.image_url, bbox: b.bbox }))
      }
      ansLoaded.value = true
    } catch {
      ansMeta.value = '加载失败'
      ansBoxes.value = []
    } finally {
      ansLoading.value = false
    }
  }

  function resetAnswerState() {
    ansOpen.value = false
    ansLoaded.value = false
    ansLoading.value = false
    ansBoxes.value = []
    ansMeta.value = ''
  }

  async function onToggleAnswer(questionId: number | undefined) {
    if (ansOpen.value) {
      ansOpen.value = false
      return
    }
    ansOpen.value = true
    if (!ansLoaded.value && questionId != null) {
      await loadAnswer(questionId)
      scrollToAnswer()
    } else {
      scrollToAnswer()
    }
  }

  return {
    ansOpen,
    ansLoaded,
    ansLoading,
    ansBoxes,
    ansMeta,
    ansSectionRef,
    loadAnswer,
    resetAnswerState,
    onToggleAnswer,
    scrollToAnswer,
  }
}
