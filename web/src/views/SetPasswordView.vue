<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { getSupabase } from '@/lib/supabase'
import { useAuth } from '@/composables/auth'

// 邀请/重置密码链接验证成功后的设置密码页（需已持 session）
const { t } = useI18n()
const router = useRouter()

const password = ref('')
const confirm = ref('')
const error = ref('')
const success = ref(false)
const loading = ref(false)

async function onSubmit() {
  error.value = ''
  if (password.value.length < 8) {
    error.value = t('setPassword.tooShort')
    return
  }
  if (password.value !== confirm.value) {
    error.value = t('setPassword.mismatch')
    return
  }
  if (!useAuth().session) {
    router.replace({ name: 'login' })
    return
  }
  loading.value = true
  const { error: err } = await getSupabase().auth.updateUser({ password: password.value })
  loading.value = false
  if (err) {
    error.value =
      err.message.includes('weak_password') || err.message.includes('should be longer')
        ? t('setPassword.weak')
        : `${t('setPassword.errPrefix')}: ${err.message}`
    return
  }
  success.value = true
  setTimeout(() => router.replace({ name: 'bank' }), 800)
}
</script>

<template>
  <div class="login-wrap">
    <form class="card login-card" @submit.prevent="onSubmit">
      <h1>{{ t('setPassword.title') }}</h1>
      <div class="sub">{{ t('setPassword.sub') }}</div>

      <div class="field">
        <label class="label" for="pw">{{ t('setPassword.new') }}</label>
        <input id="pw" v-model="password" class="input" type="password" autocomplete="new-password" />
      </div>
      <div class="field">
        <label class="label" for="pw2">{{ t('setPassword.confirm') }}</label>
        <input id="pw2" v-model="confirm" class="input" type="password" autocomplete="new-password" />
      </div>

      <p v-if="error" class="error-text">{{ error }}</p>
      <p v-if="success" class="sub" style="color: var(--accent)">{{ t('setPassword.success') }}</p>

      <button class="btn btn-primary" style="width: 100%; height: 38px; margin-top: 6px" type="submit" :disabled="loading || success">
        {{ loading ? t('setPassword.setting') : t('setPassword.submit') }}
      </button>
    </form>
  </div>
</template>
