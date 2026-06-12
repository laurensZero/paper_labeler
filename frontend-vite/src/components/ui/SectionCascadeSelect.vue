<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, type CSSProperties } from 'vue'

defineOptions({ name: 'SectionCascadeSelect' })

export interface CascadeGroup {
  label: string
  options: { value: string; label: string }[]
}

const props = withDefaults(defineProps<{
  modelValue: string
  options: CascadeGroup[]
  placeholder?: string
  disabled?: boolean
}>(), {
  placeholder: '选择分类...',
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const isOpen = ref(false)
const dropUp = ref(false)
const highlightedGroup = ref(-1)
const highlightedItem = ref(-1)
const rootEl = ref<HTMLElement | null>(null)
const dropdownEl = ref<HTMLElement | null>(null)
const dropdownStyle = ref<CSSProperties>({})
let positionFrame: number | null = null
let isPositionListening = false

const allFlatOptions = computed(() => {
  const result: { value: string; label: string; groupLabel: string }[] = []
  for (const g of props.options) {
    for (const o of g.options) {
      result.push({ ...o, groupLabel: g.label })
    }
  }
  return result
})

const selectedOption = computed(() =>
  allFlatOptions.value.find(o => o.value === props.modelValue) ?? null
)

const displayLabel = computed(() =>
  selectedOption.value?.label ?? props.placeholder
)

const activeGroup = computed(() =>
  props.options[highlightedGroup.value] ?? props.options[0] ?? null
)

function open() {
  if (props.disabled) return
  isOpen.value = true
  // Highlight the currently selected item
  let found = false
  for (let gi = 0; gi < props.options.length; gi++) {
    const ii = props.options[gi].options.findIndex(o => o.value === props.modelValue)
    if (ii >= 0) {
      highlightedGroup.value = gi
      highlightedItem.value = ii
      found = true
      break
    }
  }
  if (!found) {
    highlightedGroup.value = 0
    highlightedItem.value = 0
  }
  addPositionListeners()
  nextTick(() => {
    updateDropdownPosition()
    scrollToHighlighted()
  })
}

function close() {
  isOpen.value = false
  dropUp.value = false
  highlightedGroup.value = -1
  highlightedItem.value = -1
  removePositionListeners()
}

function toggle() {
  isOpen.value ? close() : open()
}

function selectValue(value: string) {
  emit('update:modelValue', value)
  close()
}

function scrollToHighlighted() {
  const el = dropdownEl.value?.querySelector('.scs-item--highlighted')
  el?.scrollIntoView({ block: 'nearest' })
}

function moveHighlight(dg: number, di: number) {
  let g = highlightedGroup.value
  let i = highlightedItem.value + di

  if (g < 0 || g >= props.options.length) {
    g = 0
    i = 0
    highlightedGroup.value = g
    highlightedItem.value = i
    nextTick(scrollToHighlighted)
    return
  }

  // Move within group
  if (i >= 0 && i < props.options[g].options.length) {
    highlightedItem.value = i
  } else if (di > 0) {
    // Move to next group
    if (g + dg < props.options.length) {
      highlightedGroup.value = g + dg
      highlightedItem.value = 0
    }
  } else if (di < 0) {
    // Move to previous group
    if (g - 1 >= 0) {
      highlightedGroup.value = g - 1
      highlightedItem.value = props.options[highlightedGroup.value].options.length - 1
    }
  }

  nextTick(scrollToHighlighted)
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
      moveHighlight(1, 1)
      break
    case 'ArrowUp':
      e.preventDefault()
      moveHighlight(-1, -1)
      break
    case 'ArrowRight':
      e.preventDefault()
      moveHighlight(1, 0)
      break
    case 'ArrowLeft':
      e.preventDefault()
      moveHighlight(-1, 0)
      break
    case 'Enter':
      e.preventDefault()
      if (
        highlightedGroup.value >= 0 &&
        highlightedItem.value >= 0 &&
        props.options[highlightedGroup.value]?.options[highlightedItem.value]
      ) {
        selectValue(props.options[highlightedGroup.value].options[highlightedItem.value].value)
      }
      break
    case 'Escape':
      e.preventDefault()
      close()
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

function updateDropdownPosition() {
  const root = rootEl.value
  const dropdown = dropdownEl.value
  if (!root || !dropdown) return

  const rect = root.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const margin = 8
  const gap = 4
  const width = viewportWidth <= 560
    ? Math.max(280, viewportWidth - margin * 2)
    : Math.min(620, Math.max(360, viewportWidth - margin * 2))
  const left = viewportWidth <= 560
    ? margin
    : Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - margin - width))
  const belowSpace = viewportHeight - rect.bottom - margin
  const aboveSpace = rect.top - margin
  const shouldDropUp = belowSpace < 220 && aboveSpace > belowSpace
  const maxHeight = Math.max(140, Math.min(300, (shouldDropUp ? aboveSpace : belowSpace) - gap))
  const height = Math.min(dropdown.scrollHeight || maxHeight, maxHeight)
  const top = shouldDropUp
    ? Math.max(margin, rect.top - gap - height)
    : Math.min(viewportHeight - margin - height, rect.bottom + gap)

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

onMounted(() => {
  document.addEventListener('mousedown', onClickOutside)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutside)
  removePositionListeners()
})

watch(() => props.options.length, () => {
  if (isOpen.value) nextTick(updateDropdownPosition)
})
</script>

<template>
  <div
    ref="rootEl"
    class="scs"
    :class="{ 'scs--open': isOpen, 'scs--disabled': disabled }"
    tabindex="0"
    role="combobox"
    :aria-expanded="isOpen"
    aria-haspopup="listbox"
    @keydown="onKeydown"
  >
    <button
      class="scs-trigger"
      type="button"
      :disabled="disabled"
      @click="toggle"
    >
      <span class="scs-value" :class="{ 'scs-placeholder': !selectedOption }">
        {{ displayLabel }}
      </span>
      <span class="scs-chevron" :class="{ 'scs-chevron--open': isOpen }">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
    </button>

    <Teleport to="body">
      <Transition name="scs-dropdown">
        <div
          v-if="isOpen"
          ref="dropdownEl"
          class="scs-dropdown"
          :class="{ 'scs-dropdown--above': dropUp }"
          :style="dropdownStyle"
          role="listbox"
        >
          <div class="scs-group-list">
            <button
              v-for="(group, gi) in options"
              :key="group.label"
              type="button"
              class="scs-group-row"
              :class="{ 'scs-group-row--active': gi === highlightedGroup }"
              @mouseenter="highlightedGroup = gi; highlightedItem = 0"
              @focus="highlightedGroup = gi; highlightedItem = 0"
            >
              <span class="scs-group-name">{{ group.label }}</span>
              <span class="scs-group-count">{{ group.options.length }}</span>
            </button>
          </div>
          <div class="scs-item-list">
            <div v-if="!activeGroup" class="scs-empty">暂无分类</div>
            <template v-else>
              <div
                v-for="(item, ii) in activeGroup.options"
                :key="item.value"
                class="scs-item"
                :class="{
                  'scs-item--highlighted': ii === highlightedItem,
                  'scs-item--selected': item.value === modelValue,
                }"
                role="option"
                :aria-selected="item.value === modelValue"
                @mouseenter="highlightedItem = ii"
                @mousedown.prevent="selectValue(item.value)"
              >
                <span class="scs-item-label">{{ item.label }}</span>
                <span v-if="item.value === modelValue" class="scs-check">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
              </div>
            </template>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.scs {
  position: relative;
  display: inline-flex;
  width: 100%;
  outline: none;
}

.scs-trigger {
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

.scs-trigger:hover {
  border-color: var(--border-strong);
  background: var(--bg-card-hover);
}

.scs:focus .scs-trigger,
.scs--open .scs-trigger {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.scs--disabled .scs-trigger {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

.scs-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  text-align: left;
}

.scs-placeholder {
  color: var(--text-tertiary);
}

.scs-chevron {
  display: flex;
  align-items: center;
  color: var(--text-tertiary);
  transition: transform var(--duration-fast) var(--ease-out);
  flex-shrink: 0;
}

.scs-chevron--open {
  transform: rotate(180deg);
}

/* Dropdown */
.scs-dropdown {
  position: fixed;
  z-index: 1000;
  display: grid;
  grid-template-columns: minmax(130px, max-content) minmax(190px, 1fr);
  overflow: hidden;
  background: var(--bg-elevated);
  backdrop-filter: blur(22px) saturate(180%);
  -webkit-backdrop-filter: blur(22px) saturate(180%);
  border: 0.5px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  transform-origin: top center;
  contain: layout paint;
  overscroll-behavior: contain;
}

.scs-group-list,
.scs-item-list {
  min-width: 0;
  max-height: 300px;
  overflow-y: auto;
  padding: 6px;
}

.scs-group-list {
  border-right: 0.5px solid var(--border);
}

.scs-group-row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 30px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: default;
  text-align: left;
  white-space: nowrap;
}

.scs-group-row:hover,
.scs-group-row--active {
  background: var(--bg-hover);
}

.scs-group-row--active {
  border-color: var(--border-accent);
  color: var(--text-accent);
}

.scs-group-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scs-group-count {
  flex-shrink: 0;
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 600;
}

.scs-item {
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

.scs-item--highlighted {
  background: var(--bg-hover);
}

.scs-item--selected {
  color: var(--text-accent);
  background: var(--accent-soft);
  font-weight: 500;
}

.scs-check {
  display: flex;
  align-items: center;
  color: var(--accent);
  flex-shrink: 0;
}

.scs-item-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scs-empty {
  padding: 16px;
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary);
}

@media (max-width: 560px) {
  .scs-dropdown {
    grid-template-columns: 1fr;
    min-width: min(320px, calc(100vw - 24px));
  }

  .scs-group-list {
    max-height: 132px;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }

  .scs-item-list {
    max-height: 190px;
  }
}

/* Transition */
.scs-dropdown-enter-active {
  transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-spring);
}

.scs-dropdown-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.scs-dropdown-enter-from {
  opacity: 0;
  transform: translateY(-6px) scale(0.97);
}

.scs-dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}

.scs-dropdown--above {
  transform-origin: bottom center;
}

.scs-dropdown--above.scs-dropdown-enter-from {
  transform: translateY(6px) scale(0.97);
}

.scs-dropdown--above.scs-dropdown-leave-to {
  transform: translateY(4px) scale(0.98);
}
</style>
