import type { Directive, App } from 'vue'

let tipEl: HTMLDivElement | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

function ensureEl(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement('div')
    tipEl.className = 'v-tooltip'
    document.body.appendChild(tipEl)
  }
  return tipEl
}

function show(text: string, rect: DOMRect) {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
  const el = ensureEl()
  el.textContent = text
  el.style.left = rect.left + rect.width / 2 + 'px'
  el.style.top = rect.top + 'px'
  el.classList.add('v-tooltip--visible')
}

function hide() {
  hideTimer = setTimeout(() => {
    tipEl?.classList.remove('v-tooltip--visible')
  }, 50)
}

const vTooltip: Directive = {
  mounted(el, binding) {
    const text = binding.value
    if (!text) return
    el.__tipText = text
    el.__tipEnter = () => show(el.__tipText, el.getBoundingClientRect())
    el.__tipLeave = () => hide()
    el.addEventListener('mouseenter', el.__tipEnter)
    el.addEventListener('mouseleave', el.__tipLeave)
  },
  updated(el, binding) {
    el.__tipText = binding.value || ''
    if (!el.__tipText) {
      el.removeEventListener('mouseenter', el.__tipEnter)
      el.removeEventListener('mouseleave', el.__tipLeave)
    }
  },
  unmounted(el) {
    el.removeEventListener('mouseenter', el.__tipEnter)
    el.removeEventListener('mouseleave', el.__tipLeave)
  },
}

export function installTooltip(app: App) {
  app.directive('tooltip', vTooltip)
}
