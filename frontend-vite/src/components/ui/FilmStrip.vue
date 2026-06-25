<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch } from 'vue'

defineOptions({ name: 'FilmStrip' })

export interface FilmStripItem {
  id: number
  question_no: string | null
  is_favorite: boolean
  section?: string | null
  sections?: string[]
  preview_url?: string
}

const props = withDefaults(defineProps<{
  items: FilmStripItem[]
  activeId?: number | null
  multiSelect?: boolean
  selectedIds?: Set<number>
  sectionColorMap?: Record<string, string>
}>(), {
  activeId: null,
  multiSelect: false,
  selectedIds: () => new Set(),
  sectionColorMap: () => ({}),
})

const emit = defineEmits<{
  select: [id: number]
  'toggle-selection': [id: number]
}>()

const scrollRef = ref<HTMLElement | null>(null)

// Tooltip state
const tipText = ref('')
const tipX = ref(0)
const tipY = ref(0)
const tipVisible = ref(false)

function getItemColor(item: FilmStripItem): string | null {
  const map = props.sectionColorMap
  if (!map) return null
  const sections = item.sections?.length ? item.sections : (item.section ? [item.section] : [])
  for (const s of sections) {
    if (map[s]) return map[s]
  }
  return null
}

function getItemSectionLabel(item: FilmStripItem): string {
  if (item.sections?.length) return item.sections.join(', ')
  if (item.section) return item.section
  return ''
}

function onItemMouseEnter(e: MouseEvent, item: FilmStripItem) {
  const label = getItemSectionLabel(item)
  if (!label) return
  tipText.value = label
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  tipX.value = rect.left + rect.width / 2
  tipY.value = rect.top - 6
  tipVisible.value = true
}

function onItemMouseLeave() {
  tipVisible.value = false
}

function scrollToActive() {
  if (!scrollRef.value || props.activeId == null) return
  const el = scrollRef.value.querySelector(`[data-fs-id="${props.activeId}"]`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }
}

function onItemClick(item: FilmStripItem) {
  if (props.multiSelect) {
    emit('toggle-selection', item.id)
  } else {
    emit('select', item.id)
  }
}

function onKeyDown(e: KeyboardEvent) {
  // Don't intercept if typing in input
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return

  if (!props.items.length || props.activeId == null) return
  const idx = props.items.findIndex(i => i.id === props.activeId)
  if (idx < 0) return

  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    const prev = Math.max(0, idx - 1)
    emit('select', props.items[prev].id)
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    const next = Math.min(props.items.length - 1, idx + 1)
    emit('select', props.items[next].id)
  } else if (e.key === 'Enter' && props.multiSelect) {
    e.preventDefault()
    emit('toggle-selection', props.activeId)
  }
}

let _keyListenerAttached = false
function attachKeyListener() {
  if (!_keyListenerAttached) {
    document.addEventListener('keydown', onKeyDown)
    _keyListenerAttached = true
  }
}
function detachKeyListener() {
  if (_keyListenerAttached) {
    document.removeEventListener('keydown', onKeyDown)
    _keyListenerAttached = false
  }
}

onMounted(attachKeyListener)
onActivated(attachKeyListener)
onDeactivated(detachKeyListener)
onBeforeUnmount(detachKeyListener)

// Watch activeId changes to scroll
watch(() => props.activeId, () => {
  setTimeout(scrollToActive, 50)
})
</script>

<template>
  <div class="fs">
    <div class="fs-scroll" ref="scrollRef">
      <div
        v-for="item in items"
        :key="item.id"
        class="fs-item"
        :class="{
          'fs-item--active': item.id === activeId,
          'fs-item--fav': item.is_favorite,
          'fs-item--selected': multiSelect && selectedIds.has(item.id),
        }"
        :data-fs-id="item.id"
        @click="onItemClick(item)"
        @mouseenter="onItemMouseEnter($event, item)"
        @mouseleave="onItemMouseLeave"
      >
        <div v-if="multiSelect" class="fs-item-check">
          <svg v-if="selectedIds.has(item.id)" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <div class="fs-item-no">{{ item.question_no || '?' }}</div>
        <span v-if="getItemColor(item)" class="fs-item-dot" :style="{ background: getItemColor(item) }"></span>
        <button
          v-if="item.is_favorite"
          class="fs-item-fav"
          @click.stop
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
        </button>
      </div>
    </div>
    <!-- Fixed tooltip -->
    <Teleport to="body">
      <div
        v-if="tipVisible && tipText"
        class="fs-tooltip"
        :style="{ left: tipX + 'px', top: tipY + 'px' }"
      >{{ tipText }}</div>
    </Teleport>
  </div>
</template>

<style scoped>
.fs {
  display: flex;
  align-items: center;
  padding: 0;
  overflow: hidden;
}

.fs-scroll {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 8px 12px;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--text-tertiary) 30%, transparent) transparent;
  flex: 1;
}

.fs-scroll::-webkit-scrollbar {
  height: 4px;
}

.fs-scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--text-tertiary) 30%, transparent);
  border-radius: 2px;
}

.fs-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: all 100ms ease;
  white-space: nowrap;
  flex-shrink: 0;
  position: relative;
  min-width: 48px;
  justify-content: center;
}

.fs-item:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}

.fs-tooltip {
  position: fixed;
  transform: translate(-50%, -100%);
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-primary);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 6px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 10000;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
}

.fs-item--active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--text-accent);
}

.fs-item--active .fs-item-no {
  color: var(--text-accent);
  font-weight: 600;
}

.fs-item--selected {
  background: var(--bg-pressed);
  border-color: var(--text-secondary);
}

.fs-item--selected .fs-item-no {
  font-weight: 600;
}

.fs-item--selected.fs-item--active {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.fs-item-no {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.fs-item-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.fs-item-tag {
  font-size: 10px;
  color: var(--text-tertiary);
  max-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fs-item-check {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--border-strong);
  border-radius: 3px;
  flex-shrink: 0;
  background: transparent;
  transition: all 100ms ease;
}

.fs-item--selected .fs-item-check {
  border-color: var(--text-primary);
  background: transparent;
  color: var(--text-primary);
}

.fs-item-fav {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: none;
  color: var(--danger);
  cursor: default;
}
</style>
