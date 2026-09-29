<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { signOut, useAuth } from '@/composables/auth'
import { setLocale } from '@/i18n'
import { getSupabase } from '@/lib/supabase'
import BrowseWatermark from '@/components/BrowseWatermark.vue'
import AppDialog from '@/components/AppDialog.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const { t, locale } = useI18n()

const isAdmin = computed(() => auth.profile?.role === 'admin')
const inCompose = computed(() => route.path.startsWith('/compose'))
const bankUpdatedAt = ref<string | null>(null)

function fmtBankTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(locale.value === 'en' ? 'en-GB' : 'zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** 题库内容最后更新时间：取 questions / papers 的较新时间戳 */
async function loadBankUpdatedAt() {
  if (!auth.session) {
    bankUpdatedAt.value = null
    return
  }
  try {
    const sb = getSupabase()
    const [byUpdated, bySource, byPaper] = await Promise.all([
      sb.from('questions').select('updated_at').order('updated_at', { ascending: false }).limit(1),
      sb.from('questions').select('source_updated_at').order('source_updated_at', { ascending: false }).limit(1),
      sb.from('papers').select('source_updated_at').order('source_updated_at', { ascending: false }).limit(1),
    ])
    const candidates = [
      byUpdated.data?.[0]?.updated_at,
      bySource.data?.[0]?.source_updated_at,
      byPaper.data?.[0]?.source_updated_at,
    ].filter((v): v is string => typeof v === 'string' && !!v)
    bankUpdatedAt.value = candidates.sort().at(-1) ?? null
  } catch {
    bankUpdatedAt.value = null
  }
}

watch(
  () => auth.session?.user.id,
  () => {
    void loadBankUpdatedAt()
  },
  { immediate: true },
)

function onLocaleChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  setLocale(v === 'en' ? 'en' : 'zh-CN')
}

async function onSignOut() {
  await signOut()
  router.push({ name: 'login' })
}

// ---- 题库防盗：.protected 内容区禁右键/拖拽/复制（仅拦截内容区，输入框不受影响）----
function inProtected(e: Event): boolean {
  const el = e.target as HTMLElement | null
  return !!(el && typeof el.closest === 'function' && el.closest('.protected'))
}
function onGuardContextMenu(e: MouseEvent) {
  if (inProtected(e)) e.preventDefault()
}
function onGuardDragStart(e: DragEvent) {
  if (inProtected(e)) e.preventDefault()
}
function onGuardCopy(e: ClipboardEvent) {
  if (inProtected(e)) e.preventDefault()
}
onMounted(() => {
  window.addEventListener('contextmenu', onGuardContextMenu, true)
  window.addEventListener('dragstart', onGuardDragStart, true)
  window.addEventListener('copy', onGuardCopy, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('contextmenu', onGuardContextMenu, true)
  window.removeEventListener('dragstart', onGuardDragStart, true)
  window.removeEventListener('copy', onGuardCopy, true)
})
</script>

<template>
  <div class="app">
    <BrowseWatermark v-if="auth.session && !isAdmin" />
    <header class="topbar">
      <div class="brand">
        <img class="brand-mark" src="/logo.svg" alt="Paper Labeler" />
        <span class="brand-name">Paper Labeler</span>
      </div>
      <nav class="nav">
        <RouterLink to="/bank" class="nav-link" :class="{ active: route.path.startsWith('/bank') }">
          {{ t('app.nav.bank') }}
        </RouterLink>
        <RouterLink to="/radar" class="nav-link" :class="{ active: route.path.startsWith('/radar') }">
          {{ t('app.nav.radar') }}
        </RouterLink>
        <RouterLink to="/compose" class="nav-link" :class="{ active: inCompose }">
          {{ t('app.nav.compose') }}
        </RouterLink>
        <RouterLink to="/download" class="nav-link" :class="{ active: route.path.startsWith('/download') }">
          {{ t('app.nav.download') }}
        </RouterLink>
        <span
          v-if="auth.session"
          class="nav-updated"
          :title="t('bank.updatedAt', { time: bankUpdatedAt ? fmtBankTime(bankUpdatedAt) : '—' })"
        >{{ t('bank.updatedAt', { time: bankUpdatedAt ? fmtBankTime(bankUpdatedAt) : '—' }) }}</span>
      </nav>
      <div class="user">
        <select
          class="lang-select"
          :value="locale"
          :aria-label="t('app.langLabel')"
          @change="onLocaleChange"
        >
          <option value="zh-CN">中文</option>
          <option value="en">English</option>
        </select>
        <span class="user-email" :title="auth.profile?.email || ''">
          {{ auth.profile?.email }}<template v-if="isAdmin"> · admin</template>
        </span>
        <button class="btn btn-ghost btn-sm" @click="onSignOut">{{ t('app.signOut') }}</button>
      </div>
    </header>
    <main class="main">
      <RouterView />
    </main>
    <AppDialog />
  </div>
</template>
