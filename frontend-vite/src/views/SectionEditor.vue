<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useSectionsStore } from '@/stores/sections'
import SimpleSelect from '@/components/ui/SimpleSelect.vue'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import { api } from '@/api/client'
import type { SectionDef, SectionGroup } from '@/stores/sections'

const { t } = useI18n()
defineOptions({ name: 'SectionEditor' })

const store = useSectionsStore()

const {
  sectionDefs,
  sectionGroups,
  sectionMultiSelect,
  selectedSectionDefIds,
  sectionBatchGroupId,
  newSectionName,
  newSectionGroupName,
  newSectionGroupId,
} = storeToRefs(store)

// ── Color picker state ──
const openColorPicker = ref<number | null>(null)
const pickerHue = ref(200)
const pickerSat = ref(80)
const pickerLit = ref(55)

function onDocClick(e: MouseEvent) {
  if (openColorPicker.value == null) return
  const target = e.target as HTMLElement
  if (!target.closest('.se-color-picker')) {
    // Save current section's color before closing
    const sid = openColorPicker.value
    const s = sectionDefs.value.find(d => d.id === sid)
    if (s) store.updateSectionDef(s)
    openColorPicker.value = null
  }
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const color = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * color).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return null
  let r = parseInt(m[1], 16) / 255
  let g = parseInt(m[2], 16) / 255
  let b = parseInt(m[3], 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0, l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break
      case g: h = ((b - r) / d + 2) * 60; break
      case b: h = ((r - g) / d + 4) * 60; break
    }
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) }
}

function openPickerFor(s: SectionDef) {
  if (openColorPicker.value === s.id) {
    // Closing — save
    store.updateSectionDef(s)
    openColorPicker.value = null
    return
  }
  // Save previous section if open
  if (openColorPicker.value != null) {
    const prev = sectionDefs.value.find(d => d.id === openColorPicker.value)
    if (prev) store.updateSectionDef(prev)
  }
  if (s.color) {
    const hsl = hexToHsl(s.color)
    if (hsl) { pickerHue.value = hsl.h; pickerSat.value = hsl.s; pickerLit.value = hsl.l }
  }
  openColorPicker.value = s.id
}

function applyPickerColor(s: SectionDef) {
  // Only update local state, save on close
  s.color = hslToHex(pickerHue.value, pickerSat.value, pickerLit.value)
}


function clearColor(s: SectionDef) {
  s.color = null
  store.updateSectionDef(s)
  openColorPicker.value = null
}

const pickerPreviewColor = computed(() =>
  hslToHex(pickerHue.value, pickerSat.value, pickerLit.value)
)

// ── Section stats (question counts) ──
const sectionCounts = ref<Record<string, number>>({})

async function loadSectionCounts() {
  try {
    const data = await api('/section_stats')
    const counts: Record<string, number> = {}
    for (const item of (data || [])) {
      if (item.section) counts[item.section] = item.count || 0
    }
    sectionCounts.value = counts
  } catch {
    sectionCounts.value = {}
  }
}

// ── Grouped view ──
interface GroupWithSections {
  group: SectionGroup | null
  sections: SectionDef[]
  questionCount: number
}

const groupedView = computed<GroupWithSections[]>(() => {
  const groups = sectionGroups.value
  const defs = sectionDefs.value

  // Map groupId -> sections
  const byGroup = new Map<number | null, SectionDef[]>()
  for (const s of defs) {
    const gid = s.group_id ?? null
    if (!byGroup.has(gid)) byGroup.set(gid, [])
    byGroup.get(gid)!.push(s)
  }

  const result: GroupWithSections[] = []

  // Ordered groups
  for (const g of groups) {
    const sections = byGroup.get(g.id) || []
    const questionCount = sections.reduce((sum, s) => sum + (sectionCounts.value[s.name] || 0), 0)
    result.push({ group: g, sections, questionCount })
  }

  // Ungrouped (null group_id)
  const ungrouped = byGroup.get(null) || []
  if (ungrouped.length > 0) {
    const questionCount = ungrouped.reduce((sum, s) => sum + (sectionCounts.value[s.name] || 0), 0)
    result.push({ group: null, sections: ungrouped, questionCount })
  }

  return result
})

const totalSections = computed(() => sectionDefs.value.length)
const totalGroups = computed(() => sectionGroups.value.length)
const totalQuestionsClassified = computed(() =>
  Object.values(sectionCounts.value).reduce((s, n) => s + n, 0)
)

// ── Group options for SimpleSelect ──
const groupOptions = computed(() => [
  { value: null, label: t('sectionEditor.noGroup') },
  ...sectionGroups.value.map(g => ({ value: g.id, label: g.name })),
])

// ── Collapsed state ──
const collapsedGroups = ref<Set<number | null>>(new Set())

function toggleCollapse(gid: number | null) {
  const next = new Set(collapsedGroups.value)
  if (next.has(gid)) next.delete(gid)
  else next.add(gid)
  collapsedGroups.value = next
}

function isCollapsed(gid: number | null): boolean {
  return collapsedGroups.value.has(gid)
}

// ── Add section group ──
function onAddGroup() {
  store.createSectionGroup(newSectionGroupName.value)
}

// ── Add section ──
function onAddSection() {
  store.createSectionDef(newSectionName.value, '', newSectionGroupId.value)
}

// ── Auto-save section group on blur/enter ──
function autoSaveSectionGroup(g: SectionGroup) {
  const gAny = g as any
  const nameChanged = g.name !== gAny.__lastSavedName
  const showChanged = g.show_in_filter !== gAny.__lastSavedShow
  if (nameChanged || showChanged) {
    store.updateSectionGroup(g)
  }
}

// ── Auto-save section def on blur/enter ──
function autoSaveSectionDef(s: SectionDef) {
  const sAny = s as any
  const nameChanged = s.name !== sAny.__lastSavedName
  const groupChanged = s.group_id !== sAny.__lastSavedGroupId
  if (nameChanged || groupChanged) {
    store.updateSectionDef(s)
  }
}

// ── Section group change via SimpleSelect ──
function onSectionDefGroupChange(s: SectionDef, val: number | null) {
  s.group_id = val
  autoSaveSectionDef(s)
}

// ── Toggle checkbox for a single section ──
function onToggleSectionSelect(s: SectionDef, value: boolean) {
  store.toggleSectionSelection(s.id, value)
}

// ── Batch group change ──
function onApplyBatchGroup() {
  store.applyBatchSectionGroup()
}

// ── Delete ──
function onDeleteGroup(g: SectionGroup) {
  store.deleteSectionGroup(g)
}

function onDeleteSection(s: SectionDef) {
  store.deleteSectionDef(s)
}

function onDeleteSelected() {
  store.deleteSelectedSectionDefs()
}

onMounted(() => {
  store.refreshSectionDefs()
  loadSectionCounts()
})
</script>

<template>
  <div class="section-editor">
    <!-- Header -->
    <div class="card">
      <div class="se-header">
        <div>
          <h2 class="card-title" style="margin-bottom: 4px">{{ t('sectionEditor.title') }}</h2>
          <p class="se-subtitle">{{ t('sectionEditor.subtitle') }}</p>
        </div>
        <div class="se-stats">
          <span class="se-stat">{{ t('sectionEditor.statGroups', { count: totalGroups }) }}</span>
          <span class="se-stat">{{ t('sectionEditor.statSections', { count: totalSections }) }}</span>
          <span class="se-stat">{{ t('sectionEditor.statQuestions', { count: totalQuestionsClassified }) }}</span>
        </div>
      </div>
    </div>

    <!-- ── Add Group / Section ── -->
    <div class="card">
      <div class="se-add-row">
        <div class="se-add-block">
          <div class="se-add-label">{{ t('sectionEditor.addGroup') }}</div>
          <div class="se-add-inputs">
            <input
              v-model="newSectionGroupName"
              type="text"
              :placeholder="t('sectionEditor.addGroupPlaceholder')"
              class="se-input"
              style="flex: 1; min-width: 0"
              @keydown.enter.prevent="onAddGroup"
            />
            <button class="btn btn-primary" @click="onAddGroup">{{ t('sectionEditor.addGroup') }}</button>
          </div>
        </div>
        <div class="se-add-divider" />
        <div class="se-add-block">
          <div class="se-add-label">{{ t('sectionEditor.addSection') }}</div>
          <div class="se-add-inputs">
            <div style="min-width: 160px; width: 180px; flex-shrink: 0">
              <SimpleSelect
                v-model="newSectionGroupId"
                :options="groupOptions"
                :placeholder="t('sectionEditor.groupSelectLabel')"
              />
            </div>
            <input
              v-model="newSectionName"
              type="text"
              :placeholder="t('sectionEditor.addSectionPlaceholder')"
              class="se-input"
              style="flex: 1; min-width: 0"
              @keydown.enter.prevent="onAddSection"
            />
            <button class="btn btn-primary" @click="onAddSection">{{ t('sectionEditor.addSection') }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Multi-select toolbar ── -->
    <div v-if="sectionMultiSelect" class="card se-toolbar-card">
      <div class="se-toolbar">
        <button class="btn" @click="store.toggleSectionMultiSelect()">{{ t('sectionEditor.cancelMultiSelect') }}</button>
        <button class="btn" @click="store.selectAllSectionDefs()">{{ t('sectionEditor.selectAll') }}</button>
        <button class="btn" @click="store.clearSectionSelection()">{{ t('sectionEditor.clearSelection') }}</button>
        <span class="se-toolbar-count">{{ t('sectionEditor.selectedCount', { count: selectedSectionDefIds.size }) }}</span>
        <div style="min-width: 160px; width: 180px">
          <SimpleSelect v-model="sectionBatchGroupId" :options="groupOptions" />
        </div>
        <button class="btn" @click="onApplyBatchGroup">{{ t('sectionEditor.batchGroup') }}</button>
        <button class="btn se-btn-delete" @click="onDeleteSelected">{{ t('sectionEditor.deleteSelected') }}</button>
      </div>
    </div>

    <!-- ── Activate multi-select (when not active) ── -->
    <div v-if="!sectionMultiSelect && sectionDefs.length > 0" class="se-toolbar-compact">
      <button class="btn btn-ghost" style="font-size: 12px" @click="store.toggleSectionMultiSelect()">
        {{ t('sectionEditor.multiSelect') }}
      </button>
    </div>

    <!-- ── Empty state ── -->
    <div v-if="!sectionDefs.length" class="card">
      <div class="empty">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div class="empty-text">{{ t('sectionEditor.noSections') }}</div>
      </div>
    </div>

    <!-- ── Grouped section list ── -->
    <template v-for="gw in groupedView" :key="gw.group?.id ?? '__ungrouped'">
      <div class="card se-group-card">
        <!-- Group header -->
        <div class="se-group-header" @click="toggleCollapse(gw.group?.id ?? null)">
          <div class="se-group-header-left">
            <span class="se-group-chevron" :class="{ collapsed: isCollapsed(gw.group?.id ?? null) }">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </span>
            <span v-if="gw.group" class="se-pill se-pill--group">{{ t('sectionEditor.groupLabel') }}</span>
            <span v-else class="se-pill se-pill--ungrouped">{{ t('sectionEditor.noGroup') }}</span>
            <!-- Inline group name edit -->
            <input
              v-if="gw.group"
              v-model="gw.group.name"
              class="se-group-name-input"
              @blur="autoSaveSectionGroup(gw.group!)"
              @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
              @click.stop
            />
            <span v-else class="se-group-name-static">{{ t('sectionEditor.noGroups') }}</span>
          </div>
          <div class="se-group-header-right">
            <span class="se-group-count">{{ gw.sections.length }} {{ t('sectionEditor.sectionLabel') }}</span>
            <span class="se-group-qcount">{{ gw.questionCount }} {{ t('sectionEditor.questions') }}</span>
            <!-- Group controls -->
            <template v-if="gw.group">
              <label class="se-toggle-label" @click.stop>
                <label class="toggle">
                  <input
                    type="checkbox"
                    :checked="gw.group.show_in_filter"
                    @change="gw.group.show_in_filter = ($event.target as HTMLInputElement).checked; autoSaveSectionGroup(gw.group!)"
                  />
                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                </label>
                <span class="se-toggle-text">{{ t('sectionEditor.showInFilter') }}</span>
              </label>
              <button class="btn btn-ghost btn-icon se-btn-delete-sm" v-tooltip="t('sectionEditor.delete')" @click.stop="onDeleteGroup(gw.group!)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </template>
          </div>
        </div>

        <!-- Sections under this group -->
        <div v-if="!isCollapsed(gw.group?.id ?? null)" class="se-section-list">
          <div v-if="!gw.sections.length" class="se-section-empty">
            {{ t('sectionEditor.noSectionsInGroup') }}
          </div>
          <div
            v-for="s in gw.sections"
            :key="s.id"
            class="se-section-row"
          >
            <AppCheckbox
              v-if="sectionMultiSelect"
              :model-value="selectedSectionDefIds.has(s.id)"
              style="flex-shrink: 0"
              @update:model-value="onToggleSectionSelect(s, $event)"
            />
            <input
              v-model="s.name"
              class="se-input se-section-name-input"
              @blur="autoSaveSectionDef(s)"
              @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
            />
            <!-- Color picker -->
            <div class="se-color-picker" @click.stop>
              <button
                class="se-color-swatch"
                :class="{ 'se-color-swatch--empty': !s.color }"
                :style="s.color ? { background: s.color } : undefined"
                v-tooltip="s.color || '设置颜色'"
                @click="openPickerFor(s)"
              ></button>
              <div v-if="openColorPicker === s.id" class="se-color-popover">
                <div class="se-color-preview" :style="{ background: pickerPreviewColor }"></div>
                <label class="se-color-label">
                  色相
                  <input
                    type="range" min="0" max="360" step="1"
                    v-model.number="pickerHue"
                    class="se-color-slider se-color-slider--hue"
                    @input="applyPickerColor(s)"
                  />
                </label>
                <label class="se-color-label">
                  饱和度
                  <input
                    type="range" min="0" max="100" step="1"
                    v-model.number="pickerSat"
                    class="se-color-slider"
                    :style="{ background: `linear-gradient(to right, hsl(${pickerHue},0%,${pickerLit}%), hsl(${pickerHue},100%,${pickerLit}%))` }"
                    @input="applyPickerColor(s)"
                  />
                </label>
                <label class="se-color-label">
                  亮度
                  <input
                    type="range" min="0" max="100" step="1"
                    v-model.number="pickerLit"
                    class="se-color-slider"
                    :style="{ background: `linear-gradient(to right, hsl(${pickerHue},${pickerSat}%,0%), hsl(${pickerHue},${pickerSat}%,50%), hsl(${pickerHue},${pickerSat}%,100%))` }"
                    @input="applyPickerColor(s)"
                  />
                </label>
                <div class="se-color-hex">{{ s.color || '未设置' }}</div>
                <button class="se-color-clear" @click="clearColor(s)">清除颜色</button>
              </div>
            </div>
            <div class="se-section-meta">
              <span class="se-section-qcount" :class="{ 'se-section-qcount--zero': !(sectionCounts[s.name] || 0) }">
                {{ sectionCounts[s.name] || 0 }} {{ t('sectionEditor.questions') }}
              </span>
            </div>
            <div style="min-width: 150px; width: 170px; flex-shrink: 0">
              <SimpleSelect
                :modelValue="s.group_id"
                :options="groupOptions"
                @change="(val: string | number | null) => onSectionDefGroupChange(s, val as number | null)"
              />
            </div>
            <button class="btn btn-ghost btn-icon se-btn-delete-sm" v-tooltip="t('sectionEditor.delete')" @click="onDeleteSection(s)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.section-editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 820px;
}

/* ── Header ── */
.se-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.se-subtitle {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.se-stats {
  display: flex;
  gap: 12px;
  flex-shrink: 0;
}

.se-stat {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  padding: 3px 10px;
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
  white-space: nowrap;
}

/* ── Add row ── */
.se-add-row {
  display: flex;
  gap: 16px;
  align-items: stretch;
}

.se-add-block {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.se-add-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.se-add-inputs {
  display: flex;
  align-items: center;
  gap: 8px;
}

.se-add-divider {
  width: 1px;
  background: var(--border);
  flex-shrink: 0;
  margin: 0 4px;
}

/* ── Input ── */
.se-input {
  padding: 7px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-primary);
  font-family: inherit;
  outline: none;
  transition: all var(--duration-fast) var(--ease-out);
}

.se-input:focus {
  background: var(--bg-elevated);
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* ── Toolbar ── */
.se-toolbar-card {
  padding: 12px 16px;
}

.se-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.se-toolbar-count {
  font-size: 12px;
  color: var(--text-tertiary);
}

.se-toolbar-compact {
  display: flex;
  justify-content: flex-end;
}

/* ── Group card ── */
.se-group-card {
  padding: 0;
  overflow: visible;
}

/* ── Group header ── */
.se-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  cursor: pointer;
  user-select: none;
  transition: background var(--duration-fast) var(--ease-out);
}

.se-group-header:hover {
  background: var(--bg-hover);
}

.se-group-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.se-group-header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.se-group-chevron {
  display: flex;
  align-items: center;
  color: var(--text-tertiary);
  transition: transform var(--duration-fast) var(--ease-out);
  flex-shrink: 0;
}

.se-group-chevron.collapsed {
  transform: rotate(-90deg);
}

.se-group-name-input {
  border: none;
  background: transparent;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  outline: none;
  padding: 2px 4px;
  border-radius: var(--radius-xs);
  min-width: 0;
  flex: 1;
}

.se-group-name-input:focus {
  background: var(--bg-input);
  border: 1px solid var(--border-accent);
}

.se-group-name-static {
  font-size: 13px;
  color: var(--text-tertiary);
  font-style: italic;
}

.se-group-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  padding: 2px 8px;
  background: var(--bg-hover);
  border-radius: var(--radius-xs);
  white-space: nowrap;
}

.se-group-qcount {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-tertiary);
  white-space: nowrap;
}

/* ── Pill badges ── */
.se-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 700;
  border-radius: var(--radius-xs);
  flex-shrink: 0;
  letter-spacing: 0.3px;
  text-transform: uppercase;
}

.se-pill--group {
  background: #eef2ff;
  color: #4338ca;
  border: 1px solid rgba(67, 56, 202, 0.2);
}

.se-pill--ungrouped {
  background: var(--bg-hover);
  color: var(--text-tertiary);
  border: 1px solid var(--border);
}

/* ── Section list ── */
.se-section-list {
  border-top: 1px solid var(--border);
  padding: 4px 0;
}

.se-section-empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--text-tertiary);
}

.se-section-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px 6px 40px;
  transition: background var(--duration-fast) var(--ease-out);
}

.se-section-row:hover {
  background: var(--bg-hover);
}

.se-section-name-input {
  flex: 1;
  min-width: 0;
  border: 1px solid transparent;
  background: transparent;
}

.se-section-name-input:hover {
  border-color: var(--border);
}

.se-section-name-input:focus {
  background: var(--bg-input);
  border-color: var(--border-accent);
}

.se-section-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.se-section-qcount {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.se-section-qcount--zero {
  opacity: 0.5;
}

/* ── Toggle label ── */
.se-toggle-label {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  cursor: pointer;
}

.se-toggle-text {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
}

/* ── Delete buttons ── */
.se-btn-delete {
  color: var(--danger);
}

.se-btn-delete:hover {
  background: rgba(255, 59, 48, 0.08);
  border-color: rgba(255, 59, 48, 0.2);
}

.se-btn-delete-sm {
  padding: 4px;
  min-width: 28px;
  min-height: 28px;
  color: var(--text-tertiary);
  opacity: 0.4;
  transition: all var(--duration-fast) var(--ease-out);
}

.se-section-row:hover .se-btn-delete-sm,
.se-group-header:hover .se-btn-delete-sm {
  opacity: 1;
}

.se-btn-delete-sm:hover {
  color: var(--danger);
  background: rgba(255, 59, 48, 0.08);
}

.btn-icon {
  padding: 4px;
  min-width: 28px;
  min-height: 28px;
}

/* ── Color picker ── */
.se-color-picker {
  position: relative;
  flex-shrink: 0;
}

.se-color-swatch {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid var(--border);
  cursor: pointer;
  transition: all 100ms;
  padding: 0;
}

.se-color-swatch:hover {
  border-color: var(--text-secondary);
  transform: scale(1.1);
}

.se-color-swatch--empty {
  background: var(--bg-hover);
  position: relative;
}

.se-color-swatch--empty::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 10px;
  height: 2px;
  background: var(--text-tertiary);
  transform: translate(-50%, -50%) rotate(-45deg);
  border-radius: 1px;
}

.se-color-popover {
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-top: 4px;
  padding: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.18);
  z-index: 100;
  width: 200px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.se-color-preview {
  width: 100%;
  height: 32px;
  border-radius: 6px;
  border: 1px solid var(--border);
}

.se-color-label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--text-tertiary);
  font-weight: 500;
}

.se-color-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 12px;
  border-radius: 6px;
  outline: none;
  cursor: pointer;
  border: 1px solid var(--border);
}

.se-color-slider--hue {
  background: linear-gradient(to right,
    hsl(0,100%,50%), hsl(30,100%,50%), hsl(60,100%,50%),
    hsl(90,100%,50%), hsl(120,100%,50%), hsl(150,100%,50%),
    hsl(180,100%,50%), hsl(210,100%,50%), hsl(240,100%,50%),
    hsl(270,100%,50%), hsl(300,100%,50%), hsl(330,100%,50%),
    hsl(360,100%,50%)
  );
}

.se-color-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: white;
  border: 2px solid var(--text-primary);
  box-shadow: 0 1px 4px rgba(0,0,0,0.2);
  cursor: grab;
}

.se-color-slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: white;
  border: 2px solid var(--text-primary);
  box-shadow: 0 1px 4px rgba(0,0,0,0.2);
  cursor: grab;
}

.se-color-hex {
  font-size: 11px;
  color: var(--text-secondary);
  text-align: center;
  font-family: monospace;
}

.se-color-clear {
  display: block;
  width: 100%;
  padding: 4px;
  font-size: 11px;
  color: var(--text-secondary);
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
}

.se-color-clear:hover {
  background: var(--bg-hover);
}

/* ── Toggle switch ── */
.toggle {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  cursor: pointer;
}

.toggle input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-track {
  width: 34px;
  height: 18px;
  background: var(--bg-pressed);
  border-radius: 9px;
  transition: background var(--duration-normal) var(--ease-out);
  position: relative;
  border: 1px solid var(--border);
}

.toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  background: white;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
  transition: transform var(--duration-normal) var(--ease-spring);
}

.toggle input:checked + .toggle-track {
  background: var(--accent);
  border-color: var(--accent);
}

.toggle input:checked + .toggle-track .toggle-thumb {
  transform: translateX(16px);
}

.toggle input:focus-visible + .toggle-track {
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* ── Empty state ── */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
}

.empty-icon {
  margin-bottom: 16px;
  opacity: 0.4;
  color: var(--text-secondary);
}

.empty-text {
  font-size: 14px;
  color: var(--text-secondary);
  max-width: 320px;
  line-height: 1.5;
}

/* ── Responsive ── */
@media (max-width: 640px) {
  .se-add-row {
    flex-direction: column;
  }
  .se-add-divider {
    width: 100%;
    height: 1px;
    margin: 4px 0;
  }
  .se-header {
    flex-direction: column;
  }
  .se-stats {
    flex-wrap: wrap;
  }
  .se-group-header {
    flex-wrap: wrap;
  }
  .se-group-header-right {
    flex-wrap: wrap;
  }
  .se-section-row {
    padding-left: 24px;
    flex-wrap: wrap;
  }
}
</style>
