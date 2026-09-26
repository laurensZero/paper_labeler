<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { getSupabase, imageUrl } from '@/lib/supabase'
import SectionCascadeSelect from '@/components/SectionCascadeSelect.vue'
import PaperCascadeMultiSelect from '@/components/PaperCascadeMultiSelect.vue'
import MultiSelect from '@/components/MultiSelect.vue'
import ExportDialog, { type SummaryFields, type RandomPoolItem } from '@/components/ExportDialog.vue'
import { buildCascadeOptions, fetchSectionsGraph, UNSET_SECTION, type CascadeGroup } from '@/lib/sections'
import { fetchAnswerBoxes, toExportInput } from '@/lib/exportData'
import type { ExportQuestionInput } from '@/lib/pdfExport'
import { useAuth } from '@/composables/auth'

const { t } = useI18n()
const auth = useAuth()

// ---- 类型 ----
interface PaperLite {
  id: number
  filename: string
  exam_code: string | null
  year_token: string | null
  season_token: string | null
}

interface QFull {
  id: number
  question_no: string | null
  status: string
  notes: string | null
  paper_id: number
  section: string | null
  papers: PaperLite | PaperLite[] | null
  question_sections: { section_name: string }[]
  question_boxes: { id: number; image_key: string; page: number }[]
}

/** 每账号独立的收藏/备注（question_user_data，RLS 限定本人） */
interface UserDatum {
  is_favorite: boolean
  note: string | null
}

interface AnswerData {
  id: number
  answer_boxes: { id: number; image_key: string; page: number }[]
}

const MAX_ROWS = 2000

// ---- 筛选 ----
const filters = reactive({
  section: '',
  papers: [] as string[],
  years: [] as string[],
  seasons: [] as string[],
  favOnly: false,
  notes: '',
  jump: '',
})
const allRows = ref<QFull[]>([])
const loading = ref(false)
const loadError = ref('')
const selectedId = ref<number | null>(null)
const heroRef = ref<HTMLElement | null>(null)

const cascadeOptions = ref<CascadeGroup[]>([])
const paperOptions = ref<PaperLite[]>([])
const sectionLabelMap = ref<Record<string, string>>({})
const userData = ref<Map<number, UserDatum>>(new Map())

function udOf(id: number): UserDatum {
  return userData.value.get(id) ?? { is_favorite: false, note: null }
}
function isFav(id: number): boolean {
  return udOf(id).is_favorite
}
function noteOf(id: number): string {
  return udOf(id).note ?? ''
}
function setUd(id: number, patch: Partial<UserDatum>) {
  const m = new Map(userData.value)
  m.set(id, { ...udOf(id), ...patch })
  userData.value = m
}

async function loadUserData() {
  const uid = auth.session?.user.id
  if (!uid) return
  try {
    const { data, error } = await getSupabase()
      .from('question_user_data')
      .select('question_id,is_favorite,note')
      .eq('user_id', uid)
      .limit(2000)
    if (error) {
      // 0002 迁移尚未执行时静默降级（收藏/备注不可用，但不阻塞题库）
      if (error.code === '42P01' || error.code === 'PGRST205') {
        console.warn('[question_user_data] 迁移 0002 未执行，个人收藏/备注暂不可用')
        return
      }
      throw error
    }
    const m = new Map<number, UserDatum>()
    for (const row of (data ?? []) as { question_id: number; is_favorite: boolean; note: string | null }[]) {
      m.set(row.question_id, { is_favorite: row.is_favorite, note: row.note })
    }
    userData.value = m
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
}

async function upsertUd(id: number, patch: Partial<UserDatum>) {
  const uid = auth.session?.user.id
  if (!uid) return false
  const merged = { ...udOf(id), ...patch }
  const { error } = await getSupabase().from('question_user_data').upsert(
    { question_id: id, user_id: uid, is_favorite: merged.is_favorite, note: merged.note },
    { onConflict: 'question_id,user_id' },
  )
  if (error) {
    loadError.value = error.message
    return false
  }
  setUd(id, patch)
  return true
}

async function toggleFav() {
  const id = selectedId.value
  if (id == null) return
  await upsertUd(id, { is_favorite: !isFav(id) })
}

async function saveNote(value: string) {
  const id = selectedId.value
  if (id == null) return
  await upsertUd(id, { note: value.trim() || null })
}

// ---- 多选（对齐管理端 FilterView：开关 + 选中集 + 批量收藏） ----
const multiSelect = ref(false)
const selectedIds = ref<Set<number>>(new Set())

function toggleMultiSelect() {
  multiSelect.value = !multiSelect.value
  if (!multiSelect.value) selectedIds.value = new Set()
}

function toggleSelected(id: number) {
  if (!multiSelect.value) return
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

async function batchFavorite() {
  const ids = [...selectedIds.value]
  for (const id of ids) {
    if (!isFav(id)) await upsertUd(id, { is_favorite: true })
  }
}

// 多选时点缩略图 = 勾选/取消，不切主视图
function onFsClick(id: number) {
  if (multiSelect.value) toggleSelected(id)
  else selectById(id)
}

// ---- 题目反馈（suggestions：每人可提交，管理员处理） ----
interface SuggestionItem {
  id: number
  body: string
  status: string
  created_at: string
}
const mySuggestions = ref<SuggestionItem[]>([])
const feedbackText = ref('')
const feedbackBusy = ref(false)

async function loadSuggestions(qid: number | null) {
  mySuggestions.value = []
  feedbackText.value = ''
  const uid = auth.session?.user.id
  if (qid == null || !uid) return
  try {
    const { data, error } = await getSupabase()
      .from('suggestions')
      .select('id,body,status,created_at')
      .eq('question_id', qid)
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(10)
    if (error) throw error
    mySuggestions.value = (data ?? []) as SuggestionItem[]
  } catch (e) {
    console.warn('[suggestions] load failed', e)
  }
}

async function submitFeedback() {
  const qid = selectedId.value
  const uid = auth.session?.user.id
  const body = feedbackText.value.trim()
  if (qid == null || !uid || !body) return
  feedbackBusy.value = true
  try {
    const { data, error } = await getSupabase()
      .from('suggestions')
      .insert({ question_id: qid, user_id: uid, body })
      .select('id,body,status,created_at')
      .single()
    if (error) throw error
    mySuggestions.value = [data as SuggestionItem, ...mySuggestions.value].slice(0, 10)
    feedbackText.value = ''
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    feedbackBusy.value = false
  }
}

watch(selectedId, (qid) => {
  void loadSuggestions(qid)
})

const paperCascadeOptions = computed(() =>
  paperOptions.value.map((p) => ({ value: String(p.id), label: paperLabel(p) })),
)
const yearMsOptions = computed(() => {
  const set = new Set<string>()
  for (const p of paperOptions.value) if (p.year_token) set.add(p.year_token)
  return [...set].sort().reverse().map((y) => ({ value: y, label: y }))
})
const seasonMsOptions = computed(() => {
  const set = new Set<string>()
  for (const p of paperOptions.value) if (p.season_token) set.add(p.season_token)
  return [...set].sort().map((s) => ({
    value: s,
    label: s in { m: 1, s: 1, w: 1 } ? t(`pcms.season.${s}`) : s,
  }))
})

// 模块/收藏/备注筛选走客户端（行数 ≤ MAX_ROWS；支持「未分类」）
const rows = computed<QFull[]>(() => {
  let list = allRows.value
  const v = filters.section
  if (v === UNSET_SECTION) list = list.filter((r) => sectionsOf(r).length === 0)
  else if (v) list = list.filter((r) => sectionsOf(r).includes(v))
  if (filters.favOnly) list = list.filter((r) => isFav(r.id))
  const kw = filters.notes.trim().toLowerCase()
  if (kw) list = list.filter((r) => noteOf(r.id).toLowerCase().includes(kw))
  return list
})

// ---- 答案 ----
const ansOpen = ref(false)
const ansLoading = ref(false)
const ansBoxes = ref<{ image_key: string; page: number }[]>([])
const ansCache = new Map<number, { image_key: string; page: number }[]>()

const selected = computed(() => rows.value.find((r) => r.id === selectedId.value) ?? null)
const selectedIndex = computed(() => rows.value.findIndex((r) => r.id === selectedId.value))

function paperOf(r: QFull): PaperLite | null {
  if (!r.papers) return null
  return Array.isArray(r.papers) ? (r.papers[0] ?? null) : r.papers
}

function paperLabel(p: PaperLite | null): string {
  if (!p) return t('bank.unknownPaper')
  return p.exam_code || p.filename || `#${p.id}`
}

function sectionsOf(r: QFull): string[] {
  if (r.question_sections?.length) return r.question_sections.map((s) => s.section_name)
  return r.section ? [r.section] : []
}

function sortedBoxes(r: QFull | null) {
  if (!r) return []
  return [...(r.question_boxes ?? [])].sort((a, b) => a.page - b.page)
}

function onImgDone(e: Event) {
  ;(e.currentTarget as HTMLElement).classList.add('is-loaded')
}

// ---- 数据加载 ----
async function loadFilterOptions() {
  const sb = getSupabase()
  const [graph, papers] = await Promise.all([
    fetchSectionsGraph(),
    sb
      .from('papers')
      .select('id,filename,exam_code,year_token,season_token,is_answer')
      .eq('is_answer', false)
      .order('year_token', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false }),
  ])
  const built = buildCascadeOptions(graph, {
    moduleGroup: t('cascade.moduleGroup'),
    allModules: t('bank.allModules'),
    unsectioned: t('cascade.unsectioned'),
    ungrouped: t('cascade.ungrouped'),
  })
  cascadeOptions.value = built.options
  sectionLabelMap.value = built.labelMap
  paperOptions.value = (papers.data ?? []) as PaperLite[]
}

let loadToken = 0

async function loadQuestions() {
  const token = ++loadToken
  loading.value = true
  loadError.value = ''
  try {
    let query = getSupabase()
      .from('questions')
      .select(
        `id, question_no, status, notes, paper_id, section,
         papers ( id, filename, exam_code, year_token, season_token ),
         question_sections ( section_name ),
         question_boxes ( id, image_key, page )`,
      )
    if (filters.years.length) query = query.in('papers.year_token', filters.years)
    if (filters.seasons.length) query = query.in('papers.season_token', filters.seasons)
    if (filters.papers.length) query = query.in('paper_id', filters.papers.map(Number))

    const { data, error } = await query.order('id', { ascending: false }).limit(MAX_ROWS)
    if (token !== loadToken) return
    if (error) throw error
    allRows.value = (data ?? []) as unknown as QFull[]
  } catch (e) {
    if (token !== loadToken) return
    loadError.value = e instanceof Error ? e.message : String(e)
    allRows.value = []
  } finally {
    if (token === loadToken) loading.value = false
  }
}

// 过滤结果变化时保持选中项有效
watch(rows, (list) => {
  if (!list.some((r) => r.id === selectedId.value)) {
    selectedId.value = list[0]?.id ?? null
  }
  // 多选：剔除已不在结果集里的 id，保证「已选 N」计数真实
  if (selectedIds.value.size) {
    const alive = new Set(list.map((r) => r.id))
    const kept = new Set([...selectedIds.value].filter((id) => alive.has(id)))
    if (kept.size !== selectedIds.value.size) selectedIds.value = kept
  }
})

// ---- 选题 / 导航 ----
function selectById(id: number) {
  selectedId.value = id
}

function moveSelection(delta: -1 | 1) {
  if (!rows.value.length) return
  const idx = selectedIndex.value
  const next = idx < 0 ? 0 : Math.min(rows.value.length - 1, Math.max(0, idx + delta))
  selectedId.value = rows.value[next].id
}

function jumpToQuestion() {
  const v = filters.jump.trim()
  if (!v) return
  const hit =
    rows.value.find((r) => String(r.question_no ?? '') === v) ??
    rows.value.find((r) => String(r.question_no ?? '').includes(v))
  if (hit) {
    selectedId.value = hit.id
    loadError.value = ''
  } else {
    loadError.value = t('bank.jumpNotFound', { no: v })
  }
}

function scrollToActive(id: number) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-fs-id="${id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  })
}

// 选中变化：底部条跟随 + 大题区回到顶部
watch(selectedId, (id) => {
  if (id == null) return
  scrollToActive(id)
  heroRef.value?.scrollTo({ top: 0 })
})

function onKeydown(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  const tag = el?.tagName
  // 文本输入不拦截（光标移动）
  if (tag === 'TEXTAREA') return
  if (tag === 'INPUT' && (el as HTMLInputElement).type !== 'checkbox') return

  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    // 焦点停在 select/复选框上时先失焦，避免方向键被表单控件吃掉
    if (tag === 'SELECT' || tag === 'INPUT') el!.blur()
    e.preventDefault()
    moveSelection(e.key === 'ArrowLeft' ? -1 : 1)
  } else if (e.key === 'Enter' && multiSelect.value && selectedId.value != null && tag !== 'BUTTON') {
    // 多选模式：Enter 勾选/取消当前题（对齐管理端 FilmStrip）
    e.preventDefault()
    toggleSelected(selectedId.value)
  }
}

// ---- 答案 ----
async function loadAnswers(qid: number) {
  if (ansCache.has(qid)) {
    ansBoxes.value = ansCache.get(qid)!
    return
  }
  ansLoading.value = true
  try {
    const { data, error } = await getSupabase()
      .from('answers')
      .select('id, question_id, answer_boxes ( id, image_key, page )')
      .eq('question_id', qid)
      .maybeSingle()
    if (error) throw error
    const boxes = ((data as AnswerData | null)?.answer_boxes ?? []) as { image_key: string; page: number }[]
    boxes.sort((a, b) => a.page - b.page)
    ansCache.set(qid, boxes)
    ansBoxes.value = boxes
  } catch {
    ansBoxes.value = []
  } finally {
    ansLoading.value = false
  }
}

watch(ansOpen, (open) => {
  if (open && selectedId.value != null) void loadAnswers(selectedId.value)
})

watch(selectedId, (qid) => {
  if (ansOpen.value && qid != null) void loadAnswers(qid)
})

watch(
  () => [filters.papers.join(','), filters.years.join(','), filters.seasons.join(',')],
  () => void loadQuestions(),
)

// ---- 导出（含随机抽题内嵌页签） ----
const exportVisible = ref(false)
const exportProviderFn = ref<() => Promise<ExportQuestionInput[]>>(async () => [])
const exportRandomProviderFn = ref<(ids: number[]) => Promise<ExportQuestionInput[]>>(async () => [])
const exportFilename = ref('export.pdf')
const exportBuildLinesFn = ref<(f: SummaryFields) => string[]>(() => [])
const exportBuildRandomLinesFn = ref<(ids: number[], f: SummaryFields) => string[]>(() => [])
/** 多选导出时的题数（传给弹窗显示「将导出 N 题」）；按筛选全量时为 undefined */
const exportItemCount = ref<number | undefined>(undefined)

const favIdSet = computed(() => {
  const s = new Set<number>()
  for (const [id, v] of userData.value) if (v.is_favorite) s.add(id)
  return s
})

const randomPool = computed<RandomPoolItem[]>(() =>
  rows.value.map((r) => ({ id: r.id, sections: sectionsOf(r) })),
)

async function makeExportInputs(list: QFull[]): Promise<ExportQuestionInput[]> {
  const ansMap = await fetchAnswerBoxes(list.map((r) => r.id))
  return list.map((r) =>
    toExportInput(
      {
        id: r.id,
        questionNo: r.question_no,
        sections: sectionsOf(r),
        paperLabel: paperLabel(paperOf(r)),
        notes: r.notes,
        boxUrls: sortedBoxes(r).map((b) => imageUrl(b.image_key)),
      },
      ansMap.get(r.id) ?? [],
      0,
    ),
  )
}

function buildFilterLines(f: SummaryFields, countOverride?: number): string[] {
  const lines: string[] = []
  if (f.section && filters.section) {
    const label =
      filters.section === UNSET_SECTION
        ? t('cascade.unsectioned')
        : sectionLabelMap.value[filters.section] || filters.section
    lines.push(`${t('exportDialog.sfSection')}: ${label}`)
  }
  if (f.paper && filters.papers.length) {
    const labels = filters.papers.map((id) => {
      const p = paperOptions.value.find((x) => String(x.id) === id)
      return p ? paperLabel(p) : id
    })
    lines.push(`${t('exportDialog.sfPaper')}: ${labels.join(', ')}`)
  }
  if (f.year && filters.years.length) {
    lines.push(`${t('exportDialog.sfYear')}: ${filters.years.join(', ')}`)
  }
  if (f.season && filters.seasons.length) {
    const labels = filters.seasons.map((s) => (s in { m: 1, s: 1, w: 1 } ? t(`pcms.season.${s}`) : s))
    lines.push(`${t('exportDialog.sfSeason')}: ${labels.join(', ')}`)
  }
  if (f.count) lines.push(`${t('exportDialog.sfCount')}: ${countOverride ?? rows.value.length}`)
  return lines
}

function buildRandomLines(ids: number[], f: SummaryFields): string[] {
  const idSet = new Set(ids)
  const lines = buildFilterLines({ ...f, count: false })
  if (f.count) lines.push(`${t('exportDialog.sfCount')}: ${idSet.size}`)
  return lines
}

function openFilterExport() {
  // 多选勾选了题目 → 只导出选中（对齐管理端 export.ts:792-793）
  const useSelection = multiSelect.value && selectedIds.value.size > 0
  const baseList = useSelection
    ? rows.value.filter((r) => selectedIds.value.has(r.id))
    : rows.value
  exportItemCount.value = useSelection ? baseList.length : undefined
  exportProviderFn.value = () => makeExportInputs(baseList)
  exportRandomProviderFn.value = (ids: number[]) => {
    const idSet = new Set(ids)
    return makeExportInputs(rows.value.filter((r) => idSet.has(r.id)))
  }
  exportBuildLinesFn.value = (f: SummaryFields) => buildFilterLines(f, baseList.length)
  exportBuildRandomLinesFn.value = buildRandomLines
  exportFilename.value = useSelection
    ? `题库选中_${baseList.length}题_${stamp()}`
    : `题库导出_${stamp()}`
  exportVisible.value = true
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

onMounted(async () => {
  document.addEventListener('keydown', onKeydown)
  await Promise.all([loadFilterOptions(), loadQuestions(), loadUserData()])
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="bank">
    <!-- ── 顶部筛选（对齐管理端布局） ── -->
    <div class="bank-toolbar">
      <SectionCascadeSelect
        v-model="filters.section"
        class="bank-ctl bank-ctl--cascade"
        :options="cascadeOptions"
        :placeholder="t('bank.allModules')"
        :empty-text="t('cascade.noSections')"
      />
      <PaperCascadeMultiSelect
        v-model="filters.papers"
        class="bank-ctl bank-ctl--paper"
        :options="paperCascadeOptions"
        :placeholder="t('bank.allPapers')"
      />
      <MultiSelect
        v-model="filters.years"
        class="bank-ctl bank-ctl--sm"
        :options="yearMsOptions"
        display-mode="values"
        :show-all-when-all-selected="true"
        :placeholder="t('bank.allYears')"
      />
      <MultiSelect
        v-model="filters.seasons"
        class="bank-ctl bank-ctl--sm"
        :options="seasonMsOptions"
        display-mode="values"
        :show-all-when-all-selected="true"
        :placeholder="t('bank.allSeasons')"
      />
      <label class="bank-check">
        <input v-model="filters.favOnly" type="checkbox" />
        <span>{{ t('bank.favOnly') }}</span>
      </label>
      <div class="bank-search">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input v-model="filters.notes" class="bank-search-input" type="text" :placeholder="t('bank.searchNotes')" />
      </div>
      <input
        v-model="filters.jump"
        class="input"
        style="width: 96px"
        :placeholder="t('bank.jumpPh')"
        @keydown.enter="jumpToQuestion"
      />
      <div style="flex: 1"></div>
      <button
        class="btn btn-sm"
        :class="{ 'btn-primary': multiSelect }"
        :disabled="!rows.length"
        @click="toggleMultiSelect"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        {{ multiSelect ? t('bank.multiSelectActive', { count: selectedIds.size }) : t('bank.multiSelect') }}
      </button>
      <button
        v-if="multiSelect && selectedIds.size"
        class="btn btn-sm"
        @click="batchFavorite"
      >
        {{ t('bank.batchFavorite') }}
      </button>
      <button class="btn btn-sm" :disabled="!rows.length" @click="openFilterExport">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        {{ t('exportDialog.title') }}
      </button>
    </div>

    <!-- ── 主区：中间大题 + 右侧信息 ── -->
    <div class="bank-main">
      <div ref="heroRef" class="bank-hero">
        <div v-if="loadError" class="error-text" style="margin-bottom: 10px">{{ loadError }}</div>

        <div v-if="loading && !rows.length" class="bank-empty">{{ t('bank.loading') }}</div>

        <template v-else-if="selected">
          <div class="bank-question" :key="selected.id">
            <div v-if="sortedBoxes(selected).length" class="bank-question-imgs">
              <img
                v-for="b in sortedBoxes(selected)"
                :key="b.id"
                class="skel"
                :src="imageUrl(b.image_key)"
                :alt="`#${selected.question_no ?? selected.id}`"
                crossorigin="anonymous"
                decoding="async"
                @load="onImgDone"
                @error="onImgDone"
              />
            </div>
            <div v-else class="bank-empty">{{ t('bank.noBoxes') }}</div>

            <!-- 答案 -->
            <div v-if="ansOpen" class="bank-answer">
              <div class="bank-answer-head">{{ t('bank.answers') }}</div>
              <div v-if="ansLoading" class="bank-empty" style="padding: 20px">{{ t('bank.answersLoading') }}</div>
              <div v-else-if="ansBoxes.length" class="bank-question-imgs">
                <img
                  v-for="(b, i) in ansBoxes"
                  :key="i"
                  class="skel"
                  :src="imageUrl(b.image_key)"
                  alt=""
                  crossorigin="anonymous"
                  decoding="async"
                  @load="onImgDone"
                  @error="onImgDone"
                />
              </div>
              <div v-else class="bank-empty" style="padding: 20px">{{ t('bank.answersEmpty') }}</div>
            </div>
          </div>
        </template>

        <div v-else class="bank-empty">
          {{ loading ? t('bank.loading') : t('bank.noResults') }}
        </div>
      </div>

      <!-- 右侧只读信息 -->
      <aside v-if="selected" class="bank-info">
        <div class="card-title">{{ t('bank.infoTitle') }}</div>
        <div class="bank-info-row"><span class="bank-info-k">{{ t('bank.qno') }}</span><span class="bank-info-qno">{{ selected.question_no ?? '—' }}</span></div>
        <div class="bank-info-row"><span class="bank-info-k">{{ t('bank.status') }}</span>
          <span :class="selected.status === 'confirmed' ? 'tag tag-ok' : 'tag tag-warn'">
            {{ selected.status === 'confirmed' ? t('bank.confirmed') : t('bank.draft') }}
          </span>
        </div>
        <div class="bank-info-row">
          <span class="bank-info-k">{{ t('bank.answers') }}</span>
          <button
            class="bank-action bank-action--primary"
            :class="{ on: ansOpen }"
            @click="ansOpen = !ansOpen"
          >
            <svg v-if="!ansOpen" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            {{ ansOpen ? t('bank.hideAnswers') : t('bank.showAnswers') }}
          </button>
        </div>
        <div class="bank-info-row">
          <span class="bank-info-k">{{ t('bank.fav') }}</span>
          <button
            class="bank-action bank-action--fav"
            :class="{ on: isFav(selected.id) }"
            @click="toggleFav"
          >
            <svg v-if="!isFav(selected.id)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            {{ isFav(selected.id) ? t('bank.favYes') : t('bank.fav') }}
          </button>
        </div>
        <div class="bank-info-row"><span class="bank-info-k">{{ t('bank.source') }}</span><span style="text-align: right">{{ paperLabel(paperOf(selected)) }}</span></div>
        <div class="bank-info-row bank-info-row--top">
          <span class="bank-info-k">{{ t('bank.section') }}</span>
          <span class="bank-info-tags">
            <template v-if="sectionsOf(selected).length">
              <span v-for="s in sectionsOf(selected)" :key="s" class="tag">{{ s }}</span>
            </template>
            <span v-else class="tag">{{ t('bank.uncategorized') }}</span>
          </span>
        </div>
        <div class="bank-info-row bank-info-row--top">
          <span class="bank-info-k">{{ t('bank.notes') }}</span>
          <textarea
            class="bank-note-input"
            :value="noteOf(selected.id)"
            :placeholder="t('bank.notePh')"
            rows="3"
            @change="saveNote(($event.target as HTMLTextAreaElement).value)"
          ></textarea>
        </div>

        <!-- 题目反馈 -->
        <div class="bank-feedback">
          <div class="bank-info-k" style="margin-bottom: 6px">{{ t('bank.feedback') }}</div>
          <textarea
            v-model="feedbackText"
            class="bank-note-input"
            rows="2"
            :placeholder="t('bank.feedbackPh')"
          ></textarea>
          <button
            class="btn btn-primary btn-sm"
            style="width: 100%; margin-top: 6px"
            :disabled="feedbackBusy || !feedbackText.trim()"
            @click="submitFeedback"
          >
            {{ feedbackBusy ? t('bank.feedbackSending') : t('bank.feedbackSend') }}
          </button>
          <div v-if="mySuggestions.length" class="bank-feedback-list">
            <div v-for="s in mySuggestions" :key="s.id" class="bank-feedback-item">
              <span
                class="tag"
                :class="s.status === 'accepted' ? 'tag-ok' : s.status === 'rejected' ? '' : 'tag-warn'"
              >{{ t(`bank.sugStatus.${s.status}`) }}</span>
              <span class="bank-feedback-body">{{ s.body }}</span>
            </div>
          </div>
        </div>
        <div class="muted" style="font-size: 12px; margin-top: 14px">
          {{ t('bank.hint') }}
        </div>
      </aside>
    </div>

    <!-- ── 底部 filmstrip ── -->
    <div class="bank-strip">
      <span class="bank-strip-count">{{ loading ? t('bank.loading') : t('bank.count', { n: rows.length }) }}</span>
      <div class="bank-strip-scroll">
        <button
          v-for="r in rows"
          :key="r.id"
          class="fs-item"
          :class="{
            'fs-item--active': r.id === selectedId,
            'fs-item--fav': isFav(r.id),
            'fs-item--selected': multiSelect && selectedIds.has(r.id),
          }"
          :data-fs-id="r.id"
          :title="sectionsOf(r).join(', ')"
          @click="onFsClick(r.id)"
        >
          <span v-if="multiSelect" class="fs-item-check">
            <svg v-if="selectedIds.has(r.id)" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          </span>
          <span class="fs-item-no">{{ r.question_no || '?' }}</span>
          <span v-if="isFav(r.id)" class="fs-item-star">★</span>
        </button>
      </div>
    </div>

    <!-- 导出弹窗（含随机抽题页签） -->
    <ExportDialog
      v-model:visible="exportVisible"
      :provider="exportProviderFn"
      :default-filename="exportFilename"
      :show-summary="true"
      :build-lines="exportBuildLinesFn"
      :show-random="true"
      :random-pool="randomPool"
      :random-favs="favIdSet"
      :random-provider="exportRandomProviderFn"
      :build-random-lines="exportBuildRandomLinesFn"
      :item-count="exportItemCount"
    />
  </div>
</template>
