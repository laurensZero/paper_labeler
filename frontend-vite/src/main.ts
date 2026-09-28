import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from './i18n'
import router from './router'
import { installTooltip } from './directives/tooltip'
import { installGlobalErrorLogging } from './utils/logger'
import App from './App.vue'
import './styles/app.css'

installGlobalErrorLogging()

// 自动收取管理令牌：PAPER_CLOUD_TOKEN 未配置时后端会自动生成，
// 这里启动时取回并存入 localStorage（与 cloudAuthHeaders 读取的键一致），
// 之后 /cloud/* 写请求自动附带，用户无需手动填写。
void (async () => {
  try {
    const { api } = await import('@/api/client')
    const res = (await api('/cloud/config')) as {
      form?: { PAPER_CLOUD_TOKEN?: string }
    }
    const tok = res?.form?.PAPER_CLOUD_TOKEN
    if (tok && !localStorage.getItem('setting:cloudToken')) {
      localStorage.setItem('setting:cloudToken', tok)
    }
  } catch {
    /* 后端未启动/云端未配置：忽略，打开设置页保存时仍可闭合 */
  }
})()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(i18n)
installTooltip(app)
app.mount('#app')
