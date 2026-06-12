<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, type CSSProperties } from 'vue'

defineOptions({ name: 'SimpleSelect' })

export interface SelectOption {
  value: any
  label: string
}

const props = withDefaults(defineProps<{
  modelValue: any
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
}>(), {
  placeholder: '',
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: any]
  'change': [value: any]
}>()

const isOpen = ref(false)
const highlightedIndex = ref(-1)
const rootEl = ref<HTMLElement | null>(null)
const dropdownEl = ref<HTMLElement | null>(null)
const dropdownStyle = ref<CSSProperties>({})
const dropUp = ref(false)
const searchBuffer = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null
let positionFrame: number | null = null
let isPositionListening = false

const selectedOption = computed(() =>
  props.options.find(o => o.value === props.modelValue) ?? null
)

const displayLabel = computed(() =>
  selectedOption.value?.label ?? props.placeholder ?? ''
)

function updateDropdownPosition() {
  const root = rootEl.value
  if (!root) return

  const rect = root.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const gap = 4
  const margin = 8
  const minHeight = 96
  const preferredMaxHeight = 260
  const belowSpace = viewportHeight - rect.bottom - margin
  const aboveSpace = rect.top - margin
  const shouldDropUp = belowSpace < 180 && aboveSpace > belowSpace
  const availableHeight = Math.max(minHeight, shouldDropUp ? aboveSpace - gap : belowSpace - gap)
  const maxHeight = Math.min(preferredMaxHeight, availableHeight)
  const dropdownHeight = Math.min(dropdownEl.value?.scrollHeight || maxHeight, maxHeight)
  const width = Math.max(rect.width, 120)
  const left = Math.min(
    Math.max(margin, rect.left),
    Math.max(margin, viewportWidth - margin - width),
  )
  const top = shouldDropUp
    ? Math.max(margin, rect.top - gap - dropdownHeight)
    : Math.min(viewportHeight - margin - dropdownHeight, rect.bottom + gap)

  dropUp.value = shouldDropUp
  dropdownStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`,
  }
}

function scheduleDropdownPosition() {
  if (!isOpen.value || positionFrame != null) return
  positionFrame = window.requestAnimationFrame(() => {
    positionFrame = null
    updateDropdownPosition()
  })
}

function addPositionListeners() {
  if (isPositionListening) return
  window.addEventListener('resize', scheduleDropdownPosition)
  window.addEventListener('scroll', scheduleDropdownPosition, true)
  isPositionListening = true
}

function removePositionListeners() {
  if (!isPositionListening) return
  window.removeEventListener('resize', scheduleDropdownPosition)
  window.removeEventListener('scroll', scheduleDropdownPosition, true)
  isPositionListening = false
  if (positionFrame != null) {
    window.cancelAnimationFrame(positionFrame)
    positionFrame = null
  }
}

async function open() {
  if (props.disabled) return
  highlightedIndex.value = props.options.findIndex(o => o.value === props.modelValue)
  if (highlightedIndex.value < 0) highlightedIndex.value = 0
  updateDropdownPosition()
  isOpen.value = true
  await nextTick()
  updateDropdownPosition()
  scrollToHighlighted()
}

function close() {
  isOpen.value = false
  highlightedIndex.value = -1
}

function toggle() {
  isOpen.value ? close() : open()
}

function select(option: SelectOption) {
  emit('update:modelValue', option.value)
  emit('change', option.value)
  close()
}

function scrollToHighlighted() {
  const el = dropdownEl.value?.querySelector('.ss-option-highlighted')
  el?.scrollIntoView({ block: 'nearest' })
}

function onKeydown(e: KeyboardEvent) {
  if (props.disabled) return

  if (!isOpen.value) {
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault()
      open()
    }
    return
  }

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      highlightedIndex.value = Math.min(highlightedIndex.value + 1, props.options.length - 1)
      nextTick(scrollToHighlighted)
      break
    case 'ArrowUp':
      e.preventDefault()
      highlightedIndex.value = Math.max(highlightedIndex.value - 1, 0)
      nextTick(scrollToHighlighted)
      break
    case 'Enter':
      e.preventDefault()
      if (highlightedIndex.value >= 0 && highlightedIndex.value < props.options.length) {
        select(props.options[highlightedIndex.value])
      }
      break
    case 'Escape':
      e.preventDefault()
      close()
      break
    case 'Home':
      e.preventDefault()
      highlightedIndex.value = 0
      nextTick(scrollToHighlighted)
      break
    case 'End':
      e.preventDefault()
      highlightedIndex.value = props.options.length - 1
      nextTick(scrollToHighlighted)
      break
    default:
      // Type-ahead search
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        searchBuffer.value += e.key.toLowerCase()
        if (searchTimer) clearTimeout(searchTimer)
        searchTimer = setTimeout(() => { searchBuffer.value = '' }, 400)
        const idx = props.options.findIndex(o =>
          o.label.toLowerCase().startsWith(searchBuffer.value)
        )
        if (idx >= 0) {
          highlightedIndex.value = idx
          nextTick(scrollToHighlighted)
        }
      }
      break
  }
}

function onClickOutside(e: MouseEvent) {
  const target = e.target as Node
  if (
    rootEl.value &&
    !rootEl.value.contains(target) &&
    !dropdownEl.value?.contains(target)
  ) {
    close()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onClickOutside)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutside)
  removePositionListeners()
  if (searchTimer) clearTimeout(searchTimer)
})

watch(isOpen, (open) => {
  if (open) {
    addPositionListeners()
    nextTick(updateDropdownPosition)
  } else {
    removePositionListeners()
  }
})

watch(() => props.modelValue, () => {
  if (isOpen.value) {
    highlightedIndex.value = props.options.findIndex(o => o.value === props.modelValue)
    nextTick(updateDropdownPosition)
  }
})

watch(() => props.options.length, () => {
  if (isOpen.value) nextTick(updateDropdownPosition)
})
</script>

<template>
  <div
    ref="rootEl"
    class="ss"
    :class="{ 'ss--open': isOpen, 'ss--disabled': disabled }"
    tabindex="0"
    role="combobox"
    :aria-expanded="isOpen"
    aria-haspopup="listbox"
    @keydown="onKeydown"
  >
    <button
      class="ss-trigger"
      type="button"
      :disabled="disabled"
      @click="toggle"
    >
      <span class="ss-value" :class="{ 'ss-placeholder': !selectedOption }">
        {{ displayLabel }}
      </span>
      <span class="ss-chevron" :class="{ 'ss-chevron--open': isOpen }">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
    </button>

    <Teleport to="body">
      <Transition name="ss-dropdown">
        <div
          v-if="isOpen"
          ref="dropdownEl"
          class="ss-dropdown"
          :class="{ 'ss-dropdown--above': dropUp }"
          :style="dropdownStyle"
          role="listbox"
        >
          <div
            v-for="(option, i) in options"
            :key="option.value"
            class="ss-option"
            :class="{
              'ss-option-highlighted': i === highlightedIndex,
              'ss-option-selected': option.value === modelValue,
            }"
            role="option"
            :aria-selected="option.value === modelValue"
            @mouseenter="highlightedIndex = i"
            @mousedown.prevent="select(option)"
          >
            <span class="ss-option-label">{{ option.label }}</span>
            <span v-if="option.value === modelValue" class="ss-check">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.ss {
  position: relative;
  display: inline-flex;
  width: 100%;
  outline: none;
}

.ss-trigger {
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

.ss-trigger:hover {
  border-color: var(--border-strong);
  background: var(--bg-card-hover);
}

.ss:focus .ss-trigger,
.ss--open .ss-trigger {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.ss--disabled .ss-trigger {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

.ss-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  text-align: left;
}

.ss-placeholder {
  color: var(--text-tertiary);
}

.ss-chevron {
  display: flex;
  align-items: center;
  color: var(--text-tertiary);
  transition: transform var(--duration-fast) var(--ease-out);
  flex-shrink: 0;
}

.ss-chevron--open {
  transform: rotate(180deg);
}

/* Dropdown */
.ss-dropdown {
  position: fixed;
  z-index: 4500;
  overflow-y: auto;
  background: var(--bg-elevated);
  backdrop-filter: blur(22px) saturate(180%);
  -webkit-backdrop-filter: blur(22px) saturate(180%);
  border: 0.5px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: 6px;
  contain: layout paint;
  overscroll-behavior: contain;
  transform-origin: top center;
}

.ss-option {
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

.ss-option-highlighted {
  background: var(--bg-hover);
}

.ss-option-selected {
  color: var(--text-accent);
  background: var(--accent-soft);
  font-weight: 500;
}

.ss-check {
  display: flex;
  align-items: center;
  color: var(--accent);
  flex-shrink: 0;
}

.ss-option-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Transition */
.ss-dropdown-enter-active {
  transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-spring);
}

.ss-dropdown-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.ss-dropdown-enter-from {
  opacity: 0;
  transform: translateY(-6px) scale(0.97);
}

.ss-dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}

.ss-dropdown--above {
  transform-origin: bottom center;
}

.ss-dropdown--above.ss-dropdown-enter-from {
  transform: translateY(6px) scale(0.97);
}

.ss-dropdown--above.ss-dropdown-leave-to {
  transform: translateY(4px) scale(0.98);
}
</style>
