<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { getSupabase, imageUrl } from '@/lib/supabase'
import { useAuth } from '@/composables/auth'
import { useDialog } from '@/composables/dialog'
import SectionCascadeSelect from '@/components/SectionCascadeSelect.vue'
import MultiSelect from '@/components/MultiSelect.vue'
import ExportDialog from '@/components/ExportDialog.vue'
import { buildCascadeOptions, fetchSectionsGraph, UNSET_SECTION, type CascadeGroup } from '@/lib/sections'
import { fetchAnswerBoxes } from '@/lib/exportData'
import { checkCompositionQuota, quotaErrorKey } from '@/lib/quota'
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
  visibility: 'private' | 'view' | 'edit'
  owner_id: string
}

interface QLite {
  id: number
  question_no: string | null
  section: string | null
  notes: string | null
  difficulty: number | null
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
  difficulty: number | null
  papers: { exam_code: string | null } | null
  question_sections: { section_name: string }[]
}

interface CompListItem {
  id: string
  name: string
  visibility: string
  item_count?: number
  owner_id: string | null
  owner_email: string | null
  is_mine: boolean
}

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const dialog = useDialog()

// ---------- 状态 ----------
const comp = ref<Comp | null>(null)
const items = ref<Item[]>([])
const pageError = ref('')
const showListModal = ref(false)
const newName = ref('')
const compositions = ref<CompListItem[]>([])
const selectedItemId = ref<number | null>(null)
const persistedSortOrder = new Map<number, number>()
const previewMode = ref<'grouped' | 'free'>('free')

const bank = reactive({
  section: '',
  years: [] as string[],
  seasons: [] as string[],
  difficulties: [] as string[], // '1'..'5' | 'unset'
  favOnly: false,
  page: 1,
  pageSize: 50,
})

const difficultyMsOptions = [
  { value: '1', label: '1 ★' },
  { value: '2', label: '2 ★' },
  { value: '3', label: '3 ★' },
  { value: '4', label: '4 ★' },
  { value: '5', label: '5 ★' },
  { value: 'unset', label: t('compose.filters.difficultyUnset') },
]
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
  if (bank.difficulties.length) {
    const wanted = new Set(bank.difficulties)
    list = list.filter((q) => {
      if (q.difficulty == null) return wanted.has('unset')
      return wanted.has(String(q.difficulty))
    })
  }
  return list
})
const bankTotal = computed(() => bankFiltered.value.length)
const bankRows = computed(() => {
  const from = (bank.page - 1) * bank.pageSize
  return bankFiltered.value.slice(from, from + bank.pageSize)
})

const dragSourceId = ref<number | null>(null)
const dragOverId = ref<number | null>(null)
const showSettings = ref(false)
const mobileTab = ref<'bank' | 'preview'>('preview')
/** 乐观占位：id < 0 表示还在等服务端回包 */
let tempSeq = 0
const loadingIds = ref<Set<number>>(new Set())

const compId = computed(() => (route.params.id as string | undefined) ?? null)
const isOwner = computed(() => !!comp.value && comp.value.owner_id === auth.session?.user.id)
const isAdmin = computed(() => auth.profile?.role === 'admin')
/** 可编辑：本人 / admin / 共享可编辑 */
const canEdit = computed(() => {
  if (!comp.value) return false
  if (isOwner.value || isAdmin.value) return true
  return normalizeVis(comp.value.visibility) === 'edit'
})
/** 可改共享范围：仅本人（admin 可代管） */
const canShare = computed(() => isOwner.value || isAdmin.value)
/** 可查看（只要能打开就成立） */
const canView = computed(() => !!comp.value)

/** 旧值 shared 视作 view */
function normalizeVis(v: string): Comp['visibility'] {
  return v === 'shared' ? 'view' : (v as Comp['visibility'])
}
function visLabel(v: string): string {
  const n = normalizeVis(v)
  return n === 'edit' ? t('compose.vis.edit') : n === 'view' ? t('compose.vis.view') : t('compose.vis.private')
}

const shareError = ref('')
const shareBusy = ref(false)

/** 切换共享范围（仅 owner/admin）。失败时回滚并提示。 */
async function setVisibility(v: Comp['visibility']) {
  if (!comp.value || !canShare.value || shareBusy.value) return
  if (normalizeVis(comp.value.visibility) === v) return
  const prev = comp.value.visibility
  comp.value.visibility = v
  shareBusy.value = true
  shareError.value = ''
  try {
    const { error } = await getSupabase()
      .from('compositions')
      .update({ visibility: v })
      .eq('id', comp.value.id)
    if (error) {
      comp.value.visibility = prev
      shareError.value = error.message
      return
    }
    await loadCompositions()
  } finally {
    shareBusy.value = false
  }
}

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
  // 封面行编辑高频，防抖落库
  persistCompSoft(['cover_lines'])
}

function addCoverLine(template = '') {
  if (!canEdit.value) return
  saveCoverLines([...coverLinesList.value, template])
}
function updateCoverLine(idx: number, v: string) {
  if (!canEdit.value) return
  const list = [...coverLinesList.value]
  list[idx] = v
  saveCoverLines(list)
}
function removeCoverLine(idx: number) {
  if (!canEdit.value) return
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

/** 统一预览分组：grouped 按模块，free 单组自由序 */
const previewGroups = computed<Group[]>(() => {
  if (previewMode.value === 'grouped' && groupedItems.value) return groupedItems.value
  return [{ section: '', items: items.value }]
})

// ---------- 工具 ----------
const selectedDifficultyLabel = computed(() => {
  const d = selectedItem.value?.item_type === 'question' ? selectedItem.value.questions?.difficulty : null
  if (d == null) return t('compose.filters.difficultyUnset')
  return d + ' ★'
})

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
const onlyMine = ref(false)

const visibleCompositions = computed(() => {
  if (!onlyMine.value) return compositions.value
  return compositions.value.filter((c) => c.is_mine)
})

async function loadCompositions() {
  const uid = auth.session?.user.id
  const { data, error } = await getSupabase()
    .from('compositions')
    .select('id,name,visibility,owner_id,composition_items(count),profiles(email)')
    .order('updated_at', { ascending: false })
  if (error) {
    pageError.value = error.message
    return
  }
  compositions.value = ((data ?? []) as unknown as {
    id: string
    name: string
    visibility: string
    owner_id: string | null
    composition_items: { count: number }[] | null
    profiles: { email: string | null } | { email: string | null }[] | null
  }[]).map((c) => {
    const profRaw = c.profiles
    const prof = Array.isArray(profRaw) ? (profRaw[0] ?? null) : profRaw
    return {
      id: c.id,
      name: c.name,
      visibility: c.visibility,
      item_count: c.composition_items?.[0]?.count ?? 0,
      owner_id: c.owner_id,
      owner_email: prof?.email ?? null,
      is_mine: !!uid && c.owner_id === uid,
    }
  })
}

async function openComposition(id: string) {
  showListModal.value = false
  router.push({ name: 'compose', params: { id } })
}

async function createNew() {
  const name = newName.value.trim()
  if (!name) return
  if ((await checkCompositionQuota()) === 'comp') {
    pageError.value = t('quota.compReached')
    return
  }
  const { data, error } = await getSupabase()
    .from('compositions')
    .insert({ name, owner_id: auth.session!.user.id })
    .select('id')
    .single()
  if (error) {
    const qKey = quotaErrorKey(error)
    pageError.value = qKey ? t(qKey) : error.message
    return
  }
  newName.value = ''
  await openComposition((data as { id: string }).id)
}

/** 空态「新建方案」：不弹列表，直接建 */
const creating = ref(false)

/** 未命名方案 / 未命名方案 2 / … 不重名 */
async function nextUntitledName(): Promise<string> {
  const base = t('compose.untitled')
  const user = auth.session?.user.id
  if (!user) return base
  const { data } = await getSupabase()
    .from('compositions')
    .select('name')
    .eq('owner_id', user)
    .like('name', base + '%')
  const names = new Set((data ?? []).map((x: { name: string }) => x.name))
  if (!names.has(base)) return base
  for (let i = 2; i < 500; i++) {
    const n = base + ' ' + i
    if (!names.has(n)) return n
  }
  return base + ' ' + Date.now()
}

/** 空态「新建方案」：不弹列表，直接建 */
async function createNewDirect() {
  if (creating.value) return
  creating.value = true
  try {
    newName.value = await nextUntitledName()
    await createNew()
  } finally {
    creating.value = false
  }
}

async function duplicateComposition(id: string) {
  if ((await checkCompositionQuota()) === 'comp') {
    pageError.value = t('quota.compReached')
    return
  }
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
    const qKey = quotaErrorKey(e2)
    pageError.value = qKey ? t(qKey) : e2.message
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
  const ok = await dialog.confirm(t('compose.confirmDelete', { name: c?.name ?? '' }), {
    title: t('compose.confirmDeleteTitle'),
    confirmText: t('dialog.delete'),
    danger: true,
  })
  if (!ok) return

  // 先从 UI 移除（立即反馈），网络删除后台完成
  const snapshot = compositions.value
  compositions.value = compositions.value.filter((x) => x.id !== id)
  if (compId.value === id) router.push({ name: 'compose-new' })

  const { error } = await getSupabase().from('compositions').delete().eq('id', id)
  if (error) {
    compositions.value = snapshot
    pageError.value = error.message
    return
  }
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
    comp.value = { ...(c as Comp), visibility: normalizeVis((c as Comp).visibility) }
    const { data: its, error: ie } = await sb
      .from('composition_items')
      .select(
        `id, composition_id, question_id, sort_order, item_type, blank_pages,
         questions ( id, question_no, section, notes, difficulty, papers ( exam_code, year_token, filename ), question_sections ( section_name ), question_boxes ( image_key, page ) )`,
      )
      .eq('composition_id', id)
      .order('sort_order')
    if (ie) throw ie
    items.value = ((its ?? []) as unknown as Item[]).map((it) => ({ ...it, questions: normalizeQ(it.questions) }))
    persistedSortOrder.clear()
    for (const item of items.value) persistedSortOrder.set(item.id, item.sort_order)
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
/** 文本类保存防抖，避免每次按键打库 */
function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: A) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, ms)
  }
}

async function persistCompNow(fields: (keyof Comp)[]) {
  if (!comp.value || !canEdit.value) return
  const body: Record<string, unknown> = {}
  for (const f of fields) body[f as string] = comp.value[f]
  const { error } = await getSupabase().from('compositions').update(body).eq('id', comp.value.id)
  if (error) pageError.value = error.message
}

/** 设置字段：UI 已由 v-model 乐观更新，这里只负责落库 */
function persistComp(fields: (keyof Comp)[]) {
  void persistCompNow(fields)
}

const persistCompDebounced = debounce((fields: (keyof Comp)[]) => {
  void persistCompNow(fields)
}, 350)

function persistCompSoft(fields: (keyof Comp)[]) {
  persistCompDebounced(fields)
}

async function renameComp() {
  await persistCompNow(['name'])
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
        `id, question_no, section, difficulty,
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
    // 失败保留旧列表，避免面板闪空
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
  () => [bank.section, bank.favOnly, bank.difficulties.join(',')],
  () => {
    bank.page = 1
  },
)

const ITEM_SELECT = `id, composition_id, question_id, sort_order, item_type, blank_pages,
       questions ( id, question_no, section, notes, difficulty, papers ( exam_code, year_token, filename ), question_sections ( section_name ), question_boxes ( image_key, page ) )`

function makeOptimisticQuestion(q: BankQ): Item {
  return {
    id: --tempSeq,
    composition_id: comp.value!.id,
    question_id: q.id,
    sort_order: items.value.length,
    item_type: 'question',
    blank_pages: 0,
    questions: {
      id: q.id,
      question_no: q.question_no,
      section: q.section,
      notes: null,
      difficulty: q.difficulty ?? null,
      papers: q.papers ? { exam_code: q.papers.exam_code, year_token: null, filename: '' } : null,
      question_sections: q.question_sections ?? [],
      question_boxes: [],
    },
  }
}

function swapItem(tempId: number, real: Item) {
  const idx = items.value.findIndex((i) => i.id === tempId)
  if (idx >= 0) items.value.splice(idx, 1, real)
  else items.value = [...items.value, real]
  loadingIds.value.delete(tempId)
  loadingIds.value.delete(real.id)
}

async function toggleQuestion(q: BankQ) {
  if (!canEdit.value || !comp.value) return
  const sb = getSupabase()
  const existing = items.value.find((i) => i.question_id === q.id)
  if (existing) {
    // 乐观移除：列表先消失，网络回包后台补
    const removedId = existing.id
    const backup = items.value
    items.value = items.value.filter((i) => i.id !== removedId)
    if (selectedItemId.value === removedId) selectedItemId.value = null
    renumber()
    void (async () => {
      const { error } = await sb.from('composition_items').delete().eq('id', removedId)
      if (error) {
        items.value = backup
        pageError.value = error.message
        return
      }
      void persistOrder()
    })()
    return
  }
  // 乐观加题：立刻进预览，回包后换成带裁剪图的真数据
  const optimistic = makeOptimisticQuestion(q)
  loadingIds.value.add(optimistic.id)
  items.value = [...items.value, optimistic]
  renumber()
  void (async () => {
    const { data, error } = await sb
      .from('composition_items')
      .insert({
        composition_id: comp.value!.id,
        question_id: q.id,
        sort_order: optimistic.sort_order,
        item_type: 'question',
        blank_pages: 0,
      })
      .select(ITEM_SELECT)
      .single()
    if (error) {
      items.value = items.value.filter((i) => i.id !== optimistic.id)
      loadingIds.value.delete(optimistic.id)
      if (error.code !== '23505') pageError.value = error.message
      return
    }
    const real = {
      ...(data as unknown as Item),
      questions: normalizeQ((data as { questions: unknown }).questions),
    }
    swapItem(optimistic.id, real)
    // 追加到末尾时 sort_order 已正确，无需全量重写
  })()
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

/** 排序落库：乐观已改 UI，这里防抖批量写，失败只提示不回滚列表 */
const persistOrder = debounce(() => {
  if (!canEdit.value) return
  const sb = getSupabase()
  const snapshot = items.value.map((it) => ({ id: it.id, sort_order: it.sort_order }))
  void Promise.all(
    snapshot
      .filter((it) => it.id > 0 && persistedSortOrder.get(it.id) !== it.sort_order)
      .map((it) =>
        sb
          .from('composition_items')
          .update({ sort_order: it.sort_order })
          .eq('id', it.id)
          .then(({ error }) => {
            if (error) {
              pageError.value = error.message
              return
            }
            persistedSortOrder.set(it.id, it.sort_order)
          }),
      ),
  )
}, 180)

async function insertBlankAfter(index: number) {
  if (!canEdit.value || !comp.value || index < 0) return
  const tempId = --tempSeq
  const optimistic: Item = {
    id: tempId,
    composition_id: comp.value.id,
    question_id: null,
    sort_order: index + 1,
    item_type: 'blank_page',
    blank_pages: 0,
    questions: null,
  }
  loadingIds.value.add(tempId)
  items.value.splice(index + 1, 0, optimistic)
  renumber()
  void (async () => {
    const { data, error } = await getSupabase()
      .from('composition_items')
      .insert({
        composition_id: comp.value!.id,
        question_id: null,
        sort_order: optimistic.sort_order,
        item_type: 'blank_page',
        blank_pages: 0,
      })
      .select('id, composition_id, question_id, sort_order, item_type, blank_pages')
      .single()
    if (error) {
      items.value = items.value.filter((i) => i.id !== tempId)
      loadingIds.value.delete(tempId)
      pageError.value = error.message
      return
    }
    swapItem(tempId, { ...(data as unknown as Item), questions: null })
    void persistOrder()
  })()
}

async function removeItemById(id: number) {
  if (!canEdit.value) return
  const backup = items.value
  items.value = items.value.filter((i) => i.id !== id)
  if (selectedItemId.value === id) selectedItemId.value = null
  renumber()
  void (async () => {
    const { error } = await getSupabase().from('composition_items').delete().eq('id', id)
    if (error) {
      items.value = backup
      pageError.value = error.message
      return
    }
    void persistOrder()
  })()
}

function onDragStart(e: DragEvent, id: number) {
  if (!canEdit.value) {
    e.preventDefault()
    return
  }
  if (ptrActive) {
    e.preventDefault()
    return
  }
  dragSourceId.value = id
  e.dataTransfer?.setData('text/plain', String(id))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

// 指针拖拽：兼容鼠标 + 触屏（HTML5 DnD 触屏不可用）
let ptrId: number | null = null
let ptrStartY = 0
let ptrActive = false

function onPointerDown(e: PointerEvent, id: number) {
  if (!canEdit.value) return
  if (e.button != null && e.button !== 0) return
  // 输入框等可交互元素不启动拖拽
  const target = e.target as HTMLElement | null
  if (target?.closest('input, textarea, select, button, a')) return
  ptrId = id
  ptrStartY = e.clientY
  ptrActive = false
}

function onPointerMove(e: PointerEvent, id: number) {
  if (!canEdit.value) return
  if (ptrId !== id) return
  if (!ptrActive) {
    if (Math.abs(e.clientY - ptrStartY) < 6) return
    ptrActive = true
    dragSourceId.value = id
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  e.preventDefault()
  const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
  let page = (el?.closest?.('.cv-page') ?? null) as HTMLElement | null
  if (!page) {
    // 落在空隙/滚动条上时，按 Y 就近找页卡
    const all = Array.from(document.querySelectorAll<HTMLElement>('.cv-page'))
    let best: HTMLElement | null = null
    let bestDist = Infinity
    for (const node of all) {
      const r = node.getBoundingClientRect()
      const mid = r.top + r.height / 2
      const dist = Math.abs(mid - e.clientY)
      if (dist < bestDist) {
        bestDist = dist
        best = node
      }
    }
    page = best
  }
  const raw = page?.dataset?.itemId
  const targetId = raw != null && raw !== '' ? Number(raw) : null
  if (targetId != null && !Number.isNaN(targetId) && targetId !== id) dragOverId.value = targetId
  else dragOverId.value = null
}

function onPointerUp(_e: PointerEvent, id: number) {
  if (ptrId !== id) return
  const wasActive = ptrActive
  const overId = dragOverId.value
  ptrId = null
  ptrActive = false
  dragSourceId.value = null
  dragOverId.value = null
  if (!wasActive || overId == null || overId === id) return
  const from = items.value.findIndex((i) => i.id === id)
  const to = items.value.findIndex((i) => i.id === overId)
  if (from < 0 || to < 0) return
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
function onDragOver(e: DragEvent, id: number) {
  if (!canEdit.value) return
  if (dragSourceId.value == null || dragSourceId.value === id) return
  e.preventDefault()
  dragOverId.value = id
}
function onDrop(e: DragEvent, targetId: number) {
  if (!canEdit.value) return
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
  // 指针拖拽进行中时忽略 HTML5 dragend，避免清掉状态
  if (ptrActive) return
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

onMounted(() => {
  // 方案优先渲染；题库/筛选并行，不阻塞打开
  if (compId.value) void loadAll(compId.value)
  void loadFilterOptions()
  void loadCompositions()
  void searchBank()
  void loadFavIds()
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
          <button class="btn" :disabled="creating" @click="createNewDirect">{{ creating ? t('compose.modal.create') : t('compose.empty.new') }}</button>
        </div>
      </div>
    </div>

    <!-- ═══ 主界面 ═══ -->
    <template v-else-if="comp">
      <!-- 工具栏 -->
      <div class="cv-toolbar">
        <div class="cv-toolbar-left">
          <button class="btn btn-soft btn-icon" :title="t('compose.toolbar.open')" @click="showListModal = true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="7" x2="21" y2="7"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="17" x2="21" y2="17"/></svg>
          </button>
          <input
            v-model="comp.name"
            class="cv-name-input"
            :disabled="!canEdit"
            @change="renameComp"
          />
          <span v-if="!canEdit" class="badge-ro">{{ t('compose.toolbar.readonly') }}</span>
          <span v-else-if="comp.visibility === 'edit' && !isOwner" class="tag tag-ok">{{ t('compose.vis.edit') }}</span>
          <span v-else-if="comp.visibility !== 'private'" class="tag tag-ok">{{ t('compose.toolbar.shared') }}</span>
        </div>
        <div class="cv-toolbar-right">
          <button class="btn btn-soft" :title="t('compose.settings.title')" @click="showSettings = true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            <span class="btn-text">{{ t('compose.settings.title') }}</span>
          </button>
          <button class="btn btn-soft" :disabled="!canView" :title="t('compose.toolbar.copy')" @click="duplicateComposition(comp.id)">{{ t('compose.toolbar.copy') }}</button>
          <button class="btn btn-danger" :disabled="!isOwner" :title="t('compose.toolbar.delete')" @click="deleteComposition(comp.id)">{{ t('compose.toolbar.delete') }}</button>
          <button
            class="btn btn-primary"
            :disabled="!items.filter((i) => i.item_type === 'question').length"
            :title="t('compose.toolbar.export')"
            @click="exportVisible = true"
          >{{ t('compose.toolbar.export') }}</button>
        </div>
      </div>

      <!-- 手机分段：题目 / 预览 -->
      <div class="cv-segment">
        <button :class="{ active: mobileTab === 'bank' }" @click="mobileTab = 'bank'">{{ t('compose.segment.bank') }}</button>
        <button :class="{ active: mobileTab === 'preview' }" @click="mobileTab = 'preview'">{{ t('compose.segment.preview') }}</button>
      </div>

      <p v-if="pageError" class="error-text" style="margin: 8px 0 0">{{ pageError }}</p>

      <!-- 三栏 -->
      <div class="cv-body">
        <!-- 左：题库 -->
        <aside class="cv-panel cv-panel--bank" :class="{ 'cv-panel--m-hide': mobileTab !== 'bank' }">
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
            <MultiSelect
              v-model="bank.difficulties"
              :options="difficultyMsOptions"
              display-mode="values"
              :show-all-when-all-selected="true"
              :placeholder="t('compose.filters.allDifficulties')"
            />
            <label class="cv-fav-filter">
              <input v-model="bank.favOnly" type="checkbox" />
              <span>{{ t('compose.filters.favOnly') }}</span>
            </label>
          </div>
          <div class="cv-bank-list">
            <div v-if="bankLoading && !bankRows.length" class="muted" style="padding: 20px; text-align: center; font-size: 13px">{{ t('compose.loading') }}</div>
            <template v-else>
              <div
                v-for="q in bankRows"
                :key="q.id"
                class="cv-bank-item"
                :class="{ 'cv-bank-item--added': isInComposition(q.id), 'cv-bank-item--fav': favIds.has(q.id), 'cv-bank-item--busy': bankLoading }"
                :title="q.question_sections?.map((s) => s.section_name).join(', ')"
                @click="toggleQuestion(q)"
              >
                <span class="cv-bank-check">{{ isInComposition(q.id) ? '✓' : '' }}</span>
                <span class="cv-bank-qno">{{ q.question_no || '?' }}</span>
                <span class="cv-bank-sec">{{ q.question_sections?.[0]?.section_name || '-' }}</span>
                <span class="cv-bank-paper">{{ q.papers?.exam_code || '' }}</span>
                <span v-if="q.difficulty" class="cv-bank-diff" :title="`${q.difficulty}/5`">{{ q.difficulty }}★</span>
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
              <button :class="{ active: previewMode === 'free' }" @click="previewMode = 'free'">{{ t('compose.free') }}</button>
              <button :class="{ active: previewMode === 'grouped' }" @click="previewMode = 'grouped'">{{ t('compose.grouped') }}</button>
            </div>
            <div class="cv-stats-inline">
              <span class="cv-stat-pill"><b>{{ questionItemCount }}</b><span>{{ t('compose.stats.questions') }}</span></span>
              <span class="cv-stat-pill"><b>{{ blankPageCount }}</b><span>{{ t('compose.stats.blanks') }}</span></span>
              <span class="cv-stat-pill"><b>~{{ estimatedPages }}</b><span>{{ t('compose.stats.pages') }}</span></span>
            </div>
          </div>

          <div ref="previewRef" class="cv-preview-scroll protected">
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
              <template v-for="group in previewGroups" :key="group.section || 'free'">
                <div v-if="previewMode === 'grouped' && comp.show_section_headers && group.section" class="cv-section-header">
                  {{ group.section === '__ungrouped' ? t('compose.preview.ungrouped') : group.section }}
                </div>
                <template v-for="item in group.items" :key="item.id">
                  <!-- question page -->
                  <div
                    v-if="item.item_type === 'question'"
                    class="cv-page"
                    :data-item-id="item.id"
                    :class="{
                      'cv-page--selected': selectedItemId === item.id,
                      'cv-page--drag-over': dragOverId === item.id && dragSourceId !== item.id,
                      'cv-page--dragging': dragSourceId === item.id,
                    }"
                    :draggable="canEdit"
                    @click="selectedItemId = item.id"
                    @dragstart="onDragStart($event, item.id)"
                    @dragover="onDragOver($event, item.id)"
                    @drop="onDrop($event, item.id)"
                    @dragend="onDragEnd"
                    @pointerdown="onPointerDown($event, item.id)"
                    @pointermove="onPointerMove($event, item.id)"
                    @pointerup="onPointerUp($event, item.id)"
                    @pointercancel="onPointerUp($event, item.id)"
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
                        <div v-if="loadingIds.has(item.id)" class="cv-page-noimg skel">{{ t('compose.loading') }}</div>
                        <div v-else-if="!boxesOf(item).length" class="cv-page-noimg">{{ t('compose.preview.noImage') }}</div>
                      </div>
                    </div>
                  </div>
                  <!-- attached blank pages (legacy, read-only render) -->
                  <div
                    v-for="n in item.item_type === 'question' ? item.blank_pages : 0"
                    :key="`blank-${item.id}-${n}`"
                    class="cv-page cv-page--blank cv-page--attached"
                  >
                    <span class="cv-blank-label">{{ t('compose.preview.blank') }}</span>
                  </div>
                  <!-- independent blank page -->
                  <div
                    v-if="item.item_type === 'blank_page'"
                    class="cv-page cv-page--blank"
                    :data-item-id="item.id"
                    :class="{
                      'cv-page--selected': selectedItemId === item.id,
                      'cv-page--drag-over': dragOverId === item.id && dragSourceId !== item.id,
                      'cv-page--dragging': dragSourceId === item.id,
                    }"
                    :draggable="canEdit"
                    @click="selectedItemId = item.id"
                    @dragstart="onDragStart($event, item.id)"
                    @dragover="onDragOver($event, item.id)"
                    @drop="onDrop($event, item.id)"
                    @dragend="onDragEnd"
                    @pointerdown="onPointerDown($event, item.id)"
                    @pointermove="onPointerMove($event, item.id)"
                    @pointerup="onPointerUp($event, item.id)"
                    @pointercancel="onPointerUp($event, item.id)"
                  >
                    <span class="cv-blank-label">{{ t('compose.preview.blank') }}</span>
                  </div>
                </template>
              </template>
            </template>
          </div>
        </section>

        <!-- 右：选中条目 -->
        <aside class="cv-panel cv-panel--props" :class="{ 'cv-panel--m-hide': mobileTab !== 'preview' }">
          <div v-if="selectedItem" class="cv-props-card">
            <div class="cv-props-title">{{ t('compose.selected.title') }}</div>
            <template v-if="selectedItem.item_type === 'question'">
              <div class="cv-sel-info">
                <div><span>{{ t('compose.selected.qno') }}</span><b>{{ selectedItem.questions?.question_no || '?' }}</b></div>
                <div><span>{{ t('compose.selected.source') }}</span><b>{{ paperOf(selectedItem) || '-' }}</b></div>
                <div v-if="sectionsOf(selectedItem).length"><span>{{ t('compose.selected.section') }}</span><b>{{ sectionsOf(selectedItem).join(', ') }}</b></div>
                <div><span>{{ t('compose.selected.difficulty') }}</span><b>{{ selectedDifficultyLabel }}</b></div>
              </div>
            </template>
            <template v-else>
              <div class="cv-sel-info">
                <div><span>{{ t('compose.preview.blank') }}</span><b>#{{ selectedItem.sort_order + 1 }}</b></div>
              </div>
            </template>
            <button
              class="btn btn-sm"
              style="width: 100%"
              :disabled="!canEdit"
              @click="insertBlankAfter(items.findIndex((i) => i.id === selectedItem!.id))"
            >
              {{ t('compose.selected.insertBlank') }}
            </button>
            <button class="btn btn-sm btn-danger" style="width: 100%" :disabled="!canEdit" @click="removeItemById(selectedItem.id)">
              {{ t('compose.selected.remove') }}
            </button>
          </div>
          <div v-else class="cv-props-card cv-props-empty">
            <div class="muted">{{ t('compose.selected.emptyHint') }}</div>
          </div>
        </aside>
      </div>

      <!-- 手机底部操作条 -->
      <div v-if="selectedItem" class="cv-mobile-bar">
        <button class="btn btn-soft btn-sm" :disabled="!canEdit" @click="insertBlankAfter(items.findIndex((i) => i.id === selectedItem!.id))">
          {{ t('compose.selected.insertBlank') }}
        </button>
        <button class="btn btn-danger btn-sm" :disabled="!canEdit" @click="removeItemById(selectedItem.id)">
          {{ t('compose.selected.remove') }}
        </button>
      </div>
    </template>

    <div v-else class="cv-empty">
      <div v-if="pageError" class="error-text">{{ pageError }}</div>
      <div v-else class="muted">{{ t('compose.loading') }}</div>
    </div>

    <!-- 试卷设置弹层 -->
    <Teleport to="body">
      <div v-if="showSettings && comp" class="cv-modal-overlay" @click.self="showSettings = false">
        <div class="cv-modal cv-modal--settings">
          <div class="cv-modal-header">
            <h3>{{ t('compose.settings.title') }}</h3>
            <button class="cv-modal-x" @click="showSettings = false">×</button>
          </div>
          <div class="cv-modal-body">
            <label class="cv-prop-label">{{ t('compose.settings.titleLabel') }}</label>
            <input v-model="comp.title" class="cv-prop-input" :disabled="!canEdit" :placeholder="t('compose.settings.titlePh')" @input="persistCompSoft(['title'])" @change="persistComp(['title'])" />

            <label class="cv-prop-label">{{ t('compose.settings.header') }}</label>
            <input v-model="comp.header_text" class="cv-prop-input" :disabled="!canEdit" @input="persistCompSoft(['header_text'])" @change="persistComp(['header_text'])" />

            <label class="cv-prop-label">{{ t('compose.settings.coverLines') }}</label>
            <div class="cv-cover-lines-editor">
              <div v-for="(line, idx) in coverLinesList" :key="idx" class="cv-cover-line-row">
                <input class="cv-prop-input" :value="line" :placeholder="t('compose.settings.coverLinePh')" :disabled="!canEdit" @input="updateCoverLine(idx, ($event.target as HTMLInputElement).value)" />
                <button class="cv-cover-line-x" :disabled="!canEdit" @click="removeCoverLine(idx)">×</button>
              </div>
              <div class="cv-cover-presets">
                <div class="cv-chip-row">
                  <button v-for="p in coverLinePresets" :key="p.key" class="btn btn-soft btn-sm" :disabled="!canEdit" @click="addCoverLine(p.template)">{{ p.label }}</button>
                  <button class="btn btn-sm" :disabled="!canEdit" @click="addCoverLine()">{{ t('compose.settings.addLine') }}</button>
                </div>
              </div>
            </div>

            <label class="cv-prop-label">{{ t('compose.settings.footer') }}</label>
            <input v-model="comp.footer_text" class="cv-prop-input" :disabled="!canEdit" @input="persistCompSoft(['footer_text'])" @change="persistComp(['footer_text'])" />

            <label class="cv-prop-check">
              <input v-model="comp.include_answers" type="checkbox" :disabled="!canEdit" @change="persistComp(['include_answers'])" />
              <span>{{ t('compose.settings.includeAnswers') }}</span>
            </label>
            <template v-if="comp.include_answers">
              <label class="cv-prop-label">{{ t('compose.settings.answersPlacement') }}</label>
              <select v-model="comp.answers_placement" class="cv-prop-input" :disabled="!canEdit" @change="persistComp(['answers_placement'])">
                <option value="end">{{ t('compose.settings.placementEnd') }}</option>
                <option value="interleaved">{{ t('compose.settings.placementInterleaved') }}</option>
              </select>
            </template>

            <div class="cv-prop-divider"></div>
            <label class="cv-prop-check">
              <input v-model="comp.show_question_info" type="checkbox" :disabled="!canEdit" @change="persistComp(['show_question_info'])" />
              <span>{{ t('compose.settings.showInfo') }}</span>
            </label>
            <label class="cv-prop-check">
              <input v-model="comp.show_section_headers" type="checkbox" :disabled="!canEdit" @change="persistComp(['show_section_headers'])" />
              <span>{{ t('compose.settings.showSectionHeaders') }}</span>
            </label>
            <label class="cv-prop-check">
              <input v-model="comp.show_page_numbers" type="checkbox" :disabled="!canEdit" @change="persistComp(['show_page_numbers'])" />
              <span>{{ t('compose.settings.showPageNumbers') }}</span>
            </label>

            <div class="cv-prop-divider"></div>
            <label class="cv-prop-label">{{ t('compose.settings.shareLevel') }}</label>
            <div class="cv-share-opts">
              <label class="cv-prop-check" :class="{ 'is-active': normalizeVis(comp.visibility) === 'private' }">
                <input
                  type="radio"
                  name="cv-share"
                  value="private"
                  :checked="normalizeVis(comp.visibility) === 'private'"
                  :disabled="!canShare || shareBusy"
                  @change="setVisibility('private')"
                />
                <span>{{ t('compose.vis.private') }}</span>
              </label>
              <label class="cv-prop-check" :class="{ 'is-active': normalizeVis(comp.visibility) === 'view' }">
                <input
                  type="radio"
                  name="cv-share"
                  value="view"
                  :checked="normalizeVis(comp.visibility) === 'view'"
                  :disabled="!canShare || shareBusy"
                  @change="setVisibility('view')"
                />
                <span>{{ t('compose.vis.view') }}</span>
              </label>
              <label class="cv-prop-check" :class="{ 'is-active': normalizeVis(comp.visibility) === 'edit' }">
                <input
                  type="radio"
                  name="cv-share"
                  value="edit"
                  :checked="normalizeVis(comp.visibility) === 'edit'"
                  :disabled="!canShare || shareBusy"
                  @change="setVisibility('edit')"
                />
                <span>{{ t('compose.vis.edit') }}</span>
              </label>
            </div>
            <p v-if="shareError" class="cv-share-error">{{ shareError }}</p>
            <p class="muted" style="font-size: 12px; margin: 8px 0 0">{{ t('compose.settings.shareHint') }}</p>
          </div>
        </div>
      </div>
    </Teleport>

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
            <div class="cv-list-toolbar">
              <label class="cv-prop-check cv-list-check">
                <input v-model="onlyMine" type="checkbox" />
                <span>{{ t('compose.modal.onlyMine') }}</span>
              </label>
              <span class="muted">{{ t('compose.modal.count', { n: visibleCompositions.length }) }}</span>
            </div>
            <div class="cv-comp-list">
              <div
                v-for="c in visibleCompositions"
                :key="c.id"
                class="cv-comp-item"
                :class="{ 'cv-comp-item--active': c.id === compId }"
                @click="openComposition(c.id)"
              >
                <div style="flex: 1; min-width: 0">
                  <div class="cv-comp-name">{{ c.name }}</div>
                  <div class="cv-comp-meta">
                    {{
                      t('compose.meta', {
                        n: c.item_count ?? 0,
                        v: visLabel(c.visibility),
                        owner: c.is_mine
                          ? t('compose.modal.ownerMe')
                          : c.owner_email || t('compose.modal.ownerOther'),
                      })
                    }}
                  </div>
                </div>
                <div class="cv-row-actions">
                  <button class="btn btn-soft btn-sm" :title="t('compose.toolbar.copy')" @click.stop="duplicateComposition(c.id)">{{ t('compose.toolbar.copy') }}</button>
                  <button
                    class="btn btn-danger btn-sm"
                    :title="t('compose.toolbar.delete')"
                    :disabled="!c.is_mine && !isAdmin"
                    @click.stop="deleteComposition(c.id)"
                  >{{ t('compose.toolbar.delete') }}</button>
                </div>
              </div>
              <div v-if="!visibleCompositions.length" class="muted" style="padding: 24px; text-align: center">{{ t('compose.modal.empty') }}</div>
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
      :composition-id="compId"
    />
  </div>
</template>
