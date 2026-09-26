<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { signOut, useAuth } from '@/composables/auth'
import { setLocale } from '@/i18n'

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
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <img class="brand-mark" src="/logo.svg" alt="Paper Labeler" />
        <span class="brand-name">Paper Labeler</span>
      </div>
      <nav class="nav">
        <RouterLink to="/bank" class="nav-link" :class="{ active: route.path.startsWith('/bank') }">
          {{ t('app.nav.bank') }}
        </RouterLink>
        <RouterLink to="/compose" class="nav-link" :class="{ active: inCompose }">
          {{ t('app.nav.compose') }}
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
