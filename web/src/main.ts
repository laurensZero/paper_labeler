import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { i18n } from './i18n'
import './styles.css'

// supabase-js（detectSessionInUrl）消费邮件链接 hash 之前，抢存链接类型：
// invite=邀请设置密码 / recovery=重置密码 / signup=注册验证。hash 之后会被清掉。
const authType = /[?&#]type=([a-z]+)/.exec(window.location.hash)?.[1]
if (authType) {
  try {
    sessionStorage.setItem('pl_auth_type', authType)
  } catch {
    /* 私隐模式等场景忽略 */
  }
}

createApp(App).use(router).use(i18n).mount('#app')
