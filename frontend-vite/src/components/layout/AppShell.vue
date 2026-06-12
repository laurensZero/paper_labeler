<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Sidebar from '@/components/Sidebar.vue'
import { useAppStore } from '@/stores/app'
import { usePapersStore } from '@/stores/papers'
import { useSectionsStore } from '@/stores/sections'
import { useSettingsStore } from '@/stores/settings'

defineProps<{
  isDark: boolean
}>()

const emit = defineEmits<{
  toggleTheme: []
}>()

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const appStore = useAppStore()
const papersStore = usePapersStore()
const sectionsStore = useSectionsStore()
const settingsStore = useSettingsStore()

const siderCollapsed = ref(false)
const isNarrowViewport = ref(false)

const activeKey = computed(() => (route.name as string) || 'filter')
const statusLabel = computed(() => appStore.statusText || appStore.statsText || t('status.ready'))
const statusKindClass = computed(() => appStore.statusKind ? `status-${appStore.statusKind}` : '')
const shellStyle = computed(() => ({
  '--shell-sidebar-width': isNarrowViewport.value || siderCollapsed.value ? '72px' : '260px',
}))

const navItems = computed(() => [
  { key: 'filter', label: t('nav.filter') },
  { key: 'mark', label: t('nav.mark') },
  { key: 'answer', label: t('nav.answer') },
  { key: 'sections', label: t('nav.sections') },
  { key: 'settings', label: t('nav.settings') },
])

function syncViewportState() {
  if (typeof window === 'undefined') return
  isNarrowViewport.value = window.innerWidth <= 900
  if (isNarrowViewport.value) siderCollapsed.value = true
}

onMounted(async () => {
  syncViewportState()
  window.addEventListener('resize', syncViewportState)
  settingsStore.loadFromStorage()
  await Promise.all([
    papersStore.refreshPapers(),
    sectionsStore.refreshSectionDefs(),
  ])
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncViewportState)
})

function navigate(key: string) {
  if (key === 'answer' && papersStore.currentPaperId) {
    router.push({ name: key, params: { paperId: String(papersStore.currentPaperId) } })
    return
  }
  router.push({ name: key })
}
</script>

<template>
  <div class="app" :class="{ dark: isDark }" :style="shellStyle">
    <aside class="sidebar" :class="{ collapsed: siderCollapsed, 'narrow-collapsed': isNarrowViewport }">
      <div class="sidebar-brand">
        <div class="brand-mark">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>
            <path d="M8 7h6"/>
            <path d="M8 11h8"/>
          </svg>
        </div>
        <span v-if="!siderCollapsed" class="brand-name">Paper Labeler</span>
        <button v-if="!isNarrowViewport" class="collapse-trigger" @click="siderCollapsed = !siderCollapsed" :title="siderCollapsed ? t('sidebar.expand') : t('sidebar.collapse')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline :points="siderCollapsed ? '9 18 15 12 9 6' : '15 18 9 12 15 6'" />
          </svg>
        </button>
      </div>

      <Sidebar :collapsed="siderCollapsed" />
    </aside>

    <main class="workspace">
      <header class="topbar">
        <div class="topbar-left">
          <nav class="topbar-nav">
            <button
              v-for="item in navItems"
              :key="item.key"
              class="topbar-nav-item"
              :class="{ active: activeKey === item.key }"
              @click="navigate(item.key)"
            >
              {{ item.label }}
            </button>
          </nav>
        </div>
        <div class="topbar-right">
          <button class="theme-toggle" @click="emit('toggleTheme')" :title="isDark ? t('sidebar.lightMode') : t('sidebar.darkMode')">
            <svg v-if="isDark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          </button>
          <div class="status-indicator" :class="statusKindClass">
            <span class="status-pulse"></span>
            <span class="status-label">{{ statusLabel }}</span>
          </div>
        </div>
      </header>

      <div class="workspace-content">
        <router-view v-slot="{ Component }">
          <keep-alive :include="['MarkView', 'FilterView', 'AnswerView']">
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </div>
    </main>
  </div>
</template>
