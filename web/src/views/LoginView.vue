<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { signIn } from '@/composables/auth'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const email = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

async function onSubmit() {
  if (!email.value || !password.value) {
    error.value = t('login.errRequired')
    return
  }
  loading.value = true
  error.value = ''
  const err = await signIn(email.value.trim(), password.value)
  loading.value = false
  if (err) {
    error.value = err === 'Invalid login credentials' ? t('login.errInvalid') : err
    return
  }
  const redirect = (route.query.redirect as string) || '/bank'
  router.push(redirect)
}
</script>

<template>
  <div class="login-wrap">
    <form class="card login-card" @submit.prevent="onSubmit">
      <h1>Paper Labeler</h1>
      <div class="sub">{{ t('login.tagline') }}</div>

      <div class="field">
        <label class="label" for="email">{{ t('login.email') }}</label>
        <input id="email" v-model="email" class="input" type="email" autocomplete="username" :placeholder="t('login.emailPh')" />
      </div>
      <div class="field">
        <label class="label" for="password">{{ t('login.password') }}</label>
        <input id="password" v-model="password" class="input" type="password" autocomplete="current-password" :placeholder="t('login.passwordPh')" />
      </div>

      <p v-if="error" class="error-text">{{ error }}</p>

      <button class="btn btn-primary" style="width: 100%; height: 38px; margin-top: 6px" type="submit" :disabled="loading">
        {{ loading ? t('login.signingIn') : t('login.submit') }}
      </button>

      <p class="muted" style="font-size: 12px; margin-top: 16px; margin-bottom: 0">
        {{ t('login.hint') }}
      </p>
    </form>
  </div>
</template>
