import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from './i18n'
import router from './router'
import { installTooltip } from './directives/tooltip'
import App from './App.vue'
import './styles/app.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(i18n)
installTooltip(app)
app.mount('#app')
