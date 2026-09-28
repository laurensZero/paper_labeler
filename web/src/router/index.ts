import { createRouter, createWebHistory } from 'vue-router'
import { initAuth, useAuth } from '@/composables/auth'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue') },
    { path: '/set-password', name: 'set-password', component: () => import('@/views/SetPasswordView.vue') },
    { path: '/', redirect: '/bank' },
    { path: '/bank', name: 'bank', component: () => import('@/views/BankView.vue') },
    { path: '/compose', name: 'compose-new', component: () => import('@/views/CompositionView.vue') },
    { path: '/compose/:id', name: 'compose', component: () => import('@/views/CompositionView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/bank' },
  ],
})

router.beforeEach(async (to) => {
  await initAuth()
  const auth = useAuth()

  // 邮件链接类型（invite/recovery/signup）：main.ts 在 hash 被 supabase-js
  // 消费前抢存到 sessionStorage，这里读取即清除、按类型分流（Site URL 零配置方案）
  let pendingType = ''
  try {
    pendingType = sessionStorage.getItem('pl_auth_type') || ''
    sessionStorage.removeItem('pl_auth_type')
  } catch {
    /* ignore */
  }

  if (pendingType && !auth.session && to.name !== 'login') {
    // 链接过期/无效：session 没建立 → 登录页给出提示
    return { name: 'login', query: { auth_error: '1' } }
  }
  if (
    pendingType &&
    auth.session &&
    (pendingType === 'invite' || pendingType === 'recovery') &&
    to.name !== 'set-password'
  ) {
    return { name: 'set-password' }
  }

  if (!auth.session && to.name !== 'login') {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (auth.session && to.name === 'login') {
    return { name: 'bank' }
  }
  return true
})
