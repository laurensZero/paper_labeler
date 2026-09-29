<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { signOut, useAuth } from '@/composables/auth'
import { setLocale } from '@/i18n'
import BrowseWatermark from '@/components/BrowseWatermark.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const { t, locale } = useI18n()

const isAdmin = computed(() => auth.profile?.role === 'admin')
const inCompose = computed(() => route.path.startsWith('/compose'))

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
  </div>
</template>
