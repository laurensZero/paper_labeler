<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { usePapersStore } from '@/stores/papers'
import { computed } from 'vue'

defineProps<{
  isDark: boolean
}>()

const emit = defineEmits<{
  toggleTheme: [event?: MouseEvent]
}>()

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const appStore = useAppStore()
const papersStore = usePapersStore()

const isMaximized = ref(false)
const isElectron = ref(false)

const activeKey = computed(() => (route.name as string) || 'filter')
const statusLabel = computed(() => appStore.statusText || appStore.statsText || t('status.ready'))
const statusKindClass = computed(() => appStore.statusKind ? `status-${appStore.statusKind}` : '')

const navItems = computed(() => [
  { key: 'filter', label: t('nav.filter') },
  { key: 'mark', label: t('nav.mark') },
  { key: 'answer', label: t('nav.answer') },
])

onMounted(() => {
  isElectron.value = !!(window as any).electronAPI
  if (isElectron.value) {
    const api = (window as any).electronAPI
    api.isMaximized().then((v: boolean) => { isMaximized.value = v })
    api.onMaximizeChange((v: boolean) => { isMaximized.value = v })
  }
})

function navigate(key: string) {
  if (key === 'answer' && papersStore.currentPaperId) {
    router.push({ name: key, params: { paperId: String(papersStore.currentPaperId) } })
    return
  }
  router.push({ name: key })
}

function minimize() { (window as any).electronAPI?.minimize() }
function maximize() { (window as any).electronAPI?.maximize() }
function close() { (window as any).electronAPI?.close() }
</script>

<template>
  <div v-if="isElectron" class="titlebar">
    <!-- Left: icon + name -->
    <div class="titlebar-left">
      <svg class="titlebar-icon" width="16" height="16" viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="6" fill="#18181b"/>
        <g transform="translate(4, 4)" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>
          <path d="M8 7h6"/>
          <path d="M8 11h8"/>
        </g>
      </svg>
      <span class="titlebar-name">Paper Labeler</span>
    </div>

    <!-- Center: nav -->
    <nav class="titlebar-nav">
      <button
        v-for="item in navItems"
        :key="item.key"
        class="titlebar-nav-item"
        :class="{ active: activeKey === item.key }"
        @click="navigate(item.key)"
      >
        {{ item.label }}
      </button>
    </nav>

    <!-- Right: status + theme + window controls -->
    <div class="titlebar-right">
      <div class="status-indicator" :class="statusKindClass">
        <span class="status-pulse"></span>
        <span class="status-label">{{ statusLabel }}</span>
      </div>
      <button class="titlebar-ghost-btn" @click="emit('toggleTheme', $event)" :title="isDark ? t('sidebar.lightMode') : t('sidebar.darkMode')">
        <svg v-if="isDark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </button>
      <div class="titlebar-sep"></div>
      <button class="titlebar-win-btn" @click="minimize" :title="t('titlebar.minimize')">
        <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.5"/></svg>
      </button>
      <button class="titlebar-win-btn" @click="maximize" :title="isMaximized ? t('titlebar.restore') : t('titlebar.maximize')">
        <svg v-if="isMaximized" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2">
          <rect x="3" y="1" width="8" height="8" rx="1"/><path d="M1 3h2v8H3a1 1 0 0 1-1-1V3z"/>
        </svg>
        <svg v-else width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2">
          <rect x="1.5" y="1.5" width="9" height="9" rx="1"/>
        </svg>
      </button>
      <button class="titlebar-win-btn titlebar-win-btn--close" @click="close" :title="t('titlebar.close')">
        <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.5"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1.5"/></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  height: 36px;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  user-select: none;
  -webkit-app-region: drag;
}

/* Left */
.titlebar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 12px;
  width: 200px;
  flex-shrink: 0;
}

.titlebar-icon { flex-shrink: 0; }

.titlebar-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: -0.2px;
}

/* Center: nav */
.titlebar-nav {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  padding-left: 16px;
}

.titlebar-nav-item {
  padding: 4px 14px;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  border-radius: 6px;
  cursor: pointer;
  transition: all 100ms ease;
  white-space: nowrap;
  -webkit-app-region: no-drag;
}

.titlebar-nav-item:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.titlebar-nav-item.active {
  color: var(--text-primary);
  background: var(--bg-pressed);
  font-weight: 600;
}

/* Right */
.titlebar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 8px;
  height: 100%;
}

.titlebar-ghost-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: none;
  color: var(--text-secondary);
  border-radius: 6px;
  cursor: pointer;
  transition: all 100ms ease;
  -webkit-app-region: no-drag;
}

.titlebar-ghost-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.titlebar-sep {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 4px;
}

/* Status indicator */
.status-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-tertiary);
  background: var(--bg-input);
  pointer-events: none;
}

.status-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-tertiary);
}

.status-indicator.status-ok .status-pulse { background: var(--success); }
.status-indicator.status-err .status-pulse { background: var(--danger); }
.status-indicator.status-busy .status-pulse { background: var(--warning); animation: pulse 1s infinite; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.status-label {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Window controls */
.titlebar-win-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 100%;
  border: none;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 100ms ease;
  -webkit-app-region: no-drag;
}

.titlebar-win-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.titlebar-win-btn--close:hover {
  background: #e81123;
  color: white;
}
</style>
