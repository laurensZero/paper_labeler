<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  downloadOne,
  triggerZipDownload,
  fetchPapers,
  fetchSubjects,
  type PaperFile,
  type PaperType,
  type SubjectOption,
} from '@/lib/cieDownload'

const { t } = useI18n()
const ZIP_MAX = 30

const subjects = ref<SubjectOption[]>([])
const subjectsLoading = ref(false)
const subjectsError = ref('')

const subject = ref('')
const subjectOpen = ref(false)
const subjectQuery = ref('')
const subjectInput = ref<HTMLInputElement | null>(null)

const year = ref(String(new Date().getFullYear()))
const season = ref<'Mar' | 'Jun' | 'Nov'>('Mar')
const typeFilter = ref<Set<string>>(new Set())
const search = ref('')

const files = ref<PaperFile[]>([])
const loading = ref(false)
const loadError = ref('')
const loaded = ref(false)

const selected = ref<Set<string>>(new Set())
const busyFile = ref('')
const toast = ref('')

const YEARS = (() => {
  const y = new Date().getFullYear()
  return Array.from({ length: 12 }, (_, i) => String(y - i))
})()
const SEASONS = ['Mar', 'Jun', 'Nov'] as const
const TYPES = ['qp', 'ms', 'er', 'gt'] as const

const selectedSubject = computed(
  () => subjects.value.find((s) => s.value === subject.value) || null,
)

const subjectDisplay = computed(() => {
  const s = selectedSubject.value
  if (!s) return subject.value || ''
  return s.label || `${s.value} · ${s.title}` || s.value
})

const filteredSubjects = computed(() => {
  const q = subjectQuery.value.trim().toLowerCase()
  if (!q) return subjects.value
  return subjects.value.filter(
    (s) =>
      s.value.toLowerCase().includes(q) ||
      s.title.toLowerCase().includes(q) ||
      s.label.toLowerCase().includes(q),
  )
})

const visibleFiles = computed(() => {
  const q = search.value.trim().toLowerCase()
  return files.value.filter((f) => {
    if (typeFilter.value.size && !typeFilter.value.has(f.type)) return false
    if (q && !f.filename.toLowerCase().includes(q) && !f.label.toLowerCase().includes(q))
      return false
    return true
  })
})

const rows = computed(() => {
  const rank: Record<PaperType, number> = { qp: 0, ms: 1, er: 2, gt: 3, other: 4 }
  return [...visibleFiles.value].sort((a, b) => {
    const pa = a.paper ?? 99
    const pb = b.paper ?? 99
    if (pa !== pb) return pa - pb
    const va = a.variant ?? 0
    const vb = b.variant ?? 0
    if (va !== vb) return va - vb
    return rank[a.type] - rank[b.type] || a.filename.localeCompare(b.filename)
  })
})

const selectedList = computed(() => files.value.filter((f) => selected.value.has(f.filename)))

const allVisibleSelected = computed(
  () => rows.value.length > 0 && rows.value.every((f) => selected.value.has(f.filename)),
)

const statsText = computed(() => {
  const n = rows.value.length
  const sel = selected.value.size
  return sel ? t('download.statsSelected', { n, sel }) : t('download.stats', { n })
})

const seasonLabel = computed(() => t(`download.season.${season.value}`))

function showToast(msg: string) {
  toast.value = msg
  window.setTimeout(() => {
    if (toast.value === msg) toast.value = ''
  }, 3200)
}

function toggleSelect(filename: string) {
  const next = new Set(selected.value)
  if (next.has(filename)) next.delete(filename)
  else next.add(filename)
  selected.value = next
}

function toggleSelectAll() {
  const next = new Set(selected.value)
  if (allVisibleSelected.value) {
    for (const f of rows.value) next.delete(f.filename)
  } else {
    for (const f of rows.value) next.add(f.filename)
  }
  selected.value = next
}

function toggleType(type: string) {
  const next = new Set(typeFilter.value)
  if (next.has(type)) next.delete(type)
  else next.add(type)
  typeFilter.value = next
}

function clearTypes() {
  typeFilter.value = new Set()
}

function clearSelected() {
  selected.value = new Set()
}

function openSubject() {
  subjectOpen.value = true
  subjectQuery.value = ''
  requestAnimationFrame(() => subjectInput.value?.focus())
}

function closeSubject() {
  subjectOpen.value = false
  subjectQuery.value = ''
}

function pickSubject(value: string) {
  subject.value = value
  closeSubject()
}

function onSubjectKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeSubject()
  if (e.key === 'Enter') {
    const first = filteredSubjects.value[0]
    if (first) pickSubject(first.value)
  }
}

function onDocClick(e: MouseEvent) {
  const el = e.target as HTMLElement | null
  if (el?.closest('.dl-combo')) return
  closeSubject()
}

async function loadSubjects() {
  subjectsLoading.value = true
  subjectsError.value = ''
  try {
    subjects.value = await fetchSubjects()
    if (!subject.value && subjects.value.length) {
      const math = subjects.value.find((s) => s.value === '9709') || subjects.value[0]
      subject.value = math.value
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    subjectsError.value = `${t('download.loadSubjectsFail')}：${detail}`
  } finally {
    subjectsLoading.value = false
  }
}

async function loadPapers() {
  if (!subject.value || !year.value || !season.value) {
    files.value = []
    loaded.value = false
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    files.value = await fetchPapers(subject.value, year.value, season.value)
    loaded.value = true
  } catch (e) {
    const detail = e instanceof Error ? e.message : ''
    loadError.value = detail ? `${t('download.loadFail')}：${detail}` : t('download.loadFail')
    files.value = []
  } finally {
    loading.value = false
  }
}

async function onDownload(file: PaperFile) {
  if (busyFile.value) return
  busyFile.value = file.filename
  try {
    // 直链下载，兼容 IDM（不走 fetch+blob）
    downloadOne(file)
    showToast(t('download.done', { name: file.filename }))
  } catch {
    showToast(t('download.loadFail'))
  } finally {
    // 给下载器一点时间接管
    window.setTimeout(() => {
      busyFile.value = ''
    }, 600)
  }
}

function onZip() {
  if (!selectedList.value.length) return
  if (selectedList.value.length > ZIP_MAX) {
    showToast(t('download.zipLimit', { max: ZIP_MAX }))
    return
  }
  try {
    triggerZipDownload(selectedList.value)
    showToast(t('download.zipDone', { n: selectedList.value.length }))
    clearSelected()
  } catch {
    showToast(t('download.loadFail'))
  }
}

watch([subject, year, season], () => {
  clearSelected()
  void loadPapers()
})

onMounted(() => {
  document.addEventListener('click', onDocClick)
  void loadSubjects()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <div class="dl">
    <header class="dl-head">
      <div class="dl-head-main">
        <h1 class="dl-title">{{ t('download.title') }}</h1>
        <p class="dl-sub">
          {{ selectedSubject ? selectedSubject.title : '—' }}
          · {{ year }} · {{ seasonLabel }}
        </p>
      </div>
      <div class="dl-head-meta">
        <span class="dl-stats">{{ statsText }}</span>
      </div>
    </header>

    <!-- 筛选 -->
    <div class="dl-bar">
      <div class="dl-field">
        <label class="dl-label">{{ t('download.subject') }}</label>
        <div class="dl-combo" :class="{ open: subjectOpen }">
          <button
            type="button"
            class="dl-combo-btn"
            :disabled="subjectsLoading"
            @click="subjectOpen ? closeSubject() : openSubject()"
          >
            <span class="dl-combo-text" :title="subjectDisplay">
              <b v-if="selectedSubject" class="dl-combo-code">{{ selectedSubject.value }}</b>
              <span class="dl-combo-name">
                {{ subjectsLoading ? t('download.loading') : (selectedSubject?.title || selectedSubject?.label || subject || t('download.subjectPh')) }}
              </span>
            </span>
            <span class="dl-combo-caret" aria-hidden="true" />
          </button>

          <div v-if="subjectOpen" class="dl-combo-panel">
            <input
              ref="subjectInput"
              v-model="subjectQuery"
              class="dl-combo-search"
              type="search"
              :placeholder="t('download.subjectPh')"
              @keydown="onSubjectKey"
            />
            <ul class="dl-combo-list">
              <li v-if="subjectsLoading" class="dl-combo-empty">{{ t('download.loading') }}</li>
              <li v-else-if="!filteredSubjects.length" class="dl-combo-empty">
                {{ t('download.empty') }}
              </li>
              <li
                v-for="s in filteredSubjects"
                :key="s.value"
                class="dl-combo-item"
                :class="{ on: s.value === subject }"
                @click="pickSubject(s.value)"
              >
                <b>{{ s.value }}</b>
                <span>{{ s.title }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div class="dl-field">
        <label class="dl-label">{{ t('download.year') }}</label>
        <select v-model="year" class="dl-select">
          <option v-for="y in YEARS" :key="y" :value="y">{{ y }}</option>
        </select>
      </div>

      <div class="dl-field">
        <label class="dl-label">{{ t('download.seasonLabel') }}</label>
        <div class="dl-seg">
          <button
            v-for="s in SEASONS"
            :key="s"
            type="button"
            class="dl-seg-btn"
            :class="{ on: season === s }"
            @click="season = s"
          >
            {{ t('download.season.' + s) }}
          </button>
        </div>
      </div>

      <div class="dl-field dl-field-grow">
        <label class="dl-label">{{ t('download.search') }}</label>
        <input
          v-model="search"
          class="dl-input"
          type="search"
          :placeholder="t('download.searchPh')"
        />
      </div>

      <div class="dl-types">
        <button
          type="button"
          class="dl-chip"
          :class="{ on: !typeFilter.size }"
          @click="clearTypes"
        >
          {{ t('download.typeAll') }}
        </button>
        <button
          v-for="ty in TYPES"
          :key="ty"
          type="button"
          class="dl-chip"
          :class="[{ on: typeFilter.has(ty) }, 'dl-chip-' + ty]"
          @click="toggleType(ty)"
        >
          {{ t('download.type.' + ty) }}
        </button>
      </div>
    </div>

    <div v-if="subjectsError" class="dl-err-line">{{ subjectsError }}</div>

    <!-- 列表 -->
    <div v-if="loading" class="dl-skeleton">
      <div v-for="i in 8" :key="i" class="dl-skel-row" />
    </div>

    <div v-else-if="loadError" class="dl-state">
      <p class="dl-err-line">{{ loadError }}</p>
      <button type="button" class="btn dl-btn-accent" @click="loadPapers">
        {{ t('download.retry') }}
      </button>
    </div>

    <div v-else-if="!loaded" class="dl-state muted">
      {{ t('download.needSelect') }}
    </div>

    <div v-else-if="!rows.length" class="dl-state">
      <div class="dl-empty-icon">PDF</div>
      <p class="dl-empty-title">{{ t('download.empty') }}</p>
      <p class="muted">{{ t('download.emptyHint') }}</p>
    </div>

    <div v-else class="dl-list-wrap">
      <table class="dl-list">
        <thead>
          <tr>
            <th class="col-check">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :aria-label="t('download.select')"
                @change="toggleSelectAll"
              />
            </th>
            <th class="col-type">{{ t('download.typeFilter') }}</th>
            <th class="col-paper">Paper</th>
            <th class="col-var">Var</th>
            <th class="col-name">{{ t('download.search') }}</th>
            <th class="col-act"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="f in rows"
            :key="f.filename"
            :class="{ sel: selected.has(f.filename), ['type-' + f.type]: true }"
            @click="toggleSelect(f.filename)"
          >
            <td class="col-check" @click.stop>
              <input
                type="checkbox"
                :checked="selected.has(f.filename)"
                :aria-label="f.filename"
                @change="toggleSelect(f.filename)"
              />
            </td>
            <td class="col-type">
              <span class="dl-badge" :class="'dl-type-' + f.type">
                {{ t('download.type.' + f.type) }}
              </span>
            </td>
            <td class="col-paper">
              <template v-if="f.paper != null">{{ f.paper }}</template>
              <template v-else>—</template>
            </td>
            <td class="col-var">
              <template v-if="f.variant != null">{{ f.variant }}</template>
              <template v-else>—</template>
            </td>
            <td class="col-name" :title="f.filename">
              <span class="dl-filename">{{ f.filename }}</span>
            </td>
            <td class="col-act" @click.stop>
              <button
                type="button"
                class="btn dl-btn-accent btn-sm"
                :disabled="busyFile === f.filename"
                @click="onDownload(f)"
              >
                {{ busyFile === f.filename ? t('download.downloading') : t('download.download') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <transition name="dl-dock">
      <div v-if="selected.size" class="dl-dock">
        <div class="dl-dock-info">
          <strong>{{ t('download.selectedCount', { n: selected.size }) }}</strong>
          <span v-if="selected.size > ZIP_MAX" class="dl-warn">
            {{ t('download.zipLimit', { max: ZIP_MAX }) }}
          </span>
        </div>
        <div class="dl-dock-actions">
          <button type="button" class="btn btn-ghost" @click="clearSelected">
            {{ t('download.clear') }}
          </button>
          <button
            type="button"
            class="btn dl-btn-accent"
            :disabled="selected.size > ZIP_MAX"
            @click="onZip"
          >
            {{ t('download.zip') }}
          </button>
        </div>
      </div>
    </transition>

    <transition name="dl-toast">
      <div v-if="toast" class="dl-toast">{{ toast }}</div>
    </transition>
  </div>
</template>

<style scoped>
.dl {
  max-width: 1080px;
  margin: 0 auto;
  padding-bottom: 100px;
}

.dl-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin: 4px 0 14px;
}

.dl-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-primary);
  line-height: 1.25;
}

.dl-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.dl-stats {
  font-size: 12px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* ── 筛选条 ── */
.dl-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 14px;
  align-items: flex-end;
  background: var(--bg-card);
  border: 1px solid var(--border, #e4e4e8);
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 10px;
  position: sticky;
  top: 56px;
  z-index: 30;
}

.dl-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 110px;
}

.dl-field-grow {
  flex: 1;
  min-width: 150px;
}

.dl-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  letter-spacing: 0.02em;
}

.dl-input,
.dl-select {
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--border, #e4e4e8);
  background: var(--bg-input, #f0f0f2);
  color: var(--text-primary);
  padding: 0 10px;
  font: inherit;
  font-size: 13px;
  outline: none;
  min-width: 110px;
}

.dl-input:focus,
.dl-select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

/* ── 科目 Combobox ── */
.dl-combo {
  position: relative;
  min-width: 260px;
}

.dl-combo-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 0 10px 0 12px;
  border-radius: 8px;
  border: 1px solid var(--border, #e4e4e8);
  background: var(--bg-input, #f0f0f2);
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

.dl-combo-btn:hover {
  border-color: #cfd6e0;
}

.dl-combo.open .dl-combo-btn {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
  background: var(--bg-card);
}

.dl-combo-text {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.dl-combo-code {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
  flex-shrink: 0;
}

.dl-combo-name {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-combo-caret {
  width: 8px;
  height: 8px;
  border-right: 1.5px solid var(--text-tertiary);
  border-bottom: 1.5px solid var(--text-tertiary);
  transform: rotate(45deg) translateY(-2px);
  flex-shrink: 0;
}

.dl-combo-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  min-width: 320px;
  background: var(--bg-card);
  border: 1px solid var(--border, #e4e4e8);
  border-radius: 10px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.14);
  overflow: hidden;
  z-index: 40;
}

.dl-combo-search {
  width: 100%;
  height: 36px;
  border: 0;
  border-bottom: 1px solid var(--border, #e4e4e8);
  padding: 0 12px;
  font: inherit;
  font-size: 13px;
  background: var(--bg-card);
  color: var(--text-primary);
  outline: none;
}

.dl-combo-list {
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 280px;
  overflow: auto;
}

.dl-combo-item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.dl-combo-item:hover,
.dl-combo-item.on {
  background: var(--accent-soft);
}

.dl-combo-item b {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  min-width: 3.2em;
  color: var(--text-primary);
}

.dl-combo-item span {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-combo-empty {
  padding: 14px 12px;
  color: var(--text-tertiary);
  font-size: 12px;
  text-align: center;
}

/* ── 考季分段 ── */
.dl-seg {
  display: flex;
  background: var(--bg-input, #f0f0f2);
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
  height: 36px;
  box-sizing: border-box;
}

.dl-seg-btn {
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.dl-seg-btn:hover {
  color: var(--text-primary);
}

.dl-seg-btn.on {
  background: var(--bg-card);
  color: var(--text-primary);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.dl-types {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding-bottom: 4px;
}

.dl-chip {
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--border, #e4e4e8);
  background: var(--bg-card);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.dl-chip:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.dl-chip.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.dl-chip-qp.on {
  background: #2070c0;
  border-color: #2070c0;
}
.dl-chip-ms.on {
  background: #2f6b4f;
  border-color: #2f6b4f;
}
.dl-chip-er.on {
  background: #8a6d1f;
  border-color: #8a6d1f;
}
.dl-chip-gt.on {
  background: #6b5b8a;
  border-color: #6b5b8a;
}

.dl-err-line {
  color: #c0392b;
  font-size: 12px;
  margin: 0 0 10px;
}

/* ── 列表 ── */
.dl-list-wrap {
  background: var(--bg-card);
  border: 1px solid var(--border, #e4e4e8);
  border-radius: 12px;
  overflow: auto;
  max-height: calc(100vh - 300px);
}

.dl-list {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.dl-list thead th {
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--bg-input, #f0f0f2);
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #e4e4e8);
  white-space: nowrap;
}

.dl-list tbody tr {
  cursor: pointer;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
  transition: background 0.12s ease;
  box-shadow: inset 3px 0 0 transparent;
}

.dl-list tbody tr:last-child {
  border-bottom: 0;
}

.dl-list tbody tr:hover {
  background: var(--bg-hover);
}

.dl-list tbody tr.sel {
  background: var(--accent-soft);
}

.dl-list tbody tr.type-qp {
  box-shadow: inset 3px 0 0 #2070c0;
}
.dl-list tbody tr.type-ms {
  box-shadow: inset 3px 0 0 #2f6b4f;
}
.dl-list tbody tr.type-er {
  box-shadow: inset 3px 0 0 #8a6d1f;
}
.dl-list tbody tr.type-gt {
  box-shadow: inset 3px 0 0 #6b5b8a;
}

.dl-list td {
  padding: 9px 12px;
  vertical-align: middle;
  color: var(--text-primary);
}

.col-check {
  width: 36px;
  padding-left: 14px !important;
}

.col-type {
  width: 96px;
}

.col-paper {
  width: 56px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  text-align: center;
}

.col-var {
  width: 48px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  text-align: center;
}

.col-name {
  min-width: 0;
}

.col-act {
  width: 88px;
  text-align: right;
  padding-right: 14px !important;
}

/* 与全局 accent 一致的主操作按钮（非黑色 btn-primary） */
.dl-btn-accent {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(32, 112, 192, 0.22);
}

.dl-btn-accent:hover:not(:disabled) {
  background: var(--accent-hover, #1a5ea8);
  border-color: var(--accent-hover, #1a5ea8);
  color: #fff;
}

.dl-btn-accent:active:not(:disabled) {
  background: var(--accent-hover, #1a5ea8);
}

.dl-btn-accent:disabled {
  opacity: 0.55;
}

.dl-filename {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--text-primary);
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-badge {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.dl-type-qp {
  background: rgba(32, 112, 192, 0.12);
  color: #2070c0;
}
.dl-type-ms {
  background: #dcebe3;
  color: #2f6b4f;
}
.dl-type-er {
  background: #f3ecd4;
  color: #8a6d1f;
}
.dl-type-gt {
  background: #ebe6f4;
  color: #6b5b8a;
}

.dl-skeleton {
  display: flex;
  flex-direction: column;
  gap: 1px;
  background: var(--bg-card);
  border: 1px solid var(--border, #e4e4e8);
  border-radius: 12px;
  overflow: hidden;
}

.dl-skel-row {
  height: 44px;
  background: var(--bg-hover);
  animation: dl-pulse 1.2s ease-in-out infinite;
}

.dl-skel-row:nth-child(odd) {
  background: var(--bg-input);
}

@keyframes dl-pulse {
  0%,
  100% {
    opacity: 0.55;
  }
  50% {
    opacity: 1;
  }
}

.dl-state {
  text-align: center;
  padding: 48px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border, #e4e4e8);
  border-radius: 12px;
  color: var(--text-primary);
}

.dl-state.muted {
  color: var(--text-tertiary);
}

.dl-empty-icon {
  width: 48px;
  height: 48px;
  margin: 0 auto 12px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.dl-empty-title {
  margin: 0 0 4px;
  font-weight: 600;
}

.dl-dock {
  position: fixed;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 12px 10px 16px;
  background: var(--bg-card, #fff);
  color: var(--text-primary);
  border: 1px solid var(--border, rgba(17, 20, 22, 0.08));
  border-radius: var(--radius-lg, 18px);
  box-shadow: var(--shadow, 0 8px 24px rgba(0, 0, 0, 0.08));
  z-index: 50;
  max-width: calc(100vw - 32px);
}

.dl-dock-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}

.dl-dock-info strong {
  color: var(--text-primary);
  font-weight: 600;
}

.dl-warn {
  font-size: 11px;
  color: var(--danger, #c0392b);
}

.dl-dock-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.dl-toast {
  position: fixed;
  top: 68px;
  right: 18px;
  background: var(--bg-card);
  color: var(--text-primary);
  border: 1px solid var(--border, #e4e4e8);
  border-radius: 10px;
  padding: 10px 14px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12);
  z-index: 60;
  font-size: 13px;
  max-width: min(360px, calc(100vw - 40px));
}

.dl-dock-enter-active,
.dl-dock-leave-active,
.dl-toast-enter-active,
.dl-toast-leave-active {
  transition:
    opacity 0.2s,
    transform 0.2s;
}

.dl-dock-enter-from,
.dl-dock-leave-to {
  opacity: 0;
  transform: translate(-50%, 12px);
}

.dl-toast-enter-from,
.dl-toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

@media (max-width: 720px) {
  .dl-head {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .dl-bar {
    position: static;
  }

  .dl-combo {
    min-width: 100%;
  }

  .dl-combo-panel {
    min-width: 0;
  }

  .dl-title {
    font-size: 20px;
  }

  .col-var {
    display: none;
  }

  .dl-list td,
  .dl-list th {
    padding: 8px;
  }

  .dl-dock {
    left: 12px;
    right: 12px;
    transform: none;
    width: auto;
  }

  .dl-dock-enter-from,
  .dl-dock-leave-to {
    transform: translateY(12px);
  }
}
</style>
