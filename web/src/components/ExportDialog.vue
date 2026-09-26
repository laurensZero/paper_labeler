<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ExportCommonOptions, ExportQuestionInput } from '@/lib/pdfExport'

export interface RandomPoolItem {
  id: number
  sections: string[]
}

const { t } = useI18n()

export interface SummaryFields {
  section: boolean
  paper: boolean
  year: boolean
  season: boolean
  count: boolean
}

const props = defineProps<{
  visible: boolean
  provider: () => Promise<ExportQuestionInput[]>
  defaultFilename: string
  /** 组卷预填（含答案/位置/标题等） */
  preset?: Partial<ExportCommonOptions>
  /** 是否显示「首页筛选信息」区块（组卷不显示） */
  showSummary?: boolean
  /** 由父级按勾选字段生成筛选信息行 */
  buildLines?: (fields: SummaryFields) => string[]
  /** 随机抽题（题库页开启；组卷不启用） */
  showRandom?: boolean
  randomPool?: RandomPoolItem[]
  randomFavs?: Set<number>
  randomProvider?: (ids: number[]) => Promise<ExportQuestionInput[]>
  buildRandomLines?: (ids: number[], fields: SummaryFields) => string[]
  /** 多选导出时的题数（显示「将导出 N 题」）；全量导出时不传 */
  itemCount?: number
}>()

const emit = defineEmits<{ 'update:visible': [v: boolean] }>()

const mode = ref<'filter' | 'random'>('filter')
const includeAnswers = ref(false)
const placement = ref<'end' | 'interleaved'>('end')
const header = reactive({ qno: true, section: true, paper: true, originalQno: false, notes: false })
const summaryOn = ref(false)
const summaryFields = reactive<SummaryFields>({ section: true, paper: true, year: true, season: true, count: true })
const showPageNumbers = ref(true)
const filename = ref('')

const running = ref(false)
const finishedPages = ref<number | null>(null)
const cancelled = ref(false)
const errorMsg = ref('')
const progress = reactive({ done: 0, total: 1, phase: '' })
const cancelFlag = ref({ value: false })

// 随机抽题面板状态
const rndCounts = reactive<Record<string, number>>({})
const rndFavOnly = ref(false)
const poolSnapshot = ref<RandomPoolItem[]>([])

const showSummaryBlock = computed(() => props.showSummary !== false)
const showRandomTab = computed(() => props.showRandom === true && !props.preset)

/** 勾选「仅从收藏中抽」后实际可用的抽题池（库存/上限/抽题三处共用） */
const rndPool = computed<RandomPoolItem[]>(() => {
  if (rndFavOnly.value && props.randomFavs) {
    return poolSnapshot.value.filter((q) => props.randomFavs!.has(q.id))
  }
  return poolSnapshot.value
})

/** 随机面板行：按池出现顺序；未分类用 ''（跟随收藏过滤） */
const rndRows = computed(() => {
  const order: string[] = []
  const stock = new Map<string, number>()
  for (const q of rndPool.value) {
    const secs = q.sections.length ? q.sections : ['']
    for (const s of secs) {
      if (!stock.has(s)) {
        stock.set(s, 0)
        order.push(s)
      }
      stock.set(s, (stock.get(s) ?? 0) + 1)
    }
  }
  return order.map((name) => ({
    name,
    label: name === '' ? t('cascade.unsectioned') : name,
    stock: stock.get(name) ?? 0,
  }))
})

// 切换收藏过滤后：已有配置超出新库存的行夹到上限，避免抽不满无提示
watch(rndFavOnly, () => {
  const maxOf = new Map(rndRows.value.map((r) => [r.name, r.stock]))
  for (const k of Object.keys(rndCounts)) {
    const max = maxOf.get(k) ?? 0
    rndCounts[k] = Math.max(0, Math.min(rndCounts[k], max))
  }
})

watch(
  () => props.visible,
  (open) => {
    if (!open) return
    finishedPages.value = null
    cancelled.value = false
    errorMsg.value = ''
    running.value = false
    progress.done = 0
    progress.phase = ''
    cancelFlag.value = { value: false }
    mode.value = 'filter'
    filename.value = props.defaultFilename
    includeAnswers.value = props.preset?.includeAnswers ?? false
    placement.value = props.preset?.answersPlacement ?? 'end'
    showPageNumbers.value = props.preset?.showPageNumbers ?? true
    if (props.preset?.header) Object.assign(header, props.preset.header)
    summaryOn.value = showSummaryBlock.value && !!props.preset?.includeFilterSummary
    poolSnapshot.value = props.randomPool ?? []
    for (const k of Object.keys(rndCounts)) delete rndCounts[k]
    for (const row of rndRows.value) rndCounts[row.name] = 0
    rndFavOnly.value = false
  },
)

function close() {
  if (running.value) return
  emit('update:visible', false)
}

function cancelExport() {
  cancelFlag.value.value = true
}

function zeroRnd() {
  for (const k of Object.keys(rndCounts)) rndCounts[k] = 0
}

function sampleRandom(): number[] {
  const pool = rndPool.value
  if (!pool.length) throw new Error(t('randomExport.empty'))
  const picked: number[] = []
  const used = new Set<number>()
  for (const row of rndRows.value) {
    const need = rndCounts[row.name] || 0
    if (!need) continue
    const candidates = pool.filter(
      (q) =>
        !used.has(q.id) &&
        (row.name === '' ? q.sections.length === 0 : q.sections.includes(row.name)),
    )
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
    }
    for (const q of candidates.slice(0, need)) {
      used.add(q.id)
      picked.push(q.id)
    }
  }
  if (!picked.length) throw new Error(t('randomExport.empty'))
  return picked
}

async function start() {
  if (running.value) return
  running.value = true
  finishedPages.value = null
  cancelled.value = false
  errorMsg.value = ''
  progress.done = 0
  progress.total = 1
  progress.phase = ''
  cancelFlag.value = { value: false }
  try {
    const { buildQuestionsPdf, downloadBlob } = await import('@/lib/pdfExport')
    const isRandom = showRandomTab.value && mode.value === 'random'
    let sampled: number[] = []
    if (isRandom) {
      const requested = rndRows.value.reduce((s, r) => s + (rndCounts[r.name] || 0), 0)
      if (requested <= 0) throw new Error(t('randomExport.noConfig'))
      sampled = sampleRandom()
    }
    const items = isRandom
      ? await (props.randomProvider ?? props.provider)(sampled)
      : await props.provider()
    if (!items.some((i) => !i.isBlankPage && i.boxes.length)) {
      throw new Error(t('randomExport.empty'))
    }
    const fields = { ...summaryFields }
    const lines = showSummaryBlock.value && summaryOn.value
      ? isRandom
        ? (props.buildRandomLines?.(sampled, fields) ?? [])
        : (props.buildLines?.(fields) ?? [])
      : []
    const opts: ExportCommonOptions = {
      includeAnswers: includeAnswers.value,
      answersPlacement: placement.value,
      header: { ...header },
      includeFilterSummary: showSummaryBlock.value && summaryOn.value,
      filterSummaryLines: lines,
      filename: filename.value,
      showPageNumbers: showPageNumbers.value,
      title: props.preset?.title,
      headerText: props.preset?.headerText,
      coverLines: props.preset?.coverLines,
      sectionLabel: props.preset?.sectionLabel,
      cancel: cancelFlag.value,
      progress: (done, total, phase) => {
        progress.done = done
        progress.total = total
        progress.phase = phase
      },
    }
    const { blob, filename: outName, pageCount } = await buildQuestionsPdf(items, opts)
    downloadBlob(blob, outName)
    finishedPages.value = pageCount
  } catch (e) {
    if (e && typeof e === 'object' && (e as Error).name === 'ExportCancelled') {
      cancelled.value = true
    } else {
      errorMsg.value = e instanceof Error ? e.message : String(e)
    }
  } finally {
    running.value = false
    cancelFlag.value.value = false
  }
}

const pct = computed(() =>
  progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0,
)
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="cv-modal-overlay" @click.self="close">
      <div class="cv-modal ex-modal">
        <div class="cv-modal-header">
          <h3>{{ t('exportDialog.title') }}</h3>
          <button class="cv-modal-x" :disabled="running" @click="close">×</button>
        </div>
        <div class="cv-modal-body">
          <!-- 模式页签：按筛选 / 随机抽题 -->
          <div v-if="showRandomTab" class="ex-tabs">
            <button :class="{ active: mode === 'filter' }" :disabled="running" @click="mode = 'filter'">
              {{ t('exportDialog.modeFilter') }}
            </button>
            <button :class="{ active: mode === 'random' }" :disabled="running" @click="mode = 'random'">
              {{ t('exportDialog.modeRandom') }}
            </button>
          </div>

          <!-- 随机抽题面板 -->
          <div v-if="showRandomTab && mode === 'random'" class="rnd-block">
            <p class="muted" style="margin: 0 0 8px; font-size: 12px">{{ t('randomExport.desc') }}</p>
            <div class="rnd-toolbar">
              <label class="cv-prop-check">
                <input v-model="rndFavOnly" type="checkbox" :disabled="running" />
                <span>{{ t('randomExport.favOnly') }}</span>
              </label>
              <button class="btn btn-sm" :disabled="running" @click="zeroRnd">{{ t('randomExport.allZero') }}</button>
            </div>
            <div class="rnd-list">
              <div v-for="row in rndRows" :key="row.name || '__none'" class="rnd-row">
                <span class="rnd-name">{{ row.label }}</span>
                <span class="rnd-stock">{{ t('randomExport.stock') }} {{ row.stock }}</span>
                <input
                  v-model.number="rndCounts[row.name]"
                  class="cv-prop-input rnd-input"
                  type="number"
                  min="0"
                  :max="row.stock"
                  :disabled="running"
                  @change="rndCounts[row.name] = Math.max(0, Math.min(row.stock, Math.floor(Number(rndCounts[row.name]) || 0)))"
                />
              </div>
              <div v-if="!rndRows.length" class="muted" style="padding: 16px; text-align: center">
                {{ t('randomExport.empty') }}
              </div>
            </div>
          </div>

          <!-- 多选题数（仅「按筛选」页签显示，随机页签由抽题数决定） -->
          <div v-if="itemCount != null && mode === 'filter'" class="ex-count">{{ t('exportDialog.itemCount', { n: itemCount }) }}</div>

          <!-- 含答案 + 位置 -->
          <div class="ex-row">
            <label class="cv-prop-check">
              <input v-model="includeAnswers" type="checkbox" :disabled="running" />
              <span>{{ t('exportDialog.answers') }}</span>
            </label>
            <select v-model="placement" class="cv-prop-input ex-select" :disabled="running || !includeAnswers">
              <option value="end">{{ t('exportDialog.placementEnd') }}</option>
              <option value="interleaved">{{ t('exportDialog.placementInterleaved') }}</option>
            </select>
          </div>

          <!-- 页眉字段 -->
          <div class="ex-group">
            <div class="ex-label">{{ t('exportDialog.headerFields') }}</div>
            <div class="ex-checks">
              <label class="cv-prop-check"><input v-model="header.qno" type="checkbox" :disabled="running" /><span>{{ t('exportDialog.fQno') }}</span></label>
              <label class="cv-prop-check"><input v-model="header.section" type="checkbox" :disabled="running" /><span>{{ t('exportDialog.fSection') }}</span></label>
              <label class="cv-prop-check"><input v-model="header.paper" type="checkbox" :disabled="running" /><span>{{ t('exportDialog.fPaper') }}</span></label>
              <label class="cv-prop-check"><input v-model="header.originalQno" type="checkbox" :disabled="running" /><span>{{ t('exportDialog.fOriginalQno') }}</span></label>
              <label class="cv-prop-check"><input v-model="header.notes" type="checkbox" :disabled="running" /><span>{{ t('exportDialog.fNotes') }}</span></label>
            </div>
          </div>

          <!-- 首页筛选信息 -->
          <div v-if="showSummaryBlock" class="ex-group">
            <label class="cv-prop-check">
              <input v-model="summaryOn" type="checkbox" :disabled="running" />
              <span>{{ t('exportDialog.summary') }}</span>
            </label>
            <div v-if="summaryOn" class="ex-checks" style="margin-top: 6px">
              <span class="ex-label" style="margin: 0">{{ t('exportDialog.summaryFields') }}:</span>
              <label class="cv-prop-check"><input v-model="summaryFields.section" type="checkbox" :disabled="running" /><span>{{ t('exportDialog.sfSection') }}</span></label>
              <label class="cv-prop-check"><input v-model="summaryFields.paper" type="checkbox" :disabled="running" /><span>{{ t('exportDialog.sfPaper') }}</span></label>
              <label class="cv-prop-check"><input v-model="summaryFields.year" type="checkbox" :disabled="running" /><span>{{ t('exportDialog.sfYear') }}</span></label>
              <label class="cv-prop-check"><input v-model="summaryFields.season" type="checkbox" :disabled="running" /><span>{{ t('exportDialog.sfSeason') }}</span></label>
              <label class="cv-prop-check"><input v-model="summaryFields.count" type="checkbox" :disabled="running" /><span>{{ t('exportDialog.sfCount') }}</span></label>
            </div>
          </div>

          <div class="ex-row">
            <label class="cv-prop-check">
              <input v-model="showPageNumbers" type="checkbox" :disabled="running" />
              <span>{{ t('exportDialog.showPageNumbers') }}</span>
            </label>
          </div>

          <div class="ex-group">
            <div class="ex-label">{{ t('exportDialog.filename') }}</div>
            <input v-model="filename" class="cv-prop-input" :disabled="running" />
          </div>

          <!-- 进度 / 取消 / 结果 -->
          <div v-if="running" class="ex-progress">
            <div class="ex-bar"><div class="ex-bar-fill" :style="{ width: pct + '%' }"></div></div>
            <div class="ex-progress-row">
              <span class="ex-progress-text">
                {{ progress.done }} / {{ progress.total }}
                <template v-if="progress.phase"> · {{ t(`exportDialog.phase.${progress.phase}`) }}</template>
              </span>
              <button class="btn btn-sm btn-danger" @click="cancelExport">{{ t('exportDialog.cancel') }}</button>
            </div>
          </div>
          <div v-if="finishedPages != null" class="ex-done">
            {{ t('exportDialog.done', { pages: finishedPages }) }}
          </div>
          <div v-if="cancelled" class="ex-cancelled">{{ t('exportDialog.cancelled') }}</div>
          <div v-if="errorMsg" class="error-text">{{ t('exportDialog.failed', { error: errorMsg }) }}</div>
        </div>
        <div class="cv-modal-footer">
          <button class="btn" :disabled="running" @click="close">{{ t('exportDialog.close') }}</button>
          <button class="btn btn-primary" :disabled="running" @click="start">
            {{ running ? t('exportDialog.exporting') : t('exportDialog.start') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
