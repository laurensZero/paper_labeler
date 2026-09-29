<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  cellDisplayValue,
  cellKey,
  fetchPapersForRadar,
  formatYearToken,
  groupPapersBySubject,
  loadSubjectRadar,
  maxCellDisplayValue,
  type HeatCell,
  type HeatValueMode,
  type PaperLite,
  type SubjectPill,
  type SubjectRadar,
} from '@/lib/radar'

const { t } = useI18n()
const router = useRouter()

// ── 科目 ──
const papers = ref<PaperLite[]>([])
const subjects = ref<SubjectPill[]>([])
const activeSubject = ref('')
const loading = ref(false)
const loadError = ref('')

// ── 筛选 / 显示 ──
const seasonFilter = ref<string[]>([]) // 空 = 全部
const heatMode = ref<HeatValueMode>('count')
const radar = ref<SubjectRadar | null>(null)
const selected = ref<{ section: string; year: string } | null>(null)

const SEASONS = ['m', 's', 'w'] as const

const yearsInView = computed(() => radar.value?.years ?? [])
const sectionsInView = computed(() => radar.value?.sections ?? [])
const maxVal = computed(() =>
  radar.value ? maxCellDisplayValue(radar.value, heatMode.value) : 0,
)

function cellOf(section: string, year: string): HeatCell | null {
  return radar.value?.cells.get(cellKey(section, year)) ?? null
}

function cellVal(section: string, year: string): number {
  const c = cellOf(section, year)
  if (!c) return 0
  return cellDisplayValue(c.count, c.difficulties, heatMode.value)
}

function cellAlpha(section: string, year: string): number {
  const v = cellVal(section, year)
  if (v <= 0 || maxVal.value <= 0) return 0
  // 0.12 ~ 0.92，保证空格仍可读
  return 0.12 + (v / maxVal.value) * 0.8
}

function isSelected(section: string, year: string): boolean {
  return selected.value?.section === section && selected.value?.year === year
}

function selectCell(section: string, year: string) {
  selected.value = { section, year }
}

const selectedCell = computed(() => {
  if (!selected.value || !radar.value) return null
  return cellOf(selected.value.section, selected.value.year)
})

const selectedQuestionIds = computed(() => selectedCell.value?.questionIds ?? [])

// ── 趋势 / 占比 ──
const yearTotalList = computed(() => {
  if (!radar.value) return []
  return radar.value.years.map((y) => ({
    year: y,
    label: formatYearToken(y),
    total: radar.value!.yearTotals.get(y) ?? 0,
  }))
})

const maxYearTotal = computed(() =>
  Math.max(1, ...yearTotalList.value.map((x) => x.total)),
)

const sectionShareList = computed(() => {
  if (!radar.value) return []
  const total = Math.max(1, radar.value.totalQuestions)
  return radar.value.sections.slice(0, 12).map((s) => {
    const n = radar.value!.sectionTotals.get(s) ?? 0
    return {
      section: s,
      count: n,
      pct: Math.round((n / total) * 100),
    }
  })
})

const overdueList = computed(() => radar.value?.overdue ?? [])

// ── 数据加载 ──
let loadToken = 0

async function loadRadar() {
  const subject = activeSubject.value
  if (!subject) {
    radar.value = null
    return
  }
  const token = ++loadToken
  loading.value = true
  loadError.value = ''
  try {
    const data = await loadSubjectRadar(subject, papers.value, seasonFilter.value)
    if (token !== loadToken) return
    radar.value = data
    // 选中格若已不在结果中则清空
    if (selected.value) {
      const still = data.cells.has(cellKey(selected.value.section, selected.value.year))
      if (!still) selected.value = null
    }
  } catch (e) {
    if (token !== loadToken) return
    loadError.value = e instanceof Error ? e.message : String(e)
    radar.value = null
  } finally {
    if (token === loadToken) loading.value = false
  }
}

function pickDefaultSubject() {
  if (!subjects.value.length) {
    activeSubject.value = ''
    return
  }
  if (!subjects.value.some((s) => s.subject === activeSubject.value)) {
    activeSubject.value = subjects.value[0].subject
  }
}

function setSubject(code: string) {
  if (activeSubject.value === code) return
  activeSubject.value = code
  selected.value = null
}

function toggleSeason(s: string) {
  const i = seasonFilter.value.indexOf(s)
  if (i >= 0) seasonFilter.value.splice(i, 1)
  else seasonFilter.value.push(s)
}

function goBank() {
  const q: Record<string, string> = {}
  if (selected.value) {
    q.section = selected.value.section
    q.years = selected.value.year
  } else if (radar.value) {
    // 未选格：带科目相关年份筛选无直接字段，至少带上年份范围
    if (radar.value.years.length) q.years = radar.value.years.join(',')
  }
  if (seasonFilter.value.length) q.seasons = seasonFilter.value.join(',')
  void router.push({ name: 'bank', query: q })
}

onMounted(async () => {
  try {
    papers.value = await fetchPapersForRadar()
    subjects.value = groupPapersBySubject(papers.value)
    pickDefaultSubject()
    await loadRadar()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
})

watch(activeSubject, () => void loadRadar())
watch(seasonFilter, () => void loadRadar(), { deep: true })
</script>

<template>
  <div class="radar">
    <!-- 科目 pills -->
    <div class="radar-subjects">
      <div class="radar-subjects-label">{{ t('radar.subjects') }}</div>
      <div class="radar-pills">
        <button
          v-for="s in subjects"
          :key="s.subject"
          type="button"
          class="radar-pill"
          :class="{ 'radar-pill--active': s.subject === activeSubject }"
          @click="setSubject(s.subject)"
        >
          <span class="radar-pill-code">{{ s.subject }}</span>
          <span class="radar-pill-count">{{ s.paperCount }}</span>
        </button>
      </div>
    </div>

    <!-- 筛选条 -->
    <div class="radar-toolbar">
      <div class="radar-seasons">
        <span class="radar-toolbar-label">{{ t('radar.filters.seasons') }}</span>
        <button
          v-for="s in SEASONS"
          :key="s"
          type="button"
          class="radar-chip"
          :class="{ 'radar-chip--on': seasonFilter.includes(s) }"
          @click="toggleSeason(s)"
        >
          {{ t('pcms.season.' + s) }}
        </button>
        <button
          v-if="seasonFilter.length"
          type="button"
          class="radar-chip radar-chip--ghost"
          @click="seasonFilter = []"
        >
          {{ t('radar.filters.allSeasons') }}
        </button>
      </div>
      <div class="radar-modes">
        <span class="radar-toolbar-label">{{ t('radar.filters.valueMode') }}</span>
        <button type="button" class="radar-chip radar-chip--on">{{ t('radar.filters.modeCount') }}</button>
        <button type="button" class="radar-chip" disabled :title="t('radar.difficulty.todo')">
          {{ t('radar.filters.modeDifficulty') }}
        </button>
      </div>
      <div class="radar-toolbar-right">
        <button type="button" class="btn btn-soft" @click="goBank">{{ t('radar.detail.goBank') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="radar-error">{{ loadError }}</div>
    <div v-else-if="!subjects.length && !loading" class="radar-empty">{{ t('radar.noSubjects') }}</div>
    <div v-else-if="loading" class="radar-empty muted">{{ t('radar.loading') }}</div>

    <div v-else-if="radar" class="radar-body">
      <!-- 主热力图 -->
      <section class="radar-heat card">
        <div class="card-title">{{ t('radar.heatmap.title') }}</div>
        <div class="radar-heat-scroll">
          <table class="radar-table">
            <thead>
              <tr>
                <th class="radar-th-corner">{{ t('radar.heatmap.section') }}</th>
                <th v-for="y in yearsInView" :key="y" class="radar-th-year">
                  {{ formatYearToken(y) }}
                </th>
                <th class="radar-th-total">{{ t('radar.heatmap.sectionTotal') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="sec in sectionsInView" :key="sec">
                <th class="radar-th-sec" :title="sec">{{ sec }}</th>
                <td
                  v-for="y in yearsInView"
                  :key="sec + y"
                  class="radar-cell"
                  :class="{ 'radar-cell--sel': isSelected(sec, y) }"
                  :style="{
                    background:
                      cellVal(sec, y) > 0
                        ? 'rgba(32, 112, 192, ' + cellAlpha(sec, y) + ')'
                        : undefined,
                  }"
                  :title="sec + ' · ' + formatYearToken(y) + ' · ' + cellVal(sec, y)"
                  @click="selectCell(sec, y)"
                >
                  <span v-if="cellVal(sec, y) > 0">{{ cellVal(sec, y) }}</span>
                </td>
                <td class="radar-cell radar-cell--total">
                  {{ radar.sectionTotals.get(sec) ?? 0 }}
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <th class="radar-th-sec">{{ t('radar.heatmap.yearTotal') }}</th>
                <td v-for="y in yearsInView" :key="'t' + y" class="radar-cell radar-cell--total">
                  {{ radar.yearTotals.get(y) ?? 0 }}
                </td>
                <td class="radar-cell radar-cell--total">{{ radar.totalQuestions }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div v-if="!radar.sections.length" class="radar-empty muted">{{ t('radar.emptySubject') }}</div>
      </section>

      <!-- 侧栏 -->
      <aside class="radar-side">
        <!-- 详情 -->
        <section class="card radar-side-card">
          <div class="card-title">{{ t('radar.detail.title') }}</div>
          <template v-if="selected && selectedCell">
            <div class="radar-detail-kv">
              <span>{{ t('radar.detail.section') }}</span>
              <b>{{ selected.section }}</b>
            </div>
            <div class="radar-detail-kv">
              <span>{{ t('radar.detail.year') }}</span>
              <b>{{ formatYearToken(selected.year) }}</b>
            </div>
            <div class="radar-detail-kv">
              <span>{{ t('radar.detail.count') }}</span>
              <b>{{ selectedCell.count }}</b>
            </div>
            <div class="radar-detail-kv">
              <span>{{ t('radar.detail.ids') }}</span>
              <b class="radar-id-list">{{ selectedQuestionIds.slice(0, 12).join(', ') }}</b>
            </div>
            <button type="button" class="btn btn-primary btn-sm" @click="goBank">
              {{ t('radar.detail.goBank') }}
            </button>
          </template>
          <p v-else class="muted">{{ t('radar.detail.selectCell') }}</p>
        </section>

        <!-- 年度总量 -->
        <section class="card radar-side-card">
          <div class="card-title">{{ t('radar.trend.title') }}</div>
          <div class="radar-trend">
            <div v-for="row in yearTotalList" :key="row.year" class="radar-trend-row">
              <span class="radar-trend-label">{{ row.label }}</span>
              <div class="radar-trend-bar">
                <div
                  class="radar-trend-fill"
                  :style="{ width: Math.round((row.total / maxYearTotal) * 100) + '%' }"
                />
              </div>
              <span class="radar-trend-num">{{ row.total }}</span>
            </div>
          </div>
        </section>

        <!-- 模块占比 -->
        <section class="card radar-side-card">
          <div class="card-title">{{ t('radar.share.title') }}</div>
          <div class="radar-share">
            <div v-for="row in sectionShareList" :key="row.section" class="radar-share-row">
              <span class="radar-share-label" :title="row.section">{{ row.section }}</span>
              <div class="radar-share-bar">
                <div class="radar-share-fill" :style="{ width: row.pct + '%' }" />
              </div>
              <span class="radar-share-num">{{ row.pct }}%</span>
            </div>
          </div>
        </section>

        <!-- 该考未考 -->
        <section class="card radar-side-card">
          <div class="card-title">{{ t('radar.overdue.title') }}</div>
          <p class="muted radar-overdue-desc">{{ t('radar.overdue.desc') }}</p>
          <ul v-if="overdueList.length" class="radar-overdue-list">
            <li v-for="o in overdueList" :key="o.section">
              <span class="tag tag-warn">{{ o.section }}</span>
              <span class="muted">
                {{ t('radar.overdue.lastSeen') }} {{ formatYearToken(o.lastYear) }}
                · {{ t('radar.overdue.gap', { n: o.gap }) }}
              </span>
            </li>
          </ul>
          <p v-else class="muted">{{ t('radar.overdue.empty') }}</p>
        </section>
      </aside>
    </div>
  </div>
</template>
