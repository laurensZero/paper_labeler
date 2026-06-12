import { onMounted, onUnmounted } from 'vue'
import { useAppStore } from '@/stores/app'
import { usePapersStore } from '@/stores/papers'
import { useMarkStore } from '@/stores/mark'
import { useAnswerStore } from '@/stores/answer'

/**
 * Global keyboard shortcuts composable.
 *
 * - J/K: mark view -> prev/next page, answer view -> prev/next question
 * - Ctrl+Z / Ctrl+Shift+Z: undo / redo
 * - Ctrl+Y: redo
 * - Ctrl+S: save current question (mark) or answer
 * - Escape: cancel current operation, close edit mode
 * - Delete: delete selected unsaved box (mark), clear answer boxes (answer)
 */
export function useKeyboard() {
  const app = useAppStore()
  const papers = usePapersStore()
  const mark = useMarkStore()
  const answer = useAnswerStore()

  function isTypingTarget(target: EventTarget | null): boolean {
    if (!target || !(target instanceof HTMLElement)) return false
    const tag = target.tagName
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      target.isContentEditable
    )
  }

  function handleKeydown(evt: KeyboardEvent) {
    const key = evt.key.toLowerCase()
    const isMeta = evt.ctrlKey || evt.metaKey

    // Don't trigger shortcuts while typing in form fields
    if (isTypingTarget(evt.target)) return

    // --- Ctrl+Z: undo ---
    if (isMeta && key === 'z' && !evt.shiftKey) {
      evt.preventDefault()
      if (app.view === 'mark') mark.undoMark()
      if (app.view === 'answer') answer.undoAnswer()
      return
    }

    // --- Ctrl+Shift+Z or Ctrl+Y: redo ---
    if (isMeta && (key === 'y' || (key === 'z' && evt.shiftKey))) {
      evt.preventDefault()
      if (app.view === 'mark') mark.redoMark()
      if (app.view === 'answer') answer.redoAnswer()
      return
    }

    // --- Ctrl+S: save ---
    if (isMeta && key === 's') {
      evt.preventDefault()
      if (app.view === 'mark') mark.saveQuestion()
      if (app.view === 'answer') answer.saveAnswer()
      return
    }

    // --- Escape: cancel / close ---
    if (key === 'escape') {
      evt.preventDefault()
      if (app.view === 'mark' && mark.editingQuestionId != null) {
        mark.exitEditQuestionMode()
      }
      return
    }

    // --- Mark view shortcuts ---
    if (app.view === 'mark') {
      if (key === 'j') {
        evt.preventDefault()
        papers.nextPage()
      }
      if (key === 'k') {
        evt.preventDefault()
        papers.prevPage()
      }
      if (key === 'delete' || key === 'backspace') {
        evt.preventDefault()
        mark.deleteSelectedUnsavedBox()
      }
    }

    // --- Answer view shortcuts ---
    if (app.view === 'answer') {
      if (key === 'j') {
        evt.preventDefault()
        answer.navigateAnswer('next')
      }
      if (key === 'k') {
        evt.preventDefault()
        answer.navigateAnswer('prev')
      }
      if (key === 'delete' || key === 'backspace') {
        evt.preventDefault()
        answer.clearAnswerBoxes()
      }
    }
  }

  onMounted(() => {
    document.addEventListener('keydown', handleKeydown)
  })

  onUnmounted(() => {
    document.removeEventListener('keydown', handleKeydown)
  })
}
