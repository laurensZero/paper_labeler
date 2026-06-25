<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onErrorCaptured, ref } from 'vue'
import { NConfigProvider, darkTheme, lightTheme } from 'naive-ui'
import AppShell from '@/components/layout/AppShell.vue'
import CieImport from '@/components/CieImport.vue'
import AppDialogHost from '@/components/AppDialogHost.vue'
import ExportWizard from '@/views/ExportWizard.vue'

// -- Global error boundary --
const fatal = ref<{ error: unknown; info: string } | null>(null)

onErrorCaptured((err, _instance, info) => {
  fatal.value = { error: err, info }
  console.error('[ErrorBoundary]', err, info)
  return false // prevent propagation
})

function reloadPage() {
  fatal.value = null
  try { window.location.reload() } catch { window.location.href = '/' }
}

const isDark = ref(false)
const theme = computed(() => isDark.value ? darkTheme : lightTheme)

// -- Init: read saved preference or system preference --
const saved = localStorage.getItem('theme')
if (saved === 'dark') {
  isDark.value = true
} else if (saved === 'light') {
  isDark.value = false
} else {
  isDark.value = window.matchMedia('(prefers-color-scheme: dark)').matches
}

// -- Sync .dark class --
function syncDarkClass() {
  document.documentElement.classList.toggle('dark', isDark.value)
  // Notify Electron main process so next splash screen matches
  window.electronAPI?.setTheme(isDark.value ? 'dark' : 'light')
}
syncDarkClass()

// -- Circular reveal toggle --
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

function toggleTheme(event?: MouseEvent) {
  const newDark = !isDark.value

  // If reduced motion or no event, just switch immediately
  if (prefersReducedMotion || !event || !(document as unknown as { startViewTransition?: (cb: () => void) => unknown }).startViewTransition) {
    isDark.value = newDark
    localStorage.setItem('theme', newDark ? 'dark' : 'light')
    syncDarkClass()
    return
  }

  // Set the click origin as CSS custom properties
  const x = event.clientX
  const y = event.clientY
  document.documentElement.style.setProperty('--vt-x', `${x}px`)
  document.documentElement.style.setProperty('--vt-y', `${y}px`)

  // Calculate the max radius needed to cover the viewport
  const maxRadius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  )
  document.documentElement.style.setProperty('--vt-r', `${maxRadius}px`)

  // Use View Transitions API — state change MUST happen inside the callback
  // so the browser captures the OLD state first, then applies the new state.
  const transition = (document as unknown as { startViewTransition: (cb: () => void) => { ready: Promise<void> } }).startViewTransition(() => {
    isDark.value = newDark
    localStorage.setItem('theme', newDark ? 'dark' : 'light')
    syncDarkClass()
  })

  // Fallback: if animation fails, ensure state is correct
  transition.ready.catch(() => {
    isDark.value = newDark
    localStorage.setItem('theme', newDark ? 'dark' : 'light')
    syncDarkClass()
  })
}

onMounted(() => {
  // Listen for system theme changes
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = (e: MediaQueryListEvent) => {
    if (!localStorage.getItem('theme')) {
      isDark.value = e.matches
      syncDarkClass()
    }
  }
  mq.addEventListener('change', handler)
  onBeforeUnmount(() => mq.removeEventListener('change', handler))
})
</script>

<template>
  <n-config-provider :theme="theme">
    <div v-if="fatal" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px;padding:32px;text-align:center;">
      <h2 style="margin:0;font-size:1.25rem;">Something went wrong</h2>
      <pre style="max-width:600px;white-space:pre-wrap;word-break:break-all;font-size:0.8rem;opacity:0.7;">{{ String(fatal.error) }}</pre>
      <button style="padding:8px 24px;border:1px solid #888;border-radius:6px;background:transparent;cursor:pointer;" @click="reloadPage()">
        Reload
      </button>
    </div>
    <template v-else>
      <AppShell :is-dark="isDark" @toggle-theme="toggleTheme" />
      <CieImport />
      <ExportWizard />
      <AppDialogHost :is-dark="isDark" />
    </template>
  </n-config-provider>
</template>
