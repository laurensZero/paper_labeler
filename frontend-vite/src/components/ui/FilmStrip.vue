<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'

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
}>(), {
  activeId: null,
})

const emit = defineEmits<{
  select: [id: number]
}>()

const scrollRef = ref<HTMLElement | null>(null)

function getSectionLabel(item: FilmStripItem): string {
  if (item.sections?.length) return item.sections[0]
  if (item.section) return item.section
  return ''
}

function scrollToActive() {
  if (!scrollRef.value || props.activeId == null) return
  const el = scrollRef.value.querySelector(`[data-fs-id="${props.activeId}"]`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }
}

// Auto-scroll when active changes
const lastActiveId = ref(props.activeId)
const observer = ref<MutationObserver | null>(null)

function onKeyDown(e: KeyboardEvent) {
  if (!props.items.length || props.activeId == null) return
  const idx = props.items.findIndex(i => i.id === props.activeId)
  if (idx < 0) return

  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault()
    const prev = Math.max(0, idx - 1)
    emit('select', props.items[prev].id)
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault()
    const next = Math.min(props.items.length - 1, idx + 1)
    emit('select', props.items[next].id)
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeyDown)
})

// Watch activeId changes to scroll
import { watch } from 'vue'
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
        :class="{ 'fs-item--active': item.id === activeId, 'fs-item--fav': item.is_favorite }"
        :data-fs-id="item.id"
        @click="emit('select', item.id)"
      >
        <div class="fs-item-no">{{ item.question_no || '?' }}</div>
        <div v-if="getSectionLabel(item)" class="fs-item-tag">{{ getSectionLabel(item) }}</div>
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

.fs-item--active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--text-accent);
}

.fs-item--active .fs-item-no {
  color: var(--text-accent);
  font-weight: 600;
}

.fs-item-no {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.fs-item-tag {
  font-size: 10px;
  color: var(--text-tertiary);
  max-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
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
