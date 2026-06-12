import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory('/ui/'),
  routes: [
    { path: '/', redirect: '/filter' },
    { path: '/filter', name: 'filter', component: () => import('@/views/FilterView.vue') },
    { path: '/mark/:paperId?', name: 'mark', component: () => import('@/views/MarkView.vue') },
    { path: '/answer/:paperId?', name: 'answer', component: () => import('@/views/AnswerView.vue') },
    { path: '/answer-admin', name: 'answer-admin', component: () => import('@/views/AnswerAdmin.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
    { path: '/sections', name: 'sections', component: () => import('@/views/SectionEditor.vue') },
  ],
})

export default router
