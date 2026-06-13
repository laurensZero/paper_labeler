<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Sidebar from '@/components/Sidebar.vue'
import TitleBar from './TitleBar.vue'
import { usePapersStore } from '@/stores/papers'
import { useSectionsStore } from '@/stores/sections'
import { useSettingsStore } from '@/stores/settings'

defineProps<{
  isDark: boolean
}>()

const emit = defineEmits<{
  toggleTheme: [event?: MouseEvent]
}>()

const papersStore = usePapersStore()
const sectionsStore = useSectionsStore()
const settingsStore = useSettingsStore()

const siderCollapsed = ref(false)
const isNarrowViewport = ref(false)

const shellStyle = computed(() => ({
  '--shell-sidebar-width': isNarrowViewport.value || siderCollapsed.value ? '72px' : '260px',
}))

function syncViewportState() {
  if (typeof window === 'undefined') return
  isNarrowViewport.value = window.innerWidth <= 640
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
</script>

<template>
  <div class="app" :class="{ dark: isDark }" :style="shellStyle">
    <TitleBar :is-dark="isDark" @toggle-theme="(e) => emit('toggleTheme', e)" />
    <div class="app-body">
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
        </div>

        <Sidebar :collapsed="siderCollapsed" @toggle-collapse="siderCollapsed = !siderCollapsed" />
      </aside>

      <main class="workspace">
        <div class="workspace-content">
          <router-view v-slot="{ Component, route }">
            <Transition name="page-fade" mode="out-in">
              <keep-alive :include="['MarkView', 'FilterView', 'AnswerView']">
                <component :is="Component" :key="route.path" />
              </keep-alive>
            </Transition>
          </router-view>
        </div>
      </main>
    </div>
  </div>
</template>
