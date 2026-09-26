import { createI18n } from 'vue-i18n'
import zhCN from './zh-CN.json'
import en from './en.json'

const saved = localStorage.getItem('web:locale')

export const i18n = createI18n({
  legacy: false,
  locale: saved === 'en' ? 'en' : 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN, en },
})

export function setLocale(locale: 'zh-CN' | 'en') {
  ;(i18n.global.locale as { value: string }).value = locale
  localStorage.setItem('web:locale', locale)
  document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN'
}
