import { createRouter, createWebHistory } from 'vue-router'
import { initAuth, useAuth } from '@/composables/auth'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue') },
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
  if (!auth.session && to.name !== 'login') {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (auth.session && to.name === 'login') {
    return { name: 'bank' }
  }
  return true
})
