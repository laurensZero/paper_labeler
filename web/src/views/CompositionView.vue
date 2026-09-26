<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { getSupabase, imageUrl } from '@/lib/supabase'
import { useAuth } from '@/composables/auth'
import SectionCascadeSelect from '@/components/SectionCascadeSelect.vue'
import MultiSelect from '@/components/MultiSelect.vue'
import ExportDialog from '@/components/ExportDialog.vue'
import { buildCascadeOptions, fetchSectionsGraph, UNSET_SECTION, type CascadeGroup } from '@/lib/sections'
import { fetchAnswerBoxes } from '@/lib/exportData'
import type { ExportQuestionInput } from '@/lib/pdfExport'

const { t } = useI18n()

// ---------- 类型 ----------
interface Comp {
  id: string
  name: string
  title: string | null
  header_text: string | null
  footer_text: string | null
  cover_lines: string | null
  include_answers: boolean
  answers_placement: 'end' | 'interleaved'
  show_section_headers: boolean
  show_question_info: boolean
  show_page_numbers: boolean
  visibility: 'private' | 'shared'
  owner_id: string
}

interface QLite {
  id: number
  question_no: string | null
  section: string | null
  notes: string | null
  papers: { exam_code: string | null; year_token: string | null; filename: string } | null
  question_sections: { section_name: string }[]
  question_boxes: { image_key: string; page: number }[]
}

interface Item {
  id: number
  composition_id: string
  question_id: number | null
  sort_order: number
  item_type: 'question' | 'blank_page'
  blank_pages: number
  questions: QLite | null
}

interface BankQ {
  id: number
  question_no: string | null
  section: string | null
  papers: { exam_code: string | null } | null
  question_sections: { section_name: string }[]
}

interface CompListItem {
  id: string
  name: string
  visibility: string
  item_count?: number
}

const route = useRoute()
const router = useRouter()
const auth = useAuth()

// ---------- 状态 ----------
const comp = ref<Comp | null>(null)
const items = ref<Item[]>([])
const pageError = ref('')
const showListModal = ref(false)
const newName = ref('')
const compositions = ref<CompListItem[]>([])
const selectedItemId = ref<number | null>(null)
const previewMode = ref<'grouped' | 'free'>('grouped')

const bank = reactive({
  section: '',
  years: [] as string[],
  seasons: [] as string[],
  favOnly: false,
  page: 1,
  pageSize: 50,
})
const bankAll = ref<BankQ[]>([])
const bankLoading = ref(false)
const cascadeOptions = ref<CascadeGroup[]>([])
const sectionLabelMap = ref<Record<string, string>>({})
const paperOptions = ref<{ id: number; label: string; year: string | null; season: string | null }[]>([])
const previewRef = ref<HTMLElement | null>(null)
const exportVisible = ref(false)

const yearMsOptions = computed(() => {
  const set = new Set<string>()
  for (const p of paperOptions.value) if (p.year) set.add(p.year)
  return [...set].sort().reverse().map((y) => ({ value: y, label: y }))
})
const seasonMsOptions = computed(() => {
  const set = new Set<string>()
  for (const p of paperOptions.value) if (p.season) set.add(p.season)
  return [...set].sort().map((s) => ({
    value: s,
    label: s in { m: 1, s: 1, w: 1 } ? t(`pcms.season.${s}`) : s,
  }))
})

// 个人收藏（question_user_data，RLS 限定本人）
const favIds = ref<Set<number>>(new Set())

async function loadFavIds() {
  const uid = auth.session?.user.id
  if (!uid) return
  try {
    const { data, error } = await getSupabase()
      .from('question_user_data')
      .select('question_id')
      .eq('user_id', uid)
      .eq('is_favorite', true)
      .limit(2000)
    if (error) {
      if (error.code === '42P01' || error.code === 'PGRST205') {
        console.warn('[question_user_data] 迁移 0002 未执行，个人收藏暂不可用')
        return
      }
      throw error
    }
    favIds.value = new Set((data ?? []).map((r) => r.question_id as number))
  } catch {
    favIds.value = new Set()
  }
}

// 题库面板：模块/收藏/分页都在客户端（行数 ≤ 2000）
const bankFiltered = computed(() => {
  let list = bankAll.value
  const v = bank.section
  if (v === UNSET_SECTION) list = list.filter((q) => !q.question_sections?.length && !q.section)
  else if (v) list = list.filter((q) => q.question_sections?.some((s) => s.section_name === v) || q.section === v)
  if (bank.favOnly) list = list.filter((q) => favIds.value.has(q.id))
  return list
})
const bankTotal = computed(() => bankFiltered.value.length)
const bankRows = computed(() => {
  const from = (bank.page - 1) * bank.pageSize
  return bankFiltered.value.slice(from, from + bank.pageSize)
})

const dragSourceId = ref<number | null>(null)
const dragOverId = ref<number | null>(null)

const compId = computed(() => (route.params.id as string | undefined) ?? null)
const isOwner = computed(() => !!comp.value && comp.value.owner_id === auth.session?.user.id)

// ---------- 统计 ----------
const questionItemCount = computed(() => items.value.filter((i) => i.item_type === 'question').length)
const blankPageCount = computed(
  () =>
    items.value.filter((i) => i.item_type === 'blank_page').length +
    items.value.reduce((s, i) => s + (i.item_type === 'question' ? i.blank_pages || 0 : 0), 0),
)
const estimatedPages = computed(() => questionItemCount.value + blankPageCount.value)
const addedIds = computed(() => new Set(items.value.map((i) => i.question_id).filter(Boolean)))

// ---------- 封面 ----------
const coverLinesList = computed<string[]>(() => {
  const raw = comp.value?.cover_lines
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
})
const showCoverPreview = computed(() => !!comp.value?.title || coverLinesList.value.length > 0)
const coverLinePresets = computed(() => [
  { key: 'name', label: t('compose.settings.presets.name'), template: `${t('compose.settings.presets.name')}：` },
  { key: 'class', label: t('compose.settings.presets.class'), template: `${t('compose.settings.presets.class')}：` },
  { key: 'score', label: t('compose.settings.presets.score'), template: `${t('compose.settings.presets.score')}：` },
  { key: 'time', label: t('compose.settings.presets.time'), template: `${t('compose.settings.presets.time')}：` },
])

function saveCoverLines(list: string[]) {
  if (!comp.value) return
  comp.value.cover_lines = list.length ? JSON.stringify(list) : null
  void persistComp(['cover_lines'])
}

function addCoverLine(template = '') {
  saveCoverLines([...coverLinesList.value, template])
}
function updateCoverLine(idx: number, v: string) {
  const list = [...coverLinesList.value]
  list[idx] = v
  saveCoverLines(list)
}
function removeCoverLine(idx: number) {
  saveCoverLines(coverLinesList.value.filter((_, i) => i !== idx))
}

// ---------- 分组预览 ----------
interface Group {
  section: string
  items: Item[]
}
const groupedItems = computed<Group[] | null>(() => {
  if (previewMode.value === 'free') return null
  const map = new Map<string, Item[]>()
  for (const it of items.value) {
    let key = '__ungrouped'
    if (it.item_type === 'question' && it.questions) {
      const secs = it.questions.question_sections?.map((s) => s.section_name).filter(Boolean)
      if (secs?.length) key = secs[0]
      else if (it.questions.section) key = it.questions.section
    }
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(it)
  }
  return [...map.entries()].map(([section, list]) => ({ section, items: list }))
})

// ---------- 工具 ----------
function sectionsOf(it: Item): string[] {
  const q = it.questions
  if (!q) return []
  if (q.question_sections?.length) return q.question_sections.map((s) => s.section_name)
  return q.section ? [q.section] : []
}

function boxesOf(it: Item) {
  return [...(it.questions?.question_boxes ?? [])].sort((a, b) => a.page - b.page)
}

function paperOf(it: Item): string {
  const p = it.questions?.papers
  if (!p) return ''
  return p.exam_code || p.filename || ''
}

// ---------- 方案加载 ----------
async function loadCompositions() {
  const { data, error } = await getSupabase()
    .from('compositions')
    .select('id,name,visibility,composition_items(id)')
    .order('updated_at', { ascending: false })
  if (error) {
    pageError.value = error.message
    return
  }
  compositions.value = ((data ?? []) as unknown as {
    id: string
    name: string
    visibility: string
    composition_items: { id: number }[]
  }[]).map((c) => ({
    id: c.id,
    name: c.name,
    visibility: c.visibility,
    item_count: c.composition_items?.length ?? 0,
  }))
}

async function openComposition(id: string) {
  showListModal.value = false
  router.push({ name: 'compose', params: { id } })
}

async function createNew() {
  const name = newName.value.trim()
  if (!name) return
  const { data, error } = await getSupabase()
    .from('compositions')
    .insert({ name, owner_id: auth.session!.user.id })
    .select('id')
    .single()
  if (error) {
    pageError.value = error.message
    return
  }
  newName.value = ''
  await openComposition((data as { id: string }).id)
}

async function duplicateComposition(id: string) {
  const { data, error } = await getSupabase()
    .from('compositions')
    .select('*')
    .eq('id', id)
    .single()
  if (error || !data) {
    pageError.value = error?.message ?? t('compose.errors.copyFailed')
    return
  }
  const c = data as Comp
  const { data: created, error: e2 } = await getSupabase()
    .from('compositions')
    .insert({
      name: `${c.name} ${t('compose.copySuffix')}`,
      title: c.title,
      header_text: c.header_text,
      footer_text: c.footer_text,
      cover_lines: c.cover_lines,
      include_answers: c.include_answers,
      answers_placement: c.answers_placement,
      show_section_headers: c.show_section_headers,
      show_question_info: c.show_question_info,
      show_page_numbers: c.show_page_numbers,
      owner_id: auth.session!.user.id,
      visibility: 'private',
    })
    .select('id')
    .single()
  if (e2) {
    pageError.value = e2.message
    return
  }
  const newId = (created as { id: string }).id
  const { data: its } = await getSupabase()
    .from('composition_items')
    .select('question_id,sort_order,item_type,blank_pages,score,custom_header')
    .eq('composition_id', id)
    .order('sort_order')
  if (its?.length) {
    await getSupabase()
      .from('composition_items')
      .insert(its.map((i) => ({ ...i, composition_id: newId })))
  }
  await loadCompositions()
  await openComposition(newId)
}

async function deleteComposition(id: string) {
  const c = compositions.value.find((x) => x.id === id)
  if (!window.confirm(t('compose.confirmDelete', { name: c?.name ?? '' }))) return
  const { error } = await getSupabase().from('compositions').delete().eq('id', id)
  if (error) {
    pageError.value = error.message
    return
  }
  await loadCompositions()
  if (compId.value === id) router.push({ name: 'compose-new' })
}

async function loadAll(id: string) {
  pageError.value = ''
  comp.value = null
  items.value = []
  selectedItemId.value = null
  try {
    const sb = getSupabase()
    const { data: c, error: ce } = await sb.from('compositions').select('*').eq('id', id).single()
    if (ce) throw new Error(ce.code === 'PGRST116' ? t('compose.errors.notFound') : ce.message)
    comp.value = c as Comp
    const { data: its, error: ie } = await sb
      .from('composition_items')
      .select(
        `id, composition_id, question_id, sort_order, item_type, blank_pages,
         questions ( id, question_no, section, notes, papers ( exam_code, year_token, filename ), question_sections ( section_name ), question_boxes ( image_key, page ) )`,
      )
      .eq('composition_id', id)
      .order('sort_order')
    if (ie) throw ie
    items.value = ((its ?? []) as unknown as Item[]).map((it) => ({ ...it, questions: normalizeQ(it.questions) }))
  } catch (e) {
    pageError.value = e instanceof Error ? e.message : String(e)
  }
}

function normalizeQ(q: unknown): QLite | null {
  if (!q) return null
  const arr = Array.isArray(q) ? q : [q]
  return (arr[0] as QLite) ?? null
}

// ---------- 属性保存 ----------
async function persistComp(fields: (keyof Comp)[]) {
  if (!comp.value || !isOwner.value) return
  const body: Record<string, unknown> = {}
  for (const f of fields) body[f as string] = comp.value[f]
  const { error } = await getSupabase().from('compositions').update(body).eq('id', comp.value.id)
  if (error) pageError.value = error.message
}

async function renameComp() {
  await persistComp(['name'])
  await loadCompositions()
}

// ---------- 题库面板 ----------
async function loadFilterOptions() {
  const sb = getSupabase()
  const [graph, papers] = await Promise.all([
    fetchSectionsGraph(),
    sb.from('papers').select('id,exam_code,filename,year_token,season_token').eq('is_answer', false).order('id', { ascending: false }),
  ])
  const built = buildCascadeOptions(graph, {
    moduleGroup: t('cascade.moduleGroup'),
    allModules: t('compose.filters.allModules'),
    unsectioned: t('cascade.unsectioned'),
    ungrouped: t('cascade.ungrouped'),
  })
  cascadeOptions.value = built.options
  sectionLabelMap.value = built.labelMap
  paperOptions.value = (papers.data ?? []).map((p) => ({
    id: p.id as number,
    label: (p.exam_code as string) || (p.filename as string),
    year: (p.year_token as string | null) ?? null,
    season: (p.season_token as string | null) ?? null,
  }))
}

async function searchBank(resetPage = true) {
  if (resetPage) bank.page = 1
  bankLoading.value = true
  try {
    let query = getSupabase()
      .from('questions')
      .select(
        `id, question_no, section,
         papers ( exam_code ),
         question_sections ( section_name )`,
        { count: 'exact' },
      )
    if (bank.years.length) query = query.in('papers.year_token', bank.years)
    if (bank.seasons.length) query = query.in('papers.season_token', bank.seasons)
    const { data, error } = await query.order('id', { ascending: false }).limit(2000)
    if (error) throw error
    bankAll.value = (data ?? []) as unknown as BankQ[]
  } catch (e) {
    pageError.value = e instanceof Error ? e.message : String(e)
    bankAll.value = []
  } finally {
    bankLoading.value = false
  }
}

// 筛选变化时页码回 1（试卷/年份/季度需重新拉取；收藏为纯客户端过滤）
watch(
  () => [bank.years.join(','), bank.seasons.join(',')],
  () => {
    bank.page = 1
    void searchBank()
  },
)
watch(
  () => [bank.section, bank.favOnly],
  () => {
    bank.page = 1
  },
)

async function toggleQuestion(q: BankQ) {
  if (!isOwner.value || !comp.value) return
  const sb = getSupabase()
  const existing = items.value.find((i) => i.question_id === q.id)
  if (existing) {
    const { error } = await sb.from('composition_items').delete().eq('id', existing.id)
    if (error) {
      pageError.value = error.message
      return
    }
    items.value = items.value.filter((i) => i.id !== existing.id)
    if (selectedItemId.value === existing.id) selectedItemId.value = null
    renumber()
    await persistOrder()
    return
  }
  const { data, error } = await sb
    .from('composition_items')
    .insert({
      composition_id: comp.value.id,
      question_id: q.id,
      sort_order: items.value.length,
      item_type: 'question',
      blank_pages: 0,
    })
    .select(
      `id, composition_id, question_id, sort_order, item_type, blank_pages,
       questions ( id, question_no, section, notes, papers ( exam_code, year_token, filename ), question_sections ( section_name ), question_boxes ( image_key, page ) )`,
    )
    .single()
  if (error) {
    if (error.code !== '23505') pageError.value = error.message
    return
  }
  items.value = [
    ...items.value,
    { ...(data as unknown as Item), questions: normalizeQ((data as { questions: unknown }).questions) },
  ]
  renumber()
  await persistOrder()
}

function isInComposition(qid: number): boolean {
  return addedIds.value.has(qid)
}

// ---------- 条目操作 ----------
function renumber() {
  items.value.forEach((it, idx) => {
    it.sort_order = idx
  })
}

async function persistOrder() {
  const sb = getSupabase()
  await Promise.all(
    items.value.map((it, idx) =>
      sb.from('composition_items').update({ sort_order: idx }).eq('id', it.id).then(({ error }) => {
        if (error) throw error
        it.sort_order = idx
      }),
    ),
  )
}

async function insertBlankAfter(index: number) {
  if (!isOwner.value || !comp.value || index < 0) return
  const { data, error } = await getSupabase()
    .from('composition_items')
    .insert({
      composition_id: comp.value.id,
      question_id: null,
      sort_order: index + 1,
      item_type: 'blank_page',
      blank_pages: 0,
    })
    .select('id, composition_id, question_id, sort_order, item_type, blank_pages')
    .single()
  if (error) {
    pageError.value = error.message
    return
  }
  items.value.splice(index + 1, 0, { ...(data as unknown as Item), questions: null })
  renumber()
  await persistOrder()
}

async function removeItemById(id: number) {
  if (!isOwner.value) return
  const { error } = await getSupabase().from('composition_items').delete().eq('id', id)
  if (error) {
    pageError.value = error.message
    return
  }
  items.value = items.value.filter((i) => i.id !== id)
  if (selectedItemId.value === id) selectedItemId.value = null
  renumber()
  await persistOrder()
}

async function updateBlankPages(id: number, n: number) {
  const it = items.value.find((i) => i.id === id)
  if (!it || !isOwner.value) return
  const v = Math.max(0, n)
  const { error } = await getSupabase().from('composition_items').update({ blank_pages: v }).eq('id', id)
  if (error) {
    pageError.value = error.message
    return
  }
  it.blank_pages = v
}

function onDragStart(e: DragEvent, id: number) {
  dragSourceId.value = id
  e.dataTransfer?.setData('text/plain', String(id))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onDragOver(e: DragEvent, id: number) {
  if (dragSourceId.value == null || dragSourceId.value === id) return
  e.preventDefault()
  dragOverId.value = id
}
function onDrop(e: DragEvent, targetId: number) {
  e.preventDefault()
  const sourceId = dragSourceId.value
  dragOverId.value = null
  dragSourceId.value = null
  if (sourceId == null || sourceId === targetId) return
  const from = items.value.findIndex((i) => i.id === sourceId)
  const to = items.value.findIndex((i) => i.id === targetId)
  if (from < 0 || to < 0) return
  // 视角留在原位：drop 前后锁定滚动位置，不跟随被拖动的题
  const scroller = previewRef.value
  const keepScroll = scroller?.scrollTop ?? 0
  const [moved] = items.value.splice(from, 1)
  items.value.splice(to, 0, moved)
  renumber()
  void nextTick(() => {
    if (scroller) scroller.scrollTop = keepScroll
  })
  void persistOrder()
}
function onDragEnd() {
  dragSourceId.value = null
  dragOverId.value = null
}

const selectedItem = computed(() => items.value.find((i) => i.id === selectedItemId.value) ?? null)

// ---------- 生命周期 ----------
watch(compId, (id) => {
  if (id) void loadAll(id)
  else {
    comp.value = null
    items.value = []
  }
  void loadCompositions()
})

// ---- 组卷导出（浏览器拼 PDF，设置取自方案） ----
async function exportProvider(): Promise<ExportQuestionInput[]> {
  const qIds = items.value
    .filter((i) => i.item_type === 'question' && i.question_id != null)
    .map((i) => i.question_id as number)
  const ansMap = await fetchAnswerBoxes(qIds)
  return items.value.map((it) => {
    if (it.item_type === 'blank_page') {
      return {
        id: -it.id,
        questionNo: null,
        sections: [],
        paperLabel: '',
        notes: null,
        boxes: [],
        answerBoxes: [],
        blankPages: 0,
        isBlankPage: true,
      }
    }
    const q = it.questions
    const ans = it.question_id != null ? (ansMap.get(it.question_id) ?? []) : []
    return {
      id: q?.id ?? it.question_id ?? -1,
      questionNo: q?.question_no ?? null,
      sections: sectionsOf(it),
      paperLabel: paperOf(it),
      notes: q?.notes ?? null,
      boxes: boxesOf(it).map((b) => ({ url: imageUrl(b.image_key) })),
      answerBoxes: ans.map((url) => ({ url })),
      blankPages: it.blank_pages || 0,
    }
  })
}

const exportPreset = computed(() => {
  const c = comp.value
  if (!c) return undefined
  return {
    includeAnswers: c.include_answers,
    answersPlacement: c.answers_placement,
    title: c.title ?? undefined,
    headerText: c.header_text ?? undefined,
    coverLines: coverLinesList.value,
    showPageNumbers: c.show_page_numbers,
    sectionLabel: (n: string) => sectionLabelMap.value[n] || n,
    filename: `${c.name}_导出`,
  }
})

const exportFilenameDefault = computed(() => exportPreset.value?.filename ?? 'composition')

onMounted(async () => {
  await Promise.all([loadFilterOptions(), loadCompositions(), searchBank(), loadFavIds()])
  if (compId.value) await loadAll(compId.value)
})
</script>

<template>
  <div class="cv">
    <!-- ═══ 空态：无方案 ═══ -->
    <div v-if="!comp && !compId" class="cv-empty">
      <div class="cv-empty-box">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="12" y1="11" x2="12" y2="17" />
          <line x1="9" y1="14" x2="15" y2="14" />
        </svg>
        <h2>{{ t('compose.empty.title') }}</h2>
        <p class="muted">{{ t('compose.empty.desc') }}</p>
        <div style="display: flex; gap: 12px; justify-content: center">
          <button class="btn btn-primary" @click="showListModal = true">{{ t('compose.empty.open') }}</button>
          <button class="btn" @click="showListModal = true">{{ t('compose.empty.new') }}</button>
        </div>
      </div>
    </div>

    <!-- ═══ 主界面 ═══ -->
    <template v-else-if="comp">
      <!-- 工具栏 -->
      <div class="cv-toolbar">
        <div class="cv-toolbar-left">
          <button class="btn btn-sm" :title="t('compose.toolbar.open')" @click="showListModal = true">☰</button>
          <input
            v-model="comp.name"
            class="cv-name-input"
            :disabled="!isOwner"
            @change="renameComp"
          />
          <span v-if="!isOwner" class="badge-ro">{{ t('compose.toolbar.readonly') }}</span>
        </div>
        <div class="cv-toolbar-right">
          <span v-if="comp.visibility === 'shared'" class="tag tag-ok">{{ t('compose.toolbar.shared') }}</span>
          <button class="btn btn-sm" :disabled="!isOwner" :title="t('compose.toolbar.copy')" @click="duplicateComposition(comp.id)">{{ t('compose.toolbar.copy') }}</button>
          <button class="btn btn-sm btn-danger" :disabled="!isOwner" :title="t('compose.toolbar.delete')" @click="deleteComposition(comp.id)">{{ t('compose.toolbar.delete') }}</button>
          <button class="btn btn-sm" :disabled="!isOwner || !items.filter((i) => i.item_type === 'question').length" :title="t('compose.toolbar.export')" @click="exportVisible = true">{{ t('compose.toolbar.export') }}</button>
        </div>
      </div>

      <p v-if="pageError" class="error-text" style="margin: 8px 0 0">{{ pageError }}</p>

      <!-- 三栏 -->
      <div class="cv-body">
        <!-- 左：题库 -->
        <aside class="cv-panel cv-panel--bank">
          <div class="cv-panel-header">{{ t('compose.panelBank') }}</div>
          <div class="cv-bank-filters">
            <SectionCascadeSelect
              v-model="bank.section"
              :options="cascadeOptions"
              :placeholder="t('compose.filters.allModules')"
              :empty-text="t('cascade.noSections')"
            />
            <MultiSelect
              v-model="bank.years"
              :options="yearMsOptions"
              display-mode="values"
              :show-all-when-all-selected="true"
              :placeholder="t('bank.allYears')"
            />
            <MultiSelect
              v-model="bank.seasons"
              :options="seasonMsOptions"
              display-mode="values"
              :show-all-when-all-selected="true"
              :placeholder="t('bank.allSeasons')"
            />
            <label class="cv-fav-filter">
              <input v-model="bank.favOnly" type="checkbox" />
              <span>{{ t('compose.filters.favOnly') }}</span>
            </label>
          </div>
          <div class="cv-bank-list">
            <div v-if="bankLoading" class="muted" style="padding: 20px; text-align: center; font-size: 13px">{{ t('compose.loading') }}</div>
            <template v-else>
              <div
                v-for="q in bankRows"
                :key="q.id"
                class="cv-bank-item"
                :class="{ 'cv-bank-item--added': isInComposition(q.id), 'cv-bank-item--fav': favIds.has(q.id) }"
                :title="q.question_sections?.map((s) => s.section_name).join(', ')"
                @click="toggleQuestion(q)"
              >
                <span class="cv-bank-check">{{ isInComposition(q.id) ? '✓' : '' }}</span>
                <span class="cv-bank-qno">{{ q.question_no || '?' }}</span>
                <span class="cv-bank-sec">{{ q.question_sections?.[0]?.section_name || '-' }}</span>
                <span class="cv-bank-paper">{{ q.papers?.exam_code || '' }}</span>
                <span v-if="favIds.has(q.id)" class="cv-bank-star">★</span>
              </div>
            </template>
            <div v-if="bankTotal > bank.pageSize" class="cv-bank-pager">
              <button class="btn btn-sm" :disabled="bank.page <= 1" @click="bank.page--; searchBank(false)">‹</button>
              <span>{{ t('compose.pager', { page: bank.page, total: Math.ceil(bankTotal / bank.pageSize) }) }}</span>
              <button class="btn btn-sm" :disabled="bank.page >= Math.ceil(bankTotal / bank.pageSize)" @click="bank.page++; searchBank(false)">›</button>
            </div>
          </div>
        </aside>

        <!-- 中：实时预览 -->
        <section class="cv-panel cv-panel--preview">
          <div class="cv-preview-toolbar">
            <div class="cv-mode-toggle">
              <button :class="{ active: previewMode === 'grouped' }" @click="previewMode = 'grouped'">{{ t('compose.grouped') }}</button>
              <button :class="{ active: previewMode === 'free' }" @click="previewMode = 'free'">{{ t('compose.free') }}</button>
            </div>
            <span class="muted" style="font-size: 12px">{{ t('compose.statsLine', { q: questionItemCount, p: estimatedPages }) }}</span>
          </div>

          <div ref="previewRef" class="cv-preview-scroll">
            <!-- 封面预览 -->
            <div v-if="showCoverPreview" class="cv-page cv-page--cover">
              <div class="cv-cover-frame">
                <div v-if="comp.title" class="cv-cover-title">{{ comp.title }}</div>
                <div v-if="comp.header_text" class="cv-cover-header">{{ comp.header_text }}</div>
                <div v-if="coverLinesList.length" class="cv-cover-lines">
                  <div v-for="(line, idx) in coverLinesList" :key="idx">{{ line || '…' }}</div>
                </div>
                <div class="cv-cover-label">{{ t('compose.preview.coverLabel') }}</div>
              </div>
            </div>

            <div v-if="!items.length && !showCoverPreview" class="cv-preview-empty">
              {{ t('compose.preview.empty') }}
            </div>

            <template v-else>
              <!-- 分组模式 -->
              <template v-if="groupedItems">
                <template v-for="group in groupedItems" :key="group.section">
                  <div v-if="comp.show_section_headers" class="cv-section-header">
                    {{ group.section === '__ungrouped' ? t('compose.preview.ungrouped') : group.section }}
                  </div>
                  <template v-for="item in group.items" :key="item.id">
                    <div
                      v-if="item.item_type === 'question'"
                      class="cv-page"
                      :class="{
                        'cv-page--selected': selectedItemId === item.id,
                        'cv-page--drag-over': dragOverId === item.id && dragSourceId !== item.id,
                        'cv-page--dragging': dragSourceId === item.id,
                      }"
                      draggable="true"
                      @click="selectedItemId = item.id"
                      @dragstart="onDragStart($event, item.id)"
                      @dragover="onDragOver($event, item.id)"
                      @drop="onDrop($event, item.id)"
                      @dragend="onDragEnd"
                    >
                      <div v-if="comp.show_question_info" class="cv-page-header">
                        <span class="cv-page-qno">{{ item.questions?.question_no || '?' }}</span>
                        <span>{{ sectionsOf(item).join(', ') }}</span>
                        <span class="cv-page-source">{{ paperOf(item) }}</span>
                      </div>
                      <div class="cv-page-content">
                        <div class="cv-page-frame">
                          <img
                            v-for="b in boxesOf(item)"
                            :key="b.image_key"
                            class="skel"
                            :src="imageUrl(b.image_key)"
                            alt=""
                            crossorigin="anonymous"
                            loading="lazy"
                            @load="($event.currentTarget as HTMLElement).classList.add('is-loaded')"
                            @error="($event.currentTarget as HTMLElement).classList.add('is-loaded')"
                          />
                          <div v-if="!boxesOf(item).length" class="cv-page-noimg">{{ t('compose.preview.noImage') }}</div>
                        </div>
                      </div>
                    </div>
                    <!-- 附属空白页 -->
                    <div
                      v-for="n in item.item_type === 'question' ? item.blank_pages : 0"
                      :key="`blank-${item.id}-${n}`"
                      class="cv-page cv-page--blank"
                    >
                      <span class="cv-blank-label">{{ t('compose.preview.blank') }}</span>
                    </div>
                    <!-- 独立空白页 -->
                    <div
                      v-if="item.item_type === 'blank_page'"
                      class="cv-page cv-page--blank"
                      :class="{ 'cv-page--selected': selectedItemId === item.id }"
                      @click="selectedItemId = item.id"
                    >
                      <span class="cv-blank-label">{{ t('compose.preview.blank') }}</span>
                    </div>
                  </template>
                </template>
              </template>

              <!-- 自由模式 -->
              <template v-else>
                <template v-for="item in items" :key="item.id">
                  <div
                    v-if="item.item_type === 'question'"
                    class="cv-page"
                    :class="{
                      'cv-page--selected': selectedItemId === item.id,
                      'cv-page--drag-over': dragOverId === item.id && dragSourceId !== item.id,
                      'cv-page--dragging': dragSourceId === item.id,
                    }"
                    draggable="true"
                    @click="selectedItemId = item.id"
                    @dragstart="onDragStart($event, item.id)"
                    @dragover="onDragOver($event, item.id)"
                    @drop="onDrop($event, item.id)"
                    @dragend="onDragEnd"
                  >
                    <div v-if="comp.show_question_info" class="cv-page-header">
                      <span class="cv-page-qno">{{ item.questions?.question_no || '?' }}</span>
                      <span>{{ sectionsOf(item).join(', ') }}</span>
                      <span class="cv-page-source">{{ paperOf(item) }}</span>
                    </div>
                    <div class="cv-page-content">
                      <div class="cv-page-frame">
                        <img
                          v-for="b in boxesOf(item)"
                          :key="b.image_key"
                          class="skel"
                          :src="imageUrl(b.image_key)"
                          alt=""
                          crossorigin="anonymous"
                          loading="lazy"
                          @load="($event.currentTarget as HTMLElement).classList.add('is-loaded')"
                          @error="($event.currentTarget as HTMLElement).classList.add('is-loaded')"
                        />
                        <div v-if="!boxesOf(item).length" class="cv-page-noimg">{{ t('compose.preview.noImage') }}</div>
                      </div>
                    </div>
                  </div>
                  <div
                    v-for="n in item.item_type === 'question' ? item.blank_pages : 0"
                    :key="`blank-${item.id}-${n}`"
                    class="cv-page cv-page--blank"
                  >
                    <span class="cv-blank-label">{{ t('compose.preview.blank') }}</span>
                  </div>
                  <div
                    v-if="item.item_type === 'blank_page'"
                    class="cv-page cv-page--blank"
                    :class="{ 'cv-page--selected': selectedItemId === item.id }"
                    @click="selectedItemId = item.id"
                  >
                    <span class="cv-blank-label">{{ t('compose.preview.blank') }}</span>
                  </div>
                </template>
              </template>
            </template>
          </div>
        </section>

        <!-- 右：统计 + 属性 + 选中项 -->
        <aside class="cv-panel cv-panel--props">
          <div class="cv-props-card">
            <div class="cv-props-title">{{ t('compose.stats.title') }}</div>
            <div class="cv-stats-row">
              <div class="cv-stat-pill"><b>{{ questionItemCount }}</b><span>{{ t('compose.stats.questions') }}</span></div>
              <div class="cv-stat-pill"><b>{{ blankPageCount }}</b><span>{{ t('compose.stats.blanks') }}</span></div>
              <div class="cv-stat-pill"><b>~{{ estimatedPages }}</b><span>{{ t('compose.stats.pages') }}</span></div>
            </div>
          </div>

          <div class="cv-props-card">
            <div class="cv-props-title">{{ t('compose.settings.title') }}</div>
            <label class="cv-prop-label">{{ t('compose.settings.titleLabel') }}</label>
            <input v-model="comp.title" class="cv-prop-input" :disabled="!isOwner" :placeholder="t('compose.settings.titlePh')" @change="persistComp(['title'])" />

            <label class="cv-prop-label">{{ t('compose.settings.header') }}</label>
            <input v-model="comp.header_text" class="cv-prop-input" :disabled="!isOwner" @change="persistComp(['header_text'])" />

            <label class="cv-prop-label">{{ t('compose.settings.coverLines') }}</label>
            <div class="cv-cover-lines-editor">
              <div v-for="(line, idx) in coverLinesList" :key="idx" class="cv-cover-line-row">
                <input class="cv-prop-input" :value="line" :placeholder="t('compose.settings.coverLinePh')" :disabled="!isOwner" @input="updateCoverLine(idx, ($event.target as HTMLInputElement).value)" />
                <button class="cv-cover-line-x" :disabled="!isOwner" @click="removeCoverLine(idx)">×</button>
              </div>
              <div class="cv-cover-presets">
                <button v-for="p in coverLinePresets" :key="p.key" class="btn btn-sm" :disabled="!isOwner" @click="addCoverLine(p.template)">{{ p.label }}</button>
                <button class="btn btn-sm" :disabled="!isOwner" @click="addCoverLine()">{{ t('compose.settings.addLine') }}</button>
              </div>
            </div>

            <label class="cv-prop-label">{{ t('compose.settings.footer') }}</label>
            <input v-model="comp.footer_text" class="cv-prop-input" :disabled="!isOwner" @change="persistComp(['footer_text'])" />

            <label class="cv-prop-check">
              <input v-model="comp.include_answers" type="checkbox" :disabled="!isOwner" @change="persistComp(['include_answers'])" />
              <span>{{ t('compose.settings.includeAnswers') }}</span>
            </label>
            <template v-if="comp.include_answers">
              <label class="cv-prop-label">{{ t('compose.settings.answersPlacement') }}</label>
              <select v-model="comp.answers_placement" class="cv-prop-input" :disabled="!isOwner" @change="persistComp(['answers_placement'])">
                <option value="end">{{ t('compose.settings.placementEnd') }}</option>
                <option value="interleaved">{{ t('compose.settings.placementInterleaved') }}</option>
              </select>
            </template>

            <div class="cv-prop-divider"></div>
            <label class="cv-prop-check">
              <input v-model="comp.show_question_info" type="checkbox" :disabled="!isOwner" @change="persistComp(['show_question_info'])" />
              <span>{{ t('compose.settings.showInfo') }}</span>
            </label>
            <label class="cv-prop-check">
              <input v-model="comp.show_section_headers" type="checkbox" :disabled="!isOwner" @change="persistComp(['show_section_headers'])" />
              <span>{{ t('compose.settings.showSectionHeaders') }}</span>
            </label>
            <label class="cv-prop-check">
              <input v-model="comp.show_page_numbers" type="checkbox" :disabled="!isOwner" @change="persistComp(['show_page_numbers'])" />
              <span>{{ t('compose.settings.showPageNumbers') }}</span>
            </label>

            <div class="cv-prop-divider"></div>
            <label class="cv-prop-check">
              <input
                :checked="comp.visibility === 'shared'"
                type="checkbox"
                :disabled="!isOwner"
                @change="comp.visibility = ($event.target as HTMLInputElement).checked ? 'shared' : 'private'; persistComp(['visibility'])"
              />
              <span>{{ t('compose.settings.share') }}</span>
            </label>
          </div>

          <!-- 选中条目 -->
          <div v-if="selectedItem" class="cv-props-card">
            <div class="cv-props-title">{{ t('compose.selected.title') }}</div>
            <template v-if="selectedItem.item_type === 'question'">
              <div class="cv-sel-info">
                <div><span>{{ t('compose.selected.qno') }}</span><b>{{ selectedItem.questions?.question_no || '?' }}</b></div>
                <div><span>{{ t('compose.selected.source') }}</span><b>{{ paperOf(selectedItem) || '-' }}</b></div>
                <div v-if="sectionsOf(selectedItem).length"><span>{{ t('compose.selected.section') }}</span><b>{{ sectionsOf(selectedItem).join(', ') }}</b></div>
              </div>
              <div class="cv-blank-ctl">
                <span class="cv-prop-label" style="margin: 0">{{ t('compose.selected.blankPages') }}</span>
                <div class="cv-blank-stepper">
                  <button class="btn btn-sm" :disabled="!isOwner" @click="updateBlankPages(selectedItem.id, selectedItem.blank_pages - 1)">−</button>
                  <b>{{ selectedItem.blank_pages }}</b>
                  <button class="btn btn-sm" :disabled="!isOwner" @click="updateBlankPages(selectedItem.id, selectedItem.blank_pages + 1)">+</button>
                </div>
              </div>
            </template>
            <button class="btn btn-sm btn-danger" style="width: 100%" :disabled="!isOwner" @click="removeItemById(selectedItem.id)">
              {{ t('compose.selected.remove') }}
            </button>
            <button
              v-if="selectedItem.item_type === 'question'"
              class="btn btn-sm"
              style="width: 100%"
              :disabled="!isOwner"
              @click="insertBlankAfter(items.findIndex((i) => i.id === selectedItem!.id))"
            >
              {{ t('compose.selected.insertBlank') }}
            </button>
          </div>
        </aside>
      </div>
    </template>

    <div v-else class="cv-empty"><div class="muted">{{ t('compose.loading') }}</div></div>

    <!-- 方案列表弹窗 -->
    <Teleport to="body">
      <div v-if="showListModal" class="cv-modal-overlay" @click.self="showListModal = false">
        <div class="cv-modal">
          <div class="cv-modal-header">
            <h3>{{ t('compose.modal.title') }}</h3>
            <button class="cv-modal-x" @click="showListModal = false">×</button>
          </div>
          <div class="cv-modal-body">
            <div class="cv-new-row">
              <input v-model="newName" class="cv-prop-input" :placeholder="t('compose.modal.namePh')" @keydown.enter="createNew" />
              <button class="btn btn-primary btn-sm" :disabled="!newName.trim()" @click="createNew">{{ t('compose.modal.create') }}</button>
            </div>
            <div class="cv-comp-list">
              <div
                v-for="c in compositions"
                :key="c.id"
                class="cv-comp-item"
                :class="{ 'cv-comp-item--active': c.id === compId }"
                @click="openComposition(c.id)"
              >
                <div style="flex: 1; min-width: 0">
                  <div class="cv-comp-name">{{ c.name }}</div>
                  <div class="cv-comp-meta">{{ t('compose.meta', { n: c.item_count ?? 0, v: c.visibility === 'shared' ? t('compose.vis.shared') : t('compose.vis.private') }) }}</div>
                </div>
                <button class="btn btn-sm" :title="t('compose.toolbar.copy')" @click.stop="duplicateComposition(c.id)">{{ t('compose.toolbar.copy') }}</button>
                <button class="btn btn-sm btn-danger" :title="t('compose.toolbar.delete')" @click.stop="deleteComposition(c.id)">{{ t('compose.toolbar.delete') }}</button>
              </div>
              <div v-if="!compositions.length" class="muted" style="padding: 24px; text-align: center">{{ t('compose.modal.empty') }}</div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 组卷导出 -->
    <ExportDialog
      v-model:visible="exportVisible"
      :provider="exportProvider"
      :default-filename="exportFilenameDefault"
      :preset="exportPreset"
      :show-summary="false"
    />
  </div>
</template>
