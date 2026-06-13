<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NConfigProvider, darkTheme, lightTheme } from 'naive-ui'
import AppShell from '@/components/layout/AppShell.vue'
import CieImport from '@/components/CieImport.vue'
import AppDialogHost from '@/components/AppDialogHost.vue'
import ExportWizard from '@/views/ExportWizard.vue'

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
}
syncDarkClass()

// -- Circular reveal toggle --
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

function toggleTheme(event?: MouseEvent) {
  const newDark = !isDark.value

  // If reduced motion or no event, just switch immediately
  if (prefersReducedMotion || !event || !(document as any).startViewTransition) {
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
  const transition = (document as any).startViewTransition(() => {
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
    <AppShell :is-dark="isDark" @toggle-theme="toggleTheme" />
    <CieImport />
    <ExportWizard />
    <AppDialogHost :is-dark="isDark" />
  </n-config-provider>
</template>
