<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { usePapersStore } from '@/stores/papers'
import { computed } from 'vue'
import { cloudApi } from '@/api/endpoints'
import { CLOUD_ADMIN_ENABLED } from '@/features'

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

// ---- 快速推送云端（一键同步 + 按钮下方悬浮状态窗）----
const syncUi = ref<'idle' | 'syncing' | 'ok' | 'err'>('idle')
const syncMsg = ref('')
const syncPopover = ref(false)
const syncPhase = ref('')
const syncDuration = ref<number | null>(null)
let syncPollTimer: number | null = null
let syncResetTimer: number | null = null

const syncPhaseLabel = computed(() => {
  const ph = syncPhase.value
  if (!ph) return ''
  const key = `settings.cloud.phase.${ph}`
  const label = t(key)
  return label === key ? ph : label
})

const syncPopText = computed(() => {
  if (syncUi.value === 'syncing') {
    const ph = syncPhaseLabel.value
    return ph ? `${t('titlebar.quickSyncRunning')} · ${ph}` : t('titlebar.quickSyncRunning')
  }
  if (syncUi.value === 'ok') {
    return syncDuration.value != null
      ? `${t('titlebar.quickSyncOk')} · ${syncDuration.value}s`
      : t('titlebar.quickSyncOk')
  }
  return syncMsg.value || t('titlebar.quickSyncErr', { error: '' })
})

function errDetail(e: unknown): string {
  if (e && typeof e === 'object' && 'body' in e) {
    try {
      const body = JSON.parse(String((e as { body: string }).body))
      if (body?.detail) return String(body.detail)
    } catch {
      /* fallthrough */
    }
    return String((e as { body?: string }).body || e)
  }
  return e instanceof Error ? e.message : String(e)
}

function stopSyncPoll() {
  if (syncPollTimer != null) {
    clearInterval(syncPollTimer)
    syncPollTimer = null
  }
}

function scheduleSyncHide(delayMs: number) {
  if (syncResetTimer != null) clearTimeout(syncResetTimer)
  syncResetTimer = window.setTimeout(() => {
    if (syncUi.value !== 'syncing') {
      syncPopover.value = false
      syncUi.value = 'idle'
      syncMsg.value = ''
      syncPhase.value = ''
      syncDuration.value = null
    }
  }, delayMs)
}

function closeSyncPop() {
  if (syncUi.value === 'syncing') return // 同步中状态窗常驻
  if (syncResetTimer != null) clearTimeout(syncResetTimer)
  syncPopover.value = false
  syncUi.value = 'idle'
  syncMsg.value = ''
  syncPhase.value = ''
  syncDuration.value = null
}

async function quickSync() {
  if (!CLOUD_ADMIN_ENABLED || syncUi.value === 'syncing') return
  syncUi.value = 'syncing'
  syncMsg.value = ''
  syncPhase.value = ''
  syncDuration.value = null
  syncPopover.value = true
  try {
    await cloudApi.startSync()
  } catch (e) {
    syncUi.value = 'err'
    syncMsg.value = t('titlebar.quickSyncErr', { error: errDetail(e) })
    scheduleSyncHide(10_000)
    return
  }
  syncPollTimer = window.setInterval(async () => {
    try {
      const s = await cloudApi.syncStatus()
      if (s.running) {
        syncPhase.value = s.current?.phase || ''
        return
      }
      stopSyncPoll()
      const last = s.last ?? s.disk_state
      syncDuration.value = last?.duration_s ?? null
      if (last?.ok) {
        syncUi.value = 'ok'
        scheduleSyncHide(4_000)
      } else {
        syncUi.value = 'err'
        syncMsg.value = t('titlebar.quickSyncErr', {
          error: last?.errors?.[0] || t('titlebar.quickSyncUnknown'),
        })
        scheduleSyncHide(10_000)
      }
    } catch {
      stopSyncPoll()
      syncUi.value = 'idle'
      syncPopover.value = false
    }
  }, 1500)
}

onUnmounted(() => {
  stopSyncPoll()
  if (syncResetTimer != null) clearTimeout(syncResetTimer)
})

const activeKey = computed(() => (route.name as string) || 'filter')
const statusLabel = computed(() => appStore.statusText || appStore.statsText || t('status.ready'))
const statusKindClass = computed(() => appStore.statusKind ? `status-${appStore.statusKind}` : '')

const navItems = computed(() => [
  { key: 'filter', label: t('nav.filter') },
  { key: 'mark', label: t('nav.mark') },
  { key: 'answer', label: t('nav.answer') },
  { key: 'compose', label: t('nav.compose') },
])

onMounted(() => {
  isElectron.value = !!window.electronAPI
  if (isElectron.value) {
    const api = window.electronAPI!
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

function minimize() { window.electronAPI?.minimize() }
function maximize() { window.electronAPI?.maximize() }
function close() { window.electronAPI?.close() }
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
      <div v-if="CLOUD_ADMIN_ENABLED" class="titlebar-sync-wrap">
        <button
          class="titlebar-ghost-btn"
          :class="{
            'titlebar-ghost-btn--spin': syncUi === 'syncing',
            'titlebar-ghost-btn--ok': syncUi === 'ok',
            'titlebar-ghost-btn--err': syncUi === 'err',
          }"
          v-tooltip="syncUi === 'idle' ? t('titlebar.quickSync') : syncPopText"
          @click="quickSync"
        >
          <svg v-if="syncUi === 'ok'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <svg v-else-if="syncUi === 'err'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 16l-4-4-4 4" /><path d="M12 12v9" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
          </svg>
        </button>

        <!-- 点击后悬浮的状态卡片（同步中常驻，完成后自动收起） -->
        <div v-if="syncPopover" class="titlebar-sync-pop" @click="closeSyncPop">
          <span
            class="titlebar-sync-pop-icon"
            :class="{ 'is-spin': syncUi === 'syncing', 'is-ok': syncUi === 'ok', 'is-err': syncUi === 'err' }"
          >
            <svg v-if="syncUi === 'ok'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <svg v-else-if="syncUi === 'err'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16 16l-4-4-4 4" /><path d="M12 12v9" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
            </svg>
          </span>
          <span class="titlebar-sync-pop-text">{{ syncPopText }}</span>
          <button v-if="syncUi !== 'syncing'" class="titlebar-sync-pop-x" @click.stop="closeSyncPop">×</button>
        </div>
      </div>
      <button class="titlebar-ghost-btn" @click="emit('toggleTheme', $event)" v-tooltip="isDark ? t('sidebar.lightMode') : t('sidebar.darkMode')">
        <svg v-if="isDark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </button>
      <div class="titlebar-sep"></div>
      <button class="titlebar-win-btn" @click="minimize" v-tooltip="t('titlebar.minimize')">
        <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.5"/></svg>
      </button>
      <button class="titlebar-win-btn" @click="maximize" v-tooltip="isMaximized ? t('titlebar.restore') : t('titlebar.maximize')">
        <svg v-if="isMaximized" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2">
          <rect x="3" y="1" width="8" height="8" rx="1"/><path d="M1 3h2v8H3a1 1 0 0 1-1-1V3z"/>
        </svg>
        <svg v-else width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2">
          <rect x="1.5" y="1.5" width="9" height="9" rx="1"/>
        </svg>
      </button>
      <button class="titlebar-win-btn titlebar-win-btn--close" @click="close" v-tooltip="t('titlebar.close')">
        <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.5"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1.5"/></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.titlebar {
  position: relative;
  z-index: 100;
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

/* ---- 快速推送云端：按钮状态 + 悬浮状态卡 ---- */
.titlebar-sync-wrap {
  position: relative;
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
}

.titlebar-ghost-btn--spin {
  color: var(--accent, #2070c0);
}

.titlebar-ghost-btn--spin svg {
  animation: sync-spin 1s linear infinite;
}

.titlebar-ghost-btn--ok {
  color: var(--success, #10b981);
}

.titlebar-ghost-btn--err {
  color: var(--danger, #ef4444);
}

.titlebar-sync-pop {
  position: absolute;
  top: calc(100% + 10px);
  right: -6px;
  z-index: 1000;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  min-width: 216px;
  max-width: 320px;
  padding: 11px 12px;
  background: var(--bg-elevated, #ffffff);
  border: 1px solid var(--border, #e4e4e7);
  border-radius: 10px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
  font-size: 12.5px;
  color: var(--text-primary, #18181b);
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.titlebar-sync-pop-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--text-secondary, #52525b);
}

.titlebar-sync-pop-icon.is-spin {
  color: var(--accent, #2070c0);
  animation: sync-spin 1s linear infinite;
}

.titlebar-sync-pop-icon.is-ok {
  color: var(--success, #10b981);
}

.titlebar-sync-pop-icon.is-err {
  color: var(--danger, #ef4444);
}

.titlebar-sync-pop-text {
  flex: 1;
  min-width: 0;
  line-height: 1.5;
  word-break: break-word;
}

.titlebar-sync-pop-x {
  flex-shrink: 0;
  border: none;
  background: none;
  color: var(--text-tertiary, #a1a1aa);
  font-size: 16px;
  line-height: 1;
  padding: 0 1px;
  cursor: pointer;
}

.titlebar-sync-pop-x:hover {
  color: var(--text-primary, #18181b);
}

@keyframes sync-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
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
