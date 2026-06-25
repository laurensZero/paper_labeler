<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAppStore } from '@/stores/app'

const visible = ref(false)
const route = useRoute()
const appStore = useAppStore()

interface Shortcut {
  keys: string[]
  label: string
}

interface ShortcutGroup {
  title: string
  items: Shortcut[]
}

const globalShortcuts: ShortcutGroup = {
  title: '通用',
  items: [
    { keys: ['?'], label: '显示 / 隐藏快捷键帮助' },
    { keys: ['Esc'], label: '关闭弹窗 / 退出全屏' },
  ],
}

const filterShortcuts: ShortcutGroup[] = [
  {
    title: '导航',
    items: [
      { keys: ['j'], label: '下一题' },
      { keys: ['k'], label: '上一题' },
      { keys: ['↓'], label: '下一题' },
      { keys: ['↑'], label: '上一题' },
      { keys: ['←', '→'], label: '在 FilmStrip 中切换题目' },
    ],
  },
  {
    title: '操作',
    items: [
      { keys: ['f'], label: '收藏 / 取消收藏' },
      { keys: ['e'], label: '编辑当前题目' },
      { keys: ['d'], label: '删除当前题目' },
      { keys: ['a'], label: '展开 / 隐藏答案' },
    ],
  },
  {
    title: '搜索',
    items: [
      { keys: ['/'], label: '聚焦搜索框' },
    ],
  },
]

const markShortcuts: ShortcutGroup[] = [
  {
    title: '翻页',
    items: [
      { keys: ['j'], label: '上一页' },
      { keys: ['k'], label: '下一页' },
      { keys: ['←'], label: '上一页 / 上一个 OCR 草稿' },
      { keys: ['→'], label: '下一页 / 下一个 OCR 草稿' },
    ],
  },
  {
    title: '编辑',
    items: [
      { keys: ['Ctrl', 'Z'], label: '撤销' },
      { keys: ['Ctrl', 'Y'], label: '重做' },
      { keys: ['Del'], label: '删除选中框' },
    ],
  },
  {
    title: '模块快捷键',
    items: [
      { keys: ['1-9'], label: '快速切换模块（按排列顺序）' },
    ],
  },
]

const currentGroups = computed<ShortcutGroup[]>(() => {
  const name = String(route.name || '')
  let groups: ShortcutGroup[]
  if (name === 'filter') {
    groups = filterShortcuts
  } else if (name === 'mark') {
    groups = markShortcuts
  } else {
    groups = []
  }
  return [globalShortcuts, ...groups]
})

function toggle() {
  visible.value = !visible.value
}

// Watch for external triggers (button clicks)
watch(() => appStore.keyboardHelpTrigger, () => {
  toggle()
})

function onKeyDown(e: KeyboardEvent) {
  const target = e.target as HTMLElement
  const tag = target?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return

  if (e.key === '?') {
    e.preventDefault()
    toggle()
    return
  }
  if (e.key === 'Escape' && visible.value) {
    e.preventDefault()
    visible.value = false
  }
}

onMounted(() => document.addEventListener('keydown', onKeyDown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeyDown))
</script>

<template>
  <Teleport to="body">
    <Transition name="kh-fade">
      <div v-if="visible" class="kh-backdrop" @click.self="visible = false">
        <div class="kh-panel">
          <div class="kh-header">
            <span class="kh-title">键盘快捷键</span>
            <button class="kh-close" @click="visible = false">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="kh-body">
            <div v-for="group in currentGroups" :key="group.title" class="kh-group">
              <div class="kh-group-title">{{ group.title }}</div>
              <div
                v-for="item in group.items"
                :key="item.label"
                class="kh-row"
              >
                <div class="kh-keys">
                  <kbd v-for="k in item.keys" :key="k" class="kh-kbd">{{ k }}</kbd>
                </div>
                <span class="kh-label">{{ item.label }}</span>
              </div>
            </div>
          </div>
          <div class="kh-footer">按 <kbd class="kh-kbd kh-kbd--sm">?</kbd> 关闭</div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.kh-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
}

.kh-panel {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
  width: 420px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.kh-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--border);
}

.kh-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.kh-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  border-radius: 6px;
  cursor: pointer;
  transition: all 100ms ease;
}

.kh-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.kh-body {
  padding: 12px 20px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.kh-group-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
  margin-bottom: 6px;
}

.kh-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
}

.kh-keys {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.kh-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  padding: 2px 7px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 5px;
  box-shadow: 0 1px 0 var(--border);
  line-height: 1.4;
}

.kh-kbd--sm {
  min-width: 20px;
  padding: 1px 5px;
  font-size: 11px;
}

.kh-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-left: 12px;
  text-align: right;
}

.kh-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 20px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-tertiary);
}

/* Transitions */
.kh-fade-enter-active,
.kh-fade-leave-active {
  transition: opacity 0.15s ease;
}
.kh-fade-enter-from,
.kh-fade-leave-to {
  opacity: 0;
}
.kh-fade-enter-active .kh-panel {
  animation: kh-scale-in 0.15s ease;
}
@keyframes kh-scale-in {
  from { transform: scale(0.95); opacity: 0; }
  to   { transform: scale(1);   opacity: 1; }
}
</style>
