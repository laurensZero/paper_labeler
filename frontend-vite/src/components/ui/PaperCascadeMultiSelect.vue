<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, type CSSProperties } from 'vue'

defineOptions({ name: 'PaperCascadeMultiSelect' })

export interface PaperCascadeOption {
  value: string
  label: string
}

const SEASON_ORDER = ['m', 's', 'w']
const SEASON_LABEL: Record<string, string> = {
  m: '春 m',
  s: '夏 s',
  w: '冬 w',
  unknown: '未知季节',
}

const props = withDefaults(defineProps<{
  modelValue: string[]
  options: PaperCascadeOption[]
  placeholder?: string
  disabled?: boolean
}>(), {
  placeholder: '选择试卷...',
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

interface PaperLeaf {
  value: string
  label: string
  subject: string
  year: string
  season: string
}

interface SeasonNode {
  key: string
  label: string
  count: number
  papers: PaperLeaf[]
}

interface YearNode {
  key: string
  label: string
  count: number
  seasons: SeasonNode[]
}

interface SubjectNode {
  key: string
  label: string
  count: number
  years: YearNode[]
}

const isOpen = ref(false)
const dropUp = ref(false)
const searchQuery = ref('')
const activeSubject = ref('')
const activeYear = ref('')
const activeSeason = ref('')
const rootEl = ref<HTMLElement | null>(null)
const dropdownEl = ref<HTMLElement | null>(null)
const searchInputEl = ref<HTMLInputElement | null>(null)
const dropdownStyle = ref<CSSProperties>({})
const pointerHistory = ref<{ x: number; y: number; t: number }[]>([])

let positionFrame: number | null = null
let isPositionListening = false
let pendingSubjectTimer: ReturnType<typeof setTimeout> | null = null
let pendingYearTimer: ReturnType<typeof setTimeout> | null = null
let pendingSubjectKey = ''
let pendingYearKey = ''
const menuAimDelayMs = 280

const selectedSet = computed(() => new Set((props.modelValue || []).map(normalizeKey)))

const normalizedOptions = computed<PaperLeaf[]>(() =>
  (props.options || [])
    .filter((opt) => opt && opt.value != null)
    .map((opt) => {
      const label = String(opt.label ?? opt.value ?? '')
      const meta = parsePaperMeta(label)
      return {
        value: normalizeKey(opt.value),
        label,
        ...meta,
      }
    }),
)

const filteredOptions = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return normalizedOptions.value
  return normalizedOptions.value.filter((opt) => {
    const haystack = `${opt.label} ${opt.subject} ${opt.year} ${opt.season}`.toLowerCase()
    return haystack.includes(q)
  })
})

const grouped = computed<SubjectNode[]>(() => {
  const bySubject = new Map<string, Map<string, Map<string, PaperLeaf[]>>>()

  for (const opt of filteredOptions.value) {
    if (!bySubject.has(opt.subject)) bySubject.set(opt.subject, new Map())
    const byYear = bySubject.get(opt.subject)!
    if (!byYear.has(opt.year)) byYear.set(opt.year, new Map())
    const bySeason = byYear.get(opt.year)!
    if (!bySeason.has(opt.season)) bySeason.set(opt.season, [])
    bySeason.get(opt.season)!.push(opt)
  }

  return Array.from(bySubject.keys())
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
    .map((subject) => {
      const yearMap = bySubject.get(subject)!
      const years = Array.from(yearMap.keys()).sort(sortYears).map((year) => {
        const seasonMap = yearMap.get(year)!
        const seasons = Array.from(seasonMap.keys()).sort(sortSeasons).map((season) => {
          const papers = (seasonMap.get(season) || [])
            .slice()
            .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
          return {
            key: season,
            label: SEASON_LABEL[season] || season,
            count: papers.length,
            papers,
          }
        })
        return {
          key: year,
          label: year === 'unknown' ? '未知年份' : year,
          count: seasons.reduce((sum, s) => sum + s.count, 0),
          seasons,
        }
      })
      return {
        key: subject,
        label: subject,
        count: years.reduce((sum, y) => sum + y.count, 0),
        years,
      }
    })
})

const activeSubjectNode = computed(() =>
  grouped.value.find((x) => x.key === activeSubject.value) || grouped.value[0] || null,
)

const yearList = computed(() => activeSubjectNode.value?.years || [])

const activeYearNode = computed(() =>
  yearList.value.find((x) => x.key === activeYear.value) || yearList.value[0] || null,
)

const seasonList = computed(() => activeYearNode.value?.seasons || [])

const activeSeasonNode = computed(() =>
  seasonList.value.find((x) => x.key === activeSeason.value) || seasonList.value[0] || null,
)

const currentPaperList = computed(() => activeSeasonNode.value?.papers || [])

const allCurrentSelected = computed(() => {
  const list = currentPaperList.value
  return list.length > 0 && list.every((p) => selectedSet.value.has(p.value))
})

const displayLabel = computed(() => {
  const total = normalizedOptions.value.length
  const selected = selectedSet.value.size
  if (selected <= 0 || (total > 0 && selected >= total)) return props.placeholder ?? ''
  if (selected === 1) {
    const target = normalizedOptions.value.find((x) => selectedSet.value.has(x.value))
    return target?.label || props.placeholder || ''
  }
  return `已选 ${selected} 项`
})

function normalizeKey(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

function parsePaperMeta(label: string): { subject: string; year: string; season: string } {
  const text = String(label || '')
  const subject = (text.match(/^([A-Za-z0-9]+)/)?.[1] || '(未识别科目)').trim()
  const ys = text.match(/_(m|s|w)(\d{2})_/i) || text.match(/(?:^|[_\-\s])(m|s|w)(\d{2})(?:[_\-\s]|$)/i)
  const season = ys?.[1] ? String(ys[1]).toLowerCase() : 'unknown'
  const year = ys?.[2] ? String(ys[2]) : 'unknown'
  return { subject, year, season }
}

function sortYears(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na
  if (a === 'unknown') return 1
  if (b === 'unknown') return -1
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

function sortSeasons(a: string, b: string): number {
  const ia = SEASON_ORDER.indexOf(a)
  const ib = SEASON_ORDER.indexOf(b)
  if (ia >= 0 && ib >= 0) return ia - ib
  if (ia >= 0) return -1
  if (ib >= 0) return 1
  return String(a).localeCompare(String(b))
}

function ensureActivePath() {
  activeSubject.value = activeSubjectNode.value?.key || ''
  activeYear.value = activeYearNode.value?.key || ''
  activeSeason.value = activeSeasonNode.value?.key || ''
}

function emitFromKeySet(next: Set<string>) {
  const out: string[] = []
  for (const opt of normalizedOptions.value) {
    if (next.has(opt.value)) out.push(opt.value)
  }
  emit('update:modelValue', out)
}

function open() {
  if (props.disabled) return
  isOpen.value = true
  searchQuery.value = ''
  ensureActivePath()
  addPositionListeners()
  nextTick(() => {
    searchInputEl.value?.focus()
    updateDropdownPosition()
  })
}

function close() {
  isOpen.value = false
  searchQuery.value = ''
  dropUp.value = false
  pointerHistory.value = []
  clearPendingSwitches()
  removePositionListeners()
}

function toggle() {
  isOpen.value ? close() : open()
}

function selectAllFiltered() {
  const next = new Set(selectedSet.value)
  const list = filteredOptions.value.length ? filteredOptions.value : normalizedOptions.value
  const allSelected = list.length > 0 && list.every((opt) => next.has(opt.value))
  for (const opt of list) {
    if (allSelected) next.delete(opt.value)
    else next.add(opt.value)
  }
  emitFromKeySet(next)
}

function clearAll() {
  emit('update:modelValue', [])
}

function toggleCurrentSeasonSelectAll() {
  const list = currentPaperList.value
  if (!list.length) return
  const next = new Set(selectedSet.value)
  const allSelected = list.every((p) => next.has(p.value))
  for (const paper of list) {
    if (allSelected) next.delete(paper.value)
    else next.add(paper.value)
  }
  emitFromKeySet(next)
}

function togglePaper(value: string) {
  const key = normalizeKey(value)
  const next = new Set(selectedSet.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  emitFromKeySet(next)
}

function applySubject(subjectKey: string) {
  activeSubject.value = subjectKey
  ensureActivePath()
  nextTick(updateDropdownPosition)
}

function applyYear(yearKey: string) {
  activeYear.value = yearKey
  ensureActivePath()
  nextTick(updateDropdownPosition)
}

function clearPendingSwitches() {
  if (pendingSubjectTimer) clearTimeout(pendingSubjectTimer)
  if (pendingYearTimer) clearTimeout(pendingYearTimer)
  pendingSubjectTimer = null
  pendingYearTimer = null
  pendingSubjectKey = ''
  pendingYearKey = ''
}

function onMenuMouseMove(evt: MouseEvent) {
  if (!isOpen.value) return
  const x = Number(evt.clientX)
  const y = Number(evt.clientY)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  pointerHistory.value.push({ x, y, t: Date.now() })
  if (pointerHistory.value.length > 6) pointerHistory.value.shift()
}

function onMenuLeave() {
  clearPendingSwitches()
  pointerHistory.value = []
}

function isMovingTowardColumn(evt: MouseEvent, selector: string): boolean {
  const target = dropdownEl.value?.querySelector(selector)
  if (!target) return false
  const prev = pointerHistory.value[pointerHistory.value.length - 2] || pointerHistory.value[pointerHistory.value.length - 1]
  if (!prev) return false
  const curr = { x: Number(evt.clientX), y: Number(evt.clientY) }
  if (!Number.isFinite(curr.x) || !Number.isFinite(curr.y)) return false
  if (curr.x < prev.x + 2) return false
  const rect = target.getBoundingClientRect()
  const topLeft = { x: rect.left + 24, y: rect.top - 24 }
  const bottomLeft = { x: rect.left + 24, y: rect.bottom + 24 }
  return isPointInTriangle(curr, prev, topLeft, bottomLeft)
}

function isPointInTriangle(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): boolean {
  const sign = (p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }) =>
    (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y)
  const d1 = sign(p, a, b)
  const d2 = sign(p, b, c)
  const d3 = sign(p, c, a)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

function scheduleSubjectActivation(subjectKey: string, evt: MouseEvent) {
  if (subjectKey === activeSubject.value) return
  if (pendingSubjectTimer) clearTimeout(pendingSubjectTimer)
  pendingSubjectKey = subjectKey
  pendingSubjectTimer = setTimeout(() => {
    if (pendingSubjectKey === subjectKey) applySubject(subjectKey)
    pendingSubjectTimer = null
    pendingSubjectKey = ''
  }, menuAimDelayMs)
  onMenuMouseMove(evt)
}

function scheduleYearActivation(yearKey: string, evt: MouseEvent) {
  if (yearKey === activeYear.value) return
  if (pendingYearTimer) clearTimeout(pendingYearTimer)
  pendingYearKey = yearKey
  pendingYearTimer = setTimeout(() => {
    if (pendingYearKey === yearKey) applyYear(yearKey)
    pendingYearTimer = null
    pendingYearKey = ''
  }, menuAimDelayMs)
  onMenuMouseMove(evt)
}

function onSubjectEnter(subjectKey: string, evt: MouseEvent) {
  if (!isOpen.value) return
  if (isMovingTowardColumn(evt, '.pcms-col--year')) {
    scheduleSubjectActivation(subjectKey, evt)
    return
  }
  if (pendingSubjectTimer) clearTimeout(pendingSubjectTimer)
  pendingSubjectTimer = null
  pendingSubjectKey = ''
  applySubject(subjectKey)
  onMenuMouseMove(evt)
}

function onYearEnter(yearKey: string, evt: MouseEvent) {
  if (!isOpen.value) return
  if (isMovingTowardColumn(evt, '.pcms-col--season')) {
    scheduleYearActivation(yearKey, evt)
    return
  }
  if (pendingYearTimer) clearTimeout(pendingYearTimer)
  pendingYearTimer = null
  pendingYearKey = ''
  applyYear(yearKey)
  onMenuMouseMove(evt)
}

function onSeasonEnter(seasonKey: string, evt: MouseEvent) {
  activeSeason.value = seasonKey
  onMenuMouseMove(evt)
}

function updateDropdownPosition() {
  const root = rootEl.value
  const dropdown = dropdownEl.value
  if (!root || !dropdown) return

  const rect = root.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const gap = 6
  const margin = 8
  const preferredWidth = Math.min(760, Math.max(560, viewportWidth - margin * 2))
  const width = viewportWidth < 700
    ? Math.max(280, viewportWidth - margin * 2)
    : Math.min(preferredWidth, viewportWidth - margin * 2)
  const left = viewportWidth < 700
    ? margin
    : Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - margin - width))
  const belowSpace = viewportHeight - rect.bottom - margin
  const aboveSpace = rect.top - margin
  const shouldDropUp = belowSpace < 320 && aboveSpace > belowSpace
  const maxHeight = Math.max(220, Math.min(420, (shouldDropUp ? aboveSpace : belowSpace) - gap))
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

function onKeydown(e: KeyboardEvent) {
  if (props.disabled) return
  if (!isOpen.value) {
    if (['Enter', ' ', 'ArrowDown'].includes(e.key)) {
      e.preventDefault()
      open()
    }
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}

watch(grouped, () => {
  ensureActivePath()
  if (isOpen.value) nextTick(updateDropdownPosition)
})

watch(() => props.modelValue, () => {
  const valid = new Set(normalizedOptions.value.map((opt) => opt.value))
  const next = (props.modelValue || []).filter((v) => valid.has(normalizeKey(v)))
  if (next.length !== (props.modelValue || []).length) emit('update:modelValue', next)
})

onMounted(() => {
  document.addEventListener('mousedown', onClickOutside)
  ensureActivePath()
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutside)
  removePositionListeners()
  clearPendingSwitches()
})
</script>

<template>
  <div
    ref="rootEl"
    class="pcms"
    :class="{ 'pcms--open': isOpen, 'pcms--disabled': disabled }"
    tabindex="0"
    role="combobox"
    :aria-expanded="isOpen"
    aria-haspopup="listbox"
    @keydown="onKeydown"
  >
    <button
      class="pcms-trigger"
      type="button"
      :disabled="disabled"
      @click="toggle"
    >
      <span class="pcms-value" :class="{ 'pcms-placeholder': modelValue.length === 0 }">
        {{ displayLabel }}
      </span>
      <span v-if="modelValue.length > 0" class="pcms-count">{{ modelValue.length }}</span>
      <span class="pcms-chevron" :class="{ 'pcms-chevron--open': isOpen }">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
    </button>

    <Teleport to="body">
      <Transition name="pcms-dropdown">
        <div
          v-if="isOpen"
          ref="dropdownEl"
          class="pcms-dropdown"
          :class="{ 'pcms-dropdown--above': dropUp }"
          :style="dropdownStyle"
          role="listbox"
          aria-multiselectable="true"
          @mousemove="onMenuMouseMove"
          @mouseleave="onMenuLeave"
        >
          <div class="pcms-head">
            <div class="pcms-search">
              <svg class="pcms-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref="searchInputEl"
                v-model="searchQuery"
                class="pcms-search-input"
                type="text"
                placeholder="搜索试卷、科目、年份..."
                @keydown.stop
              />
            </div>
            <div class="pcms-actions">
              <span class="pcms-summary">{{ filteredOptions.length }} / {{ normalizedOptions.length }}</span>
              <button class="pcms-action-btn" type="button" @mousedown.prevent @click="selectAllFiltered">
                {{ filteredOptions.length && filteredOptions.every((p) => selectedSet.has(p.value)) ? '清除当前' : '全选当前' }}
              </button>
              <button class="pcms-action-btn" type="button" @mousedown.prevent @click="clearAll">清空</button>
            </div>
          </div>

          <div v-if="grouped.length" class="pcms-grid">
            <div class="pcms-col pcms-col--subject">
              <div class="pcms-col-title">科目</div>
              <button
                v-for="subject in grouped"
                :key="subject.key"
                type="button"
                class="pcms-group-item"
                :class="{ 'pcms-group-item--active': subject.key === activeSubject }"
                @mouseenter="onSubjectEnter(subject.key, $event)"
                @focus="applySubject(subject.key)"
              >
                <span>{{ subject.label }}</span>
                <span class="pcms-item-count">{{ subject.count }}</span>
              </button>
            </div>

            <div class="pcms-col pcms-col--year">
              <div class="pcms-col-title">年份</div>
              <button
                v-for="year in yearList"
                :key="year.key"
                type="button"
                class="pcms-group-item"
                :class="{ 'pcms-group-item--active': year.key === activeYear }"
                @mouseenter="onYearEnter(year.key, $event)"
                @focus="applyYear(year.key)"
              >
                <span>{{ year.label }}</span>
                <span class="pcms-item-count">{{ year.count }}</span>
              </button>
            </div>

            <div class="pcms-col pcms-col--season">
              <div class="pcms-col-title">季节</div>
              <button
                v-for="season in seasonList"
                :key="season.key"
                type="button"
                class="pcms-group-item"
                :class="{ 'pcms-group-item--active': season.key === activeSeason }"
                @mouseenter="onSeasonEnter(season.key, $event)"
                @focus="activeSeason = season.key"
              >
                <span>{{ season.label }}</span>
                <span class="pcms-item-count">{{ season.count }}</span>
              </button>
            </div>

            <div class="pcms-col pcms-col--paper">
              <div class="pcms-leaf-head">
                <span>试卷</span>
                <button class="pcms-link-btn" type="button" @mousedown.prevent @click="toggleCurrentSeasonSelectAll">
                  {{ allCurrentSelected ? '本季清空' : '本季全选' }}
                </button>
              </div>
              <button
                v-for="paper in currentPaperList"
                :key="paper.value"
                type="button"
                class="pcms-paper-item"
                :class="{ 'pcms-paper-item--selected': selectedSet.has(paper.value) }"
                role="option"
                :aria-selected="selectedSet.has(paper.value)"
                :title="paper.label"
                @mousedown.prevent="togglePaper(paper.value)"
              >
                <span class="pcms-checkbox" :class="{ 'pcms-checkbox--checked': selectedSet.has(paper.value) }">
                  <svg v-if="selectedSet.has(paper.value)" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
                <span class="pcms-paper-label">{{ paper.label }}</span>
              </button>
              <div v-if="!currentPaperList.length" class="pcms-empty">暂无试卷</div>
            </div>
          </div>

          <div v-else class="pcms-empty pcms-empty--panel">无匹配项</div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.pcms {
  position: relative;
  display: inline-flex;
  width: 100%;
  outline: none;
}

.pcms-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 38px;
  padding: 8px 16px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
  outline: none;
  gap: 8px;
}

.pcms-trigger:hover {
  border-color: var(--border-strong);
  background: var(--bg-card-hover);
}

.pcms:focus .pcms-trigger,
.pcms--open .pcms-trigger {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.pcms--disabled .pcms-trigger {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

.pcms-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  text-align: left;
}

.pcms-placeholder {
  color: var(--text-tertiary);
}

.pcms-count {
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
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

.pcms-chevron {
  display: flex;
  align-items: center;
  color: var(--text-tertiary);
  transition: transform var(--duration-fast) var(--ease-out);
  flex-shrink: 0;
}

.pcms-chevron--open {
  transform: rotate(180deg);
}

.pcms-dropdown {
  position: fixed;
  z-index: 4600;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  transform-origin: top center;
  contain: layout paint;
  overscroll-behavior: contain;
}

.pcms-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated);
}

.pcms-search {
  position: relative;
  flex: 1;
  min-width: 0;
}

.pcms-search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-tertiary);
  pointer-events: none;
}

.pcms-search-input {
  width: 100%;
  height: 30px;
  padding: 6px 10px 6px 30px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-primary);
  font-family: inherit;
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}

.pcms-search-input::placeholder {
  color: var(--text-tertiary);
}

.pcms-search-input:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.pcms-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.pcms-summary {
  padding: 0 6px;
  color: var(--text-tertiary);
  font-size: 11px;
  white-space: nowrap;
}

.pcms-action-btn,
.pcms-link-btn {
  border: 0;
  background: transparent;
  color: var(--text-accent);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  border-radius: 6px;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}

.pcms-action-btn {
  padding: 5px 8px;
}

.pcms-link-btn {
  padding: 3px 6px;
}

.pcms-action-btn:hover,
.pcms-link-btn:hover {
  background: var(--accent-soft);
}

.pcms-grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(110px, 0.9fr) minmax(92px, 0.72fr) minmax(96px, 0.72fr) minmax(220px, 1.7fr);
  overflow: hidden;
}

.pcms-col {
  min-width: 0;
  max-height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 6px;
  border-right: 1px solid var(--border);
}

.pcms-col:last-child {
  border-right: 0;
}

.pcms-col-title,
.pcms-leaf-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 28px;
  margin: -6px -6px 4px;
  padding: 7px 8px 5px;
  background: var(--bg-elevated);
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 700;
  border-bottom: 1px solid var(--border);
}

.pcms-group-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
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

.pcms-group-item:hover,
.pcms-group-item--active {
  background: var(--bg-hover);
}

.pcms-group-item--active {
  border-color: var(--border-accent);
  color: var(--text-accent);
}

.pcms-item-count {
  flex-shrink: 0;
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 600;
}

.pcms-paper-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
}

.pcms-paper-item:hover {
  background: var(--bg-hover);
}

.pcms-paper-item--selected {
  color: var(--text-accent);
  background: var(--accent-soft);
}

.pcms-checkbox {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: 1.5px solid var(--border-strong);
  border-radius: 4px;
  flex-shrink: 0;
  transition: all var(--duration-fast) var(--ease-out);
  background: transparent;
}

.pcms-checkbox--checked {
  border-color: var(--text-primary);
  background: transparent;
  color: var(--text-primary);
}

.pcms-paper-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pcms-empty {
  padding: 14px;
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary);
}

.pcms-empty--panel {
  min-height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pcms-dropdown-enter-active {
  transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-spring);
}

.pcms-dropdown-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}

.pcms-dropdown-enter-from {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
}

.pcms-dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}

.pcms-dropdown--above {
  transform-origin: bottom center;
}

.pcms-dropdown--above.pcms-dropdown-enter-from {
  transform: translateY(6px) scale(0.98);
}

.pcms-dropdown--above.pcms-dropdown-leave-to {
  transform: translateY(4px) scale(0.98);
}

@media (max-width: 700px) {
  .pcms-head {
    align-items: stretch;
    flex-direction: column;
  }

  .pcms-actions {
    justify-content: space-between;
  }

  .pcms-grid {
    grid-template-columns: 1fr 0.8fr;
    grid-template-rows: auto auto;
  }

  .pcms-col {
    max-height: 168px;
  }

  .pcms-col--season {
    border-right: 1px solid var(--border);
  }

  .pcms-col--paper {
    grid-column: span 2;
    max-height: 210px;
    border-top: 1px solid var(--border);
  }
}
</style>
