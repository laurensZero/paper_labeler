import { onActivated, onDeactivated, onMounted, onBeforeUnmount } from 'vue'
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
  /** Toggle a section by its 1-based index (1-9). */
  toggleSectionByIndex?: (index: number) => void
}

export function useMarkKeyboard(options: UseMarkKeyboardOptions) {
  let pageNavCooldown = false

  function guardedNav(fn: () => void | Promise<any>) {
    if (pageNavCooldown) return
    pageNavCooldown = true
    void fn()
    setTimeout(() => { pageNavCooldown = false }, 120)
  }

  function onKeyDown(evt: KeyboardEvent) {
    if (!options.isActive()) return

    const tag = (evt.target as HTMLElement)?.tagName?.toLowerCase()
    const key = evt.key.toLowerCase()
    const allowOcrDraftNav = options.hasOcrDraftMode.value && tag === 'select' && (key === 'j' || key === 'k')
    if ((tag === 'input' || tag === 'textarea' || tag === 'select') && !allowOcrDraftNav) return

    if (key === 'j') {
      evt.preventDefault()
      if (options.hasOcrDraftMode.value) guardedNav(() => options.prevOcrDraft())
      else guardedNav(() => options.prevPage())
    } else if (key === 'k') {
      evt.preventDefault()
      if (options.hasOcrDraftMode.value) guardedNav(() => options.nextOcrDraft())
      else guardedNav(() => options.nextPage())
    } else if ((evt.ctrlKey || evt.metaKey) && key === 'z' && !evt.shiftKey) {
      evt.preventDefault()
      options.undo()
    } else if ((evt.ctrlKey || evt.metaKey) && (key === 'y' || (key === 'z' && evt.shiftKey))) {
      evt.preventDefault()
      options.redo()
    } else if (key === 'arrowleft') {
      evt.preventDefault()
      if (options.hasOcrDraftMode.value) guardedNav(() => options.prevOcrDraft())
      else guardedNav(() => options.prevPage())
    } else if (key === 'arrowright') {
      evt.preventDefault()
      if (options.hasOcrDraftMode.value) guardedNav(() => options.nextOcrDraft())
      else guardedNav(() => options.nextPage())
    } else if (key === 'delete' || key === 'backspace') {
      if (options.selectedNewBox.value) {
        evt.preventDefault()
        options.deleteSelectedBox()
      }
    } else if (key >= '1' && key <= '9' && options.toggleSectionByIndex) {
      evt.preventDefault()
      options.toggleSectionByIndex(parseInt(key, 10))
    }
  }

  // keep-alive: onActivated fires right after onMounted on first mount,
  // so use a flag to avoid double-registration.
  let listenerAttached = false

  function attachListener() {
    if (!listenerAttached) {
      document.addEventListener('keydown', onKeyDown)
      listenerAttached = true
    }
  }

  function detachListener() {
    if (listenerAttached) {
      document.removeEventListener('keydown', onKeyDown)
      listenerAttached = false
    }
  }

  onMounted(attachListener)
  onActivated(attachListener)
  onDeactivated(detachListener)
  onBeforeUnmount(detachListener)
}
