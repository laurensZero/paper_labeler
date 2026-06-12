import { onBeforeUnmount, onMounted } from 'vue'
import type { Ref } from 'vue'

interface UseMarkKeyboardOptions {
  isActive: () => boolean
  hasOcrDraftMode: Ref<boolean>
  selectedNewBox: Ref<any>
  nextPage: () => void
  prevPage: () => void
  nextOcrDraft: () => Promise<boolean>
  prevOcrDraft: () => Promise<boolean>
  undo: () => void
  redo: () => void
  deleteSelectedBox: () => void
}

export function useMarkKeyboard(options: UseMarkKeyboardOptions) {
  function onKeyDown(evt: KeyboardEvent) {
    if (!options.isActive()) return

    const tag = (evt.target as HTMLElement)?.tagName?.toLowerCase()
    const key = evt.key.toLowerCase()
    const allowOcrDraftNav = options.hasOcrDraftMode.value && tag === 'select' && (key === 'j' || key === 'k')
    if ((tag === 'input' || tag === 'textarea' || tag === 'select') && !allowOcrDraftNav) return

    if (key === 'j') {
      evt.preventDefault()
      if (options.hasOcrDraftMode.value) void options.nextOcrDraft()
      else options.nextPage()
    } else if (key === 'k') {
      evt.preventDefault()
      if (options.hasOcrDraftMode.value) void options.prevOcrDraft()
      else options.prevPage()
    } else if ((evt.ctrlKey || evt.metaKey) && key === 'z' && !evt.shiftKey) {
      evt.preventDefault()
      options.undo()
    } else if ((evt.ctrlKey || evt.metaKey) && (key === 'y' || (key === 'z' && evt.shiftKey))) {
      evt.preventDefault()
      options.redo()
    } else if (key === 'delete' || key === 'backspace') {
      if (options.selectedNewBox.value) {
        evt.preventDefault()
        options.deleteSelectedBox()
      }
    }
  }

  onMounted(() => {
    document.addEventListener('keydown', onKeyDown)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeyDown)
  })
}
