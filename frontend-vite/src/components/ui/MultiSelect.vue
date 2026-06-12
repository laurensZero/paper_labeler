<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'

defineOptions({ name: 'MultiSelect' })

export interface MultiSelectOption {
  value: any
  label: string
}

const props = withDefaults(defineProps<{
  modelValue: any[]
  options: MultiSelectOption[]
  placeholder?: string
  disabled?: boolean
  displayMode?: 'count' | 'values'
  shortLabelMap?: Record<string, string>
  valueSeparator?: string
  showAllWhenAllSelected?: boolean
}>(), {
  placeholder: '',
  disabled: false,
  displayMode: 'count',
  shortLabelMap: () => ({}),
  valueSeparator: ' / ',
  showAllWhenAllSelected: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: any[]]
}>()

const isOpen = ref(false)
const searchQuery = ref('')
const highlightedIndex = ref(-1)
const rootEl = ref<HTMLElement | null>(null)
const searchInputEl = ref<HTMLInputElement | null>(null)

const filteredOptions = computed(() => {
  const q = searchQuery.value.toLowerCase().trim()
  if (!q) return props.options
  return props.options.filter(o => o.label.toLowerCase().includes(q))
})

const selectedSet = computed(() => new Set(props.modelValue))

const displayLabel = computed(() => {
  const total = props.options.length
  const selectedOptions = props.options.filter(o => selectedSet.value.has(o.value))
  if (props.modelValue.length === 0) return props.placeholder ?? ''
  if (props.showAllWhenAllSelected && total > 0 && selectedOptions.length >= total) return props.placeholder ?? ''
  if (props.displayMode === 'values') {
    return selectedOptions
      .map(o => props.shortLabelMap[String(o.value)] || o.label || String(o.value))
      .join(props.valueSeparator)
  }
  if (props.modelValue.length === 1) {
    const opt = props.options.find(o => o.value === props.modelValue[0])
    return opt?.label ?? String(props.modelValue[0])
  }
  return `已选 ${props.modelValue.length} 项`
})

const allFilteredSelected = computed(() => {
  if (filteredOptions.value.length === 0) return false
  return filteredOptions.value.every(o => selectedSet.value.has(o.value))
})

function open() {
  if (props.disabled) return
  isOpen.value = true
  searchQuery.value = ''
  highlightedIndex.value = 0
  nextTick(() => searchInputEl.value?.focus())
}

function close() {
  isOpen.value = false
  searchQuery.value = ''
  highlightedIndex.value = -1
}

function toggle() {
  isOpen.value ? close() : open()
}

function toggleOption(option: MultiSelectOption) {
  const set = new Set(props.modelValue)
  if (set.has(option.value)) {
    set.delete(option.value)
  } else {
    set.add(option.value)
  }
  emit('update:modelValue', Array.from(set))
}

function selectAll() {
  const allValues = filteredOptions.value.map(o => o.value)
  emit('update:modelValue', [...new Set([...props.modelValue, ...allValues])])
}

function clearAll() {
  emit('update:modelValue', [])
}

function onClickOutside(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) {
    close()
  }
}

function onKeydown(e: KeyboardEvent) {
  if (props.disabled) return
  if (!isOpen.value) {
    if (['Enter', ' ', 'ArrowDown'].includes(e.key)) {
      e.preventDefault()
      open()
    }
    return
  }

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      highlightedIndex.value = Math.min(highlightedIndex.value + 1, filteredOptions.value.length - 1)
      break
    case 'ArrowUp':
      e.preventDefault()
      highlightedIndex.value = Math.max(highlightedIndex.value - 1, 0)
      break
    case 'Enter':
      e.preventDefault()
      if (highlightedIndex.value >= 0 && highlightedIndex.value < filteredOptions.value.length) {
        toggleOption(filteredOptions.value[highlightedIndex.value])
      }
      break
    case 'Escape':
      e.preventDefault()
      close()
      break
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onClickOutside)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutside)
})

watch(() => filteredOptions.value.length, (len) => {
  if (highlightedIndex.value >= len) {
    highlightedIndex.value = Math.max(0, len - 1)
  }
})
</script>

<template>
  <div
    ref="rootEl"
    class="ms"
    :class="{ 'ms--open': isOpen, 'ms--disabled': disabled }"
    tabindex="0"
    role="combobox"
    :aria-expanded="isOpen"
    aria-haspopup="listbox"
    @keydown="onKeydown"
  >
    <button
      class="ms-trigger"
      type="button"
      :disabled="disabled"
      @click="toggle"
    >
      <span class="ms-value" :class="{ 'ms-placeholder': modelValue.length === 0 }">
        {{ displayLabel }}
      </span>
      <span v-if="modelValue.length > 0" class="ms-count">{{ modelValue.length }}</span>
      <span class="ms-chevron" :class="{ 'ms-chevron--open': isOpen }">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
    </button>

    <Transition name="ms-dropdown">
      <div v-if="isOpen" class="ms-dropdown" role="listbox" aria-multiselectable="true">
        <!-- Search -->
        <div class="ms-search">
          <svg class="ms-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref="searchInputEl"
            v-model="searchQuery"
            class="ms-search-input"
            type="text"
            placeholder="搜索..."
            @keydown.stop
          />
        </div>

        <!-- Actions -->
        <div class="ms-actions">
          <button class="ms-action-btn" type="button" @mousedown.prevent @click="selectAll">
            {{ allFilteredSelected ? '已全选' : '全选' }}
          </button>
          <button class="ms-action-btn" type="button" @mousedown.prevent @click="clearAll">
            清除
          </button>
        </div>

        <!-- Options -->
        <div class="ms-options">
          <div
            v-for="(option, i) in filteredOptions"
            :key="option.value"
            class="ms-option"
            :class="{
              'ms-option-highlighted': i === highlightedIndex,
              'ms-option-selected': selectedSet.has(option.value),
            }"
            role="option"
            :aria-selected="selectedSet.has(option.value)"
            @mouseenter="highlightedIndex = i"
            @mousedown.prevent="toggleOption(option)"
          >
            <span class="ms-checkbox" :class="{ 'ms-checkbox--checked': selectedSet.has(option.value) }">
              <svg v-if="selectedSet.has(option.value)" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <span class="ms-option-label">{{ option.label }}</span>
          </div>
          <div v-if="filteredOptions.length === 0" class="ms-empty">
            无匹配项
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.ms {
  position: relative;
  display: inline-flex;
  width: 100%;
  outline: none;
}

.ms-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 38px;
  padding: 8px 16px;
  background: var(--bg-elevated);
  border: 0.5px solid var(--border);
  border-radius: 999px;
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
  outline: none;
  gap: 8px;
}

.ms-trigger:hover {
  border-color: var(--border-strong);
  background: var(--bg-card-hover);
}

.ms:focus .ms-trigger,
.ms--open .ms-trigger {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.ms--disabled .ms-trigger {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

.ms-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  text-align: left;
}

.ms-placeholder {
  color: var(--text-tertiary);
}

.ms-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  background: var(--accent-soft);
  color: var(--text-accent);
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
  flex-shrink: 0;
}

.ms-chevron {
  display: flex;
  align-items: center;
  color: var(--text-tertiary);
  transition: transform var(--duration-fast) var(--ease-out);
  flex-shrink: 0;
}

.ms-chevron--open {
  transform: rotate(180deg);
}

/* Dropdown */
.ms-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 1000;
  min-width: 220px;
  background: var(--bg-elevated);
  backdrop-filter: blur(22px) saturate(180%);
  -webkit-backdrop-filter: blur(22px) saturate(180%);
  border: 0.5px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.ms-search {
  position: relative;
  padding: 8px;
  border-bottom: 0.5px solid var(--border);
  background: var(--bg-elevated);
}

.ms-search-icon {
  position: absolute;
  left: 16px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-tertiary);
  pointer-events: none;
}

.ms-search-input {
  width: 100%;
  height: 30px;
  padding: 6px 10px 6px 32px;
  background: var(--bg-input);
  border: 0.5px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-primary);
  font-family: inherit;
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out);
}

.ms-search-input::placeholder {
  color: var(--text-tertiary);
}

.ms-search-input:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.ms-actions {
  display: flex;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.ms-action-btn {
  padding: 5px 9px;
  background: none;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-accent);
  cursor: pointer;
  font-family: inherit;
  transition: background var(--duration-fast) var(--ease-out);
}

.ms-action-btn:hover {
  background: var(--accent-soft);
}

.ms-options {
  max-height: 240px;
  overflow-y: auto;
  padding: 6px;
}

.ms-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}

.ms-option-highlighted {
  background: var(--bg-hover);
}

.ms-option-selected {
  color: var(--text-accent);
  background: var(--accent-soft);
}

.ms-checkbox {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1.5px solid var(--border-strong);
  border-radius: 4px;
  flex-shrink: 0;
  transition: all var(--duration-fast) var(--ease-out);
  background: transparent;
}

.ms-checkbox--checked {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}

.ms-option-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ms-empty {
  padding: 16px;
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary);
}

/* Transition */
.ms-dropdown-enter-active {
  transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-spring);
}

.ms-dropdown-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.ms-dropdown-enter-from {
  opacity: 0;
  transform: translateY(-6px) scale(0.97);
}

.ms-dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
</style>
