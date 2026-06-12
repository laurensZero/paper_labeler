<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'

defineOptions({ name: 'SectionTagEditor' })

export interface TagOption {
  value: string
  label: string
}

export interface TagOptionGroup {
  label: string
  options: TagOption[]
}

const props = withDefaults(defineProps<{
  modelValue: string[]
  options?: TagOption[]
  optionGroups?: TagOptionGroup[]
  placeholder?: string
  disabled?: boolean
}>(), {
  options: () => [],
  optionGroups: () => [],
  placeholder: '添加标签...',
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const isOpen = ref(false)
const searchQuery = ref('')
const highlightedIndex = ref(-1)
const rootEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)

// Flatten all options from both sources
const allOptions = computed(() => {
  const map = new Map<string, string>()
  for (const o of props.options) {
    map.set(o.value, o.label)
  }
  for (const g of props.optionGroups) {
    for (const o of g.options) {
      map.set(o.value, o.label)
    }
  }
  return Array.from(map.entries()).map(([value, label]) => ({ value, label }))
})

// Build a flat list of visible options for keyboard navigation
interface FlatItem {
  type: 'group' | 'option'
  value?: string
  label: string
  groupLabel?: string
}

const flatList = computed<FlatItem[]>(() => {
  const selected = new Set(props.modelValue)
  const q = searchQuery.value.toLowerCase().trim()

  // If no groups, use flat options
  if (props.optionGroups.length === 0) {
    return props.options
      .filter(o => {
        if (selected.has(o.value)) return false
        if (q && !o.label.toLowerCase().includes(q)) return false
        return true
      })
      .map(o => ({ type: 'option' as const, value: o.value, label: o.label }))
  }

  // Grouped mode
  const items: FlatItem[] = []
  for (const g of props.optionGroups) {
    const filtered = g.options.filter(o => {
      if (selected.has(o.value)) return false
      if (q && !o.label.toLowerCase().includes(q)) return false
      return true
    })
    if (filtered.length > 0) {
      items.push({ type: 'group', label: g.label })
      for (const o of filtered) {
        items.push({ type: 'option', value: o.value, label: o.label, groupLabel: g.label })
      }
    }
  }
  return items
})

// Only option items (for keyboard navigation)
const optionItems = computed(() => flatList.value.filter(i => i.type === 'option'))

function getLabel(value: string): string {
  const opt = allOptions.value.find(o => o.value === value)
  return opt?.label ?? value
}

function addTag(value: string) {
  if (props.modelValue.includes(value)) return
  emit('update:modelValue', [...props.modelValue, value])
  searchQuery.value = ''
  highlightedIndex.value = 0
}

function removeTag(value: string) {
  emit('update:modelValue', props.modelValue.filter(v => v !== value))
}

function removeLast() {
  if (searchQuery.value === '' && props.modelValue.length > 0) {
    removeTag(props.modelValue[props.modelValue.length - 1])
  }
}

function open() {
  if (props.disabled) return
  isOpen.value = true
  highlightedIndex.value = 0
  nextTick(() => inputEl.value?.focus())
}

function close() {
  isOpen.value = false
  searchQuery.value = ''
  highlightedIndex.value = -1
}

function onInputFocus() {
  if (!isOpen.value) {
    isOpen.value = true
    highlightedIndex.value = 0
  }
}

function scrollToHighlighted() {
  const el = rootEl.value?.querySelector('.ste-option--highlighted')
  el?.scrollIntoView({ block: 'nearest' })
}

function onInputKeydown(e: KeyboardEvent) {
  if (props.disabled) return

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      highlightedIndex.value = Math.min(highlightedIndex.value + 1, optionItems.value.length - 1)
      nextTick(scrollToHighlighted)
      break
    case 'ArrowUp':
      e.preventDefault()
      highlightedIndex.value = Math.max(highlightedIndex.value - 1, 0)
      nextTick(scrollToHighlighted)
      break
    case 'Enter':
      e.preventDefault()
      if (highlightedIndex.value >= 0 && highlightedIndex.value < optionItems.value.length) {
        const item = optionItems.value[highlightedIndex.value]
        if (item.value) addTag(item.value)
      }
      break
    case 'Escape':
      e.preventDefault()
      close()
      break
    case 'Backspace':
      removeLast()
      break
  }
}

function isOptionHighlighted(item: FlatItem): boolean {
  if (item.type !== 'option' || !item.value) return false
  const idx = optionItems.value.findIndex(o => o.value === item.value)
  return idx === highlightedIndex.value
}

function onOptionMouseEnter(item: FlatItem) {
  if (item.type !== 'option' || !item.value) return
  const idx = optionItems.value.findIndex(o => o.value === item.value)
  if (idx >= 0) highlightedIndex.value = idx
}

function onClickOutside(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) {
    close()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onClickOutside)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutside)
})

watch(() => optionItems.value.length, (len) => {
  if (highlightedIndex.value >= len) {
    highlightedIndex.value = Math.max(0, len - 1)
  }
})
</script>

<template>
  <div
    ref="rootEl"
    class="ste"
    :class="{ 'ste--open': isOpen, 'ste--disabled': disabled }"
    @click="open"
  >
    <!-- Tags -->
    <div class="ste-tags">
      <span
        v-for="tag in modelValue"
        :key="tag"
        class="ste-tag"
      >
        <span class="ste-tag-label">{{ getLabel(tag) }}</span>
        <button
          v-if="!disabled"
          class="ste-tag-remove"
          type="button"
          @mousedown.prevent.stop="removeTag(tag)"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </span>
      <input
        v-if="!disabled"
        ref="inputEl"
        v-model="searchQuery"
        class="ste-input"
        type="text"
        :placeholder="modelValue.length === 0 ? placeholder : ''"
        @focus="onInputFocus"
        @keydown="onInputKeydown"
        @mousedown.stop
      />
    </div>

    <!-- Dropdown -->
    <Transition name="ste-dropdown">
      <div v-if="isOpen && !disabled" class="ste-dropdown">
        <div class="ste-options">
          <template v-for="item in flatList" :key="item.type + (item.value || item.label)">
            <!-- Group header -->
            <div v-if="item.type === 'group'" class="ste-group-label">
              {{ item.label }}
            </div>
            <!-- Option -->
            <div
              v-else
              class="ste-option"
              :class="{ 'ste-option--highlighted': isOptionHighlighted(item) }"
              @mouseenter="onOptionMouseEnter(item)"
              @mousedown.prevent.stop="item.value && addTag(item.value)"
            >
              <span class="ste-option-label">{{ item.label }}</span>
              <span class="ste-option-add">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </span>
            </div>
          </template>
          <div v-if="optionItems.length === 0" class="ste-empty">
            {{ searchQuery ? '无匹配项' : '所有选项已添加' }}
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.ste {
  position: relative;
  display: flex;
  width: 100%;
  min-height: 38px;
  padding: 6px 12px;
  background: var(--bg-elevated);
  border: 0.5px solid var(--border);
  border-radius: 999px;
  cursor: text;
  transition: all var(--duration-fast) var(--ease-out);
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.ste:hover {
  border-color: var(--border-strong);
}

.ste--open {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.ste--disabled {
  opacity: 0.6;
  cursor: not-allowed;
  pointer-events: none;
}

.ste-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  flex: 1;
  min-width: 0;
}

.ste-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: var(--accent-soft);
  color: var(--text-accent);
  font-size: 12px;
  font-weight: 500;
  border-radius: var(--radius-xs);
  line-height: 1;
  transition: all var(--duration-fast) var(--ease-out);
}

.ste-tag:hover {
  background: var(--accent);
  color: white;
}

.ste-tag-label {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ste-tag-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  border-radius: 50%;
  opacity: 0.6;
  transition: opacity var(--duration-fast) var(--ease-out);
  flex-shrink: 0;
}

.ste-tag-remove:hover {
  opacity: 1;
}

.ste-input {
  flex: 1;
  min-width: 80px;
  padding: 2px 4px;
  background: none;
  border: none;
  outline: none;
  font-size: 13px;
  color: var(--text-primary);
  font-family: inherit;
}

.ste-input::placeholder {
  color: var(--text-tertiary);
}

/* Dropdown */
.ste-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 1000;
  max-height: 260px;
  overflow-y: auto;
  background: var(--bg-elevated);
  backdrop-filter: blur(22px) saturate(180%);
  -webkit-backdrop-filter: blur(22px) saturate(180%);
  border: 0.5px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: 6px;
}

.ste-options {
  padding: 0;
}

.ste-group-label {
  padding: 9px 10px 5px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0;
  color: var(--text-tertiary);
}

.ste-group-label ~ .ste-group-label {
  border-top: 1px solid var(--border);
  margin-top: 4px;
  padding-top: 10px;
}

.ste-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
  gap: 8px;
}

.ste-option--highlighted {
  background: var(--bg-hover);
}

.ste-option-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ste-option-add {
  display: flex;
  align-items: center;
  color: var(--text-tertiary);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}

.ste-option--highlighted .ste-option-add {
  opacity: 1;
  color: var(--accent);
}

.ste-empty {
  padding: 16px;
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary);
}

/* Transition */
.ste-dropdown-enter-active {
  transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-spring);
}

.ste-dropdown-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.ste-dropdown-enter-from {
  opacity: 0;
  transform: translateY(-6px) scale(0.97);
}

.ste-dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
</style>
