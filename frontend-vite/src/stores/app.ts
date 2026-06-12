import { ref } from 'vue'
import { defineStore } from 'pinia'

export type ViewName = 'filter' | 'mark' | 'answer' | 'answerAdmin' | 'section' | 'settings'
export type StatusKind = '' | 'ok' | 'err' | 'info'

export interface NavStackEntry {
  kind: 'filter'
  state: Record<string, unknown>
}

export const useAppStore = defineStore('app', () => {
  // --- state ---
  const view = ref<ViewName>('filter')
  const statusText = ref('')
  const statusKind = ref<StatusKind>('')
  const statsText = ref('')
  const cornerHint = ref('')
  const navStack = ref<NavStackEntry[]>([])

  // --- actions ---
  function setView(v: ViewName) {
    view.value = v
  }

  function setStatus(text: string, kind: StatusKind = '') {
    statusText.value = text
    statusKind.value = kind
  }

  function goBack() {
    if (navStack.value.length) {
      navStack.value.pop()
    }
  }

  function pushNav(entry: NavStackEntry) {
    navStack.value.push(entry)
  }

  function popNav(): NavStackEntry | undefined {
    return navStack.value.pop()
  }

  return {
    // state
    view,
    statusText,
    statusKind,
    statsText,
    cornerHint,
    navStack,
    // actions
    setView,
    setStatus,
    goBack,
    pushNav,
    popNav,
  }
})
