<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useSectionsStore } from '@/stores/sections'
import SimpleSelect from '@/components/ui/SimpleSelect.vue'
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

/* ── Sorted sections by group order ── */
const sectionDefsGroupedSorted = computed(() => {
  const defs = sectionDefs.value.slice()
  if (!defs.length) return []
  const groups = sectionGroups.value
  const order = new Map<number | null, number>()
  order.set(null, -1)
  groups.forEach((g, idx) => {
    order.set(g?.id ?? null, idx)
  })
  defs.sort((a, b) => {
    const ga = a?.group_id ?? null
    const gb = b?.group_id ?? null
    const oa = order.has(ga) ? order.get(ga)! : 9999
    const ob = order.has(gb) ? order.get(gb)! : 9999
    if (oa !== ob) return oa - ob
    return (Number(b?.id) || 0) - (Number(a?.id) || 0)
  })
  return defs
})

/* ── Group options for SimpleSelect ── */
const groupOptions = computed(() => [
  { value: null, label: t('sectionEditor.noGroup') },
  ...sectionGroups.value.map(g => ({ value: g.id, label: g.name })),
])

/* ── Add section group ── */
function onAddGroup() {
  store.createSectionGroup(newSectionGroupName.value)
}

/* ── Add section ── */
function onAddSection() {
  store.createSectionDef(newSectionName.value, '', newSectionGroupId.value)
}

/* ── Auto-save section group on blur/enter ── */
function autoSaveSectionGroup(g: SectionGroup) {
  const nameChanged = g.name !== (g as any).__lastSavedName
  const showChanged = g.show_in_filter !== (g as any).__lastSavedShow
  if (nameChanged || showChanged) {
    store.updateSectionGroup(g)
  }
}

/* ── Auto-save section def on blur/enter ── */
function autoSaveSectionDef(s: SectionDef) {
  const nameChanged = s.name !== (s as any).__lastSavedName
  const groupChanged = s.group_id !== (s as any).__lastSavedGroupId
  if (nameChanged || groupChanged) {
    store.updateSectionDef(s)
  }
}

/* ── Section group change via SimpleSelect ── */
function onSectionDefGroupChange(s: SectionDef, val: number | null) {
  s.group_id = val
  autoSaveSectionDef(s)
}

/* ── Toggle checkbox for a single section ── */
function onToggleSectionSelect(s: SectionDef, e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  store.toggleSectionSelection(s.id, checked)
}

/* ── Batch group change ── */
function onApplyBatchGroup() {
  store.applyBatchSectionGroup()
}

/* ── Delete (store already confirms) ── */
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
})
</script>

<template>
  <div style="max-width: 780px">
    <h2 style="font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 4px">
      {{ t('sectionEditor.title') }}
    </h2>
    <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 20px">
      {{ t('sectionEditor.subtitle') }}
    </p>

    <!-- ── Add Group ── -->
    <div class="card">
      <div class="card-title">{{ t('sectionEditor.addGroup') }}</div>
      <div style="display: flex; align-items: center; gap: 10px">
        <input
          v-model="newSectionGroupName"
          type="text"
          :placeholder="t('sectionEditor.addGroupPlaceholder')"
          class="se-input"
          style="flex: 1; max-width: 320px"
          @keydown.enter.prevent="onAddGroup"
        />
        <button class="btn btn-primary" @click="onAddGroup">
          {{ t('sectionEditor.addGroup') }}
        </button>
      </div>
    </div>

    <!-- ── Add Section ── -->
    <div class="card">
      <div class="card-title">{{ t('sectionEditor.addSection') }}</div>
      <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
        <div style="min-width: 180px; width: 200px">
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
          style="flex: 1; min-width: 200px; max-width: 320px"
          @keydown.enter.prevent="onAddSection"
        />
        <button class="btn btn-primary" @click="onAddSection">
          {{ t('sectionEditor.addSection') }}
        </button>
      </div>
    </div>

    <!-- ── Section Groups List ── -->
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px">
        <div class="card-title" style="margin-bottom: 0">{{ t('sectionEditor.groupLabel') }}</div>
        <span style="font-size: 12px; color: var(--text-tertiary)">{{ t('sectionEditor.showInFilterHint') }}</span>
      </div>

      <div v-if="!sectionGroups.length" style="padding: 20px 0; text-align: center; color: var(--text-tertiary); font-size: 13px">
        {{ t('sectionEditor.noGroups') }}
      </div>

      <div v-else style="display: flex; flex-direction: column; gap: 0">
        <div
          v-for="g in sectionGroups"
          :key="g.id"
          class="se-row"
        >
          <span class="se-pill se-pill--group">{{ t('sectionEditor.groupLabel') }}</span>
          <input
            v-model="g.name"
            class="se-input"
            style="flex: 1; min-width: 0"
            @blur="autoSaveSectionGroup(g)"
            @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
          />
          <label class="se-toggle-label">
            <label class="toggle">
              <input
                type="checkbox"
                :checked="g.show_in_filter"
                @change="g.show_in_filter = ($event.target as HTMLInputElement).checked; autoSaveSectionGroup(g)"
              />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
            <span class="se-toggle-text">{{ t('sectionEditor.showInFilter') }}</span>
          </label>
          <button class="btn btn-ghost se-btn-delete" @click="onDeleteGroup(g)">
            {{ t('sectionEditor.delete') }}
          </button>
        </div>
      </div>
    </div>

    <!-- ── Multi-select toolbar ── -->
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px">
        <div class="card-title" style="margin-bottom: 0">{{ t('sectionEditor.sectionLabel') }}</div>
        <span style="font-size: 12px; color: var(--text-tertiary)">{{ t('sectionEditor.sectionsBelongToGroup') }}</span>
      </div>

      <div class="se-toolbar">
        <button class="btn" @click="store.toggleSectionMultiSelect()">
          {{ sectionMultiSelect ? t('sectionEditor.cancelMultiSelect') : t('sectionEditor.multiSelect') }}
        </button>
        <template v-if="sectionMultiSelect">
          <button class="btn" @click="store.selectAllSectionDefs()">
            {{ t('sectionEditor.selectAll') }}
          </button>
          <button class="btn" @click="store.clearSectionSelection()">
            {{ t('sectionEditor.clearSelection') }}
          </button>
          <span style="font-size: 12px; color: var(--text-tertiary)">
            {{ t('sectionEditor.selectedCount', { count: selectedSectionDefIds.size }) }}
          </span>
          <div style="min-width: 180px; width: 200px">
            <SimpleSelect
              v-model="sectionBatchGroupId"
              :options="groupOptions"
            />
          </div>
          <button class="btn" @click="onApplyBatchGroup">
            {{ t('sectionEditor.batchGroup') }}
          </button>
          <button class="btn se-btn-delete" @click="onDeleteSelected">
            {{ t('sectionEditor.deleteSelected') }}
          </button>
        </template>
      </div>

      <!-- ── Sections List ── -->
      <div v-if="!sectionDefs.length" style="padding: 20px 0; text-align: center; color: var(--text-tertiary); font-size: 13px">
        {{ t('sectionEditor.noSections') }}
      </div>

      <div v-else class="se-section-list">
        <div
          v-for="s in sectionDefsGroupedSorted"
          :key="s.id"
          class="se-row"
        >
          <input
            v-if="sectionMultiSelect"
            type="checkbox"
            :checked="selectedSectionDefIds.has(s.id)"
            style="flex-shrink: 0"
            @change="onToggleSectionSelect(s, $event)"
          />
          <span class="se-pill se-pill--section">{{ t('sectionEditor.sectionLabel') }}</span>
          <div style="min-width: 160px; width: 180px; flex-shrink: 0">
            <SimpleSelect
              :modelValue="s.group_id"
              :options="groupOptions"
              @change="(val: number | null) => onSectionDefGroupChange(s, val)"
            />
          </div>
          <input
            v-model="s.name"
            class="se-input"
            style="flex: 1; min-width: 0; margin-left: 8px"
            @blur="autoSaveSectionDef(s)"
            @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
          />
          <button class="btn btn-ghost se-btn-delete" @click="onDeleteSection(s)">
            {{ t('sectionEditor.delete') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
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

/* ── Row ── */
.se-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}

.se-row:last-child {
  border-bottom: none;
}

/* ── Pill badges ── */
.se-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: var(--radius-xs);
  flex-shrink: 0;
  letter-spacing: 0.3px;
}

.se-pill--group {
  background: #eef2ff;
  color: #4338ca;
  border: 1px solid rgba(67, 56, 202, 0.2);
}

.se-pill--section {
  background: #ecfeff;
  color: #0f766e;
  border: 1px solid rgba(13, 148, 136, 0.2);
}

/* ── Toolbar ── */
.se-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}

/* ── Delete button ── */
.se-btn-delete {
  color: var(--danger);
  flex-shrink: 0;
}

.se-btn-delete:hover {
  background: rgba(255, 59, 48, 0.08);
  border-color: rgba(255, 59, 48, 0.2);
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
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

/* ── Section list scrollable ── */
.se-section-list {
  max-height: 480px;
  overflow-y: auto;
}

/* ── Toggle switch (from SettingsView) ── */
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
  width: 40px;
  height: 22px;
  background: var(--bg-pressed);
  border-radius: 11px;
  transition: background var(--duration-normal) var(--ease-out);
  position: relative;
  border: 1px solid var(--border);
}

.toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: white;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15), 0 0 1px rgba(0, 0, 0, 0.06);
  transition: transform var(--duration-normal) var(--ease-spring);
}

.toggle input:checked + .toggle-track {
  background: var(--accent);
  border-color: var(--accent);
}

.toggle input:checked + .toggle-track .toggle-thumb {
  transform: translateX(18px);
}

.toggle input:focus-visible + .toggle-track {
  box-shadow: 0 0 0 3px var(--accent-soft);
}
</style>
