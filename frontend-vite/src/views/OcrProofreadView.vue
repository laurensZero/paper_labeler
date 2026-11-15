<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import MergedCropPreview from '@/components/ui/MergedCropPreview.vue'
import CropPreview from '@/components/ui/CropPreview.vue'
import { ocrApi, type OcrQueueItem } from '@/api/endpoints'
import { useDialogStore } from '@/stores/dialog'
import { copyPlainText, renderLatexHtml } from '@/lib/latex'
import type { Question } from '@/types/question'

defineOptions({ name: 'OcrProofreadView' })

const { t } = useI18n()
const dialogStore = useDialogStore()

type StatusFilter = 'draft' | 'confirmed' | 'all'
const statusFilter = ref<StatusFilter>('draft')
const items = ref<OcrQueueItem[]>([])
const hasMore = ref(false)
const loading = ref(false)
const loadError = ref('')

const selectedId = ref<number | null>(null)
const draft = ref('')
const savedContent = ref('')
const saving = ref(false)
const actionError = ref('')
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
const viewMode = ref<'render' | 'source'>('render')

const current = computed(() => items.value.find((it) => it.question_id === selectedId.value) ?? null)
const dirty = computed(() => current.value != null && draft.value !== savedContent.value)
const renderedHtml = computed(() => (current.value ? renderLatexHtml(draft.value) : ''))
// 约定：识别文本无法还原图形，含图题打徽标提醒对照原图（与 web 端同规则）
const hasFigure = computed(() =>
  !!current.value && /\b(diagram|graph|figure|stem[- ]and[- ]leaf)\b/i.test(draft.value))
const isPureFigure = computed(() => !!current.value && draft.value.trim() === '')

function errText(e: unknown): string {
  if (e && typeof e === 'object' && 'body' in e) {
    try {
      const body = JSON.parse(String((e as { body: string }).body))
      if (body?.detail) return String(body.detail)
    } catch {
      /* fallthrough */
    }
  }
  return e instanceof Error ? e.message : String(e)
}

function paperLabel(q: Question | null): string {
  if (!q?.paper) return ''
  const p = q.paper
  const base = p.exam_code || p.filename || ''
  return base.replace(/\.pdf$/i, '')
}

function timeLabel(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

async function loadQueue(reset = true) {
  loading.value = true
  loadError.value = ''
  try {
    const after = reset ? 0 : (items.value.at(-1)?.question_id ?? 0)
    const res = await ocrApi.queue(statusFilter.value, after)
    if (reset) {
      items.value = res.items
      selectedId.value = null
      draft.value = ''
      savedContent.value = ''
    } else {
      items.value.push(...res.items)
    }
    hasMore.value = res.has_more
    if (reset && items.value.length) select(items.value[0])
  } catch (e) {
    loadError.value = errText(e)
    if (reset) items.value = []
  } finally {
    loading.value = false
  }
}

async function refreshQueue() {
  if (dirty.value && !(await confirmDiscard())) return
  await loadQueue(true)
}

function setStatus(f: StatusFilter) {
  if (f === statusFilter.value) return
  void switchFilter(f)
}

async function switchFilter(f: StatusFilter) {
  if (dirty.value && !(await confirmDiscard())) return
  statusFilter.value = f
  await loadQueue(true)
}

async function loadMore() {
  if (loading.value || !hasMore.value) return
  await loadQueue(false)
}

function confirmDiscard(): Promise<boolean> {
  return dialogStore.confirm(t('ocr.unsavedConfirm'), { confirmText: t('ocr.confirm') })
}

async function select(it: OcrQueueItem) {
  if (it.question_id === selectedId.value) return
  if (dirty.value && !(await confirmDiscard())) return
  selectedId.value = it.question_id
  draft.value = it.content
  savedContent.value = it.content
  actionError.value = ''
}

async function persist(status?: 'draft' | 'confirmed') {
  const it = current.value
  if (!it || saving.value) return
  const contentChanged = dirty.value
  if (!contentChanged && !status) return
  saving.value = true
  actionError.value = ''
  try {
    const patch: { content?: string; status?: 'draft' | 'confirmed' } = {}
    if (contentChanged) patch.content = draft.value
    if (status) patch.status = status
    await ocrApi.update(it.question_id, patch)
    it.content = draft.value
    savedContent.value = draft.value
    if (status) it.status = status
    // 状态流转后不再属于当前筛选项：移出队列并顺延到下一题
    if (status && statusFilter.value !== 'all' && it.status !== statusFilter.value) {
      const idx = items.value.findIndex((x) => x.question_id === it.question_id)
      items.value.splice(idx, 1)
      selectedId.value = null
      draft.value = ''
      savedContent.value = ''
      const next = items.value[idx] ?? items.value[idx - 1] ?? null
      if (next) select(next)
    }
  } catch (e) {
    actionError.value = errText(e)
  } finally {
    saving.value = false
  }
}

async function copySource() {
  if (!current.value) return
  if (await copyPlainText(draft.value)) {
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = false), 1600)
  }
}

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    if (current.value) void persist(current.value.status)
  }
}

onMounted(() => {
  document.addEventListener('keydown', onGlobalKeydown)
  void loadQueue(true)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onGlobalKeydown)
  if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<template>
  <div class="ocrp">
    <!-- 左侧：校对队列 -->
    <aside class="ocrp-queue">
      <div class="ocrp-queue-head">
        <div class="ocrp-title">{{ t('ocr.title') }}</div>
        <button class="ocrp-icon-btn" :disabled="loading" :title="t('ocr.refresh')" @click="refreshQueue">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>
      <div class="ocrp-tabs">
        <button class="ocrp-tab" :class="{ active: statusFilter === 'draft' }" @click="setStatus('draft')">{{ t('ocr.tabDraft') }}</button>
        <button class="ocrp-tab" :class="{ active: statusFilter === 'confirmed' }" @click="setStatus('confirmed')">{{ t('ocr.tabConfirmed') }}</button>
        <button class="ocrp-tab" :class="{ active: statusFilter === 'all' }" @click="setStatus('all')">{{ t('ocr.tabAll') }}</button>
      </div>
      <div v-if="loadError" class="ocrp-error">{{ loadError }}</div>
      <div class="ocrp-list">
        <button
          v-for="it in items"
          :key="it.question_id"
          class="ocrp-item"
          :class="{ selected: it.question_id === selectedId, confirmed: it.status === 'confirmed' }"
          @click="select(it)"
        >
          <span class="ocrp-item-top">
            <span class="ocrp-item-id">#{{ it.question_id }}</span>
            <span v-if="it.question?.question_no" class="ocrp-item-no">{{ it.question.question_no }}</span>
            <span class="ocrp-item-status" :class="it.status === 'confirmed' ? 'is-confirmed' : 'is-draft'">
              {{ it.status === 'confirmed' ? t('ocr.statusConfirmed') : t('ocr.statusDraft') }}
            </span>
          </span>
          <span v-if="it.question?.paper" class="ocrp-item-paper">{{ paperLabel(it.question) }}</span>
          <span v-else class="ocrp-item-paper ocrp-item-missing">{{ t('ocr.missingLocal') }}</span>
          <span v-if="it.mismatch" class="ocrp-item-paper ocrp-item-missing">
            {{ t('ocr.mismatchDetail', { cloud: it.cloud?.question_no ?? '?', local: it.question?.question_no ?? '?' }) }}
          </span>
          <span v-else-if="!it.cloud" class="ocrp-item-paper ocrp-item-missing">{{ t('ocr.cloudMissing') }}</span>
          <span v-if="it.stale" class="ocrp-item-paper ocrp-item-stale">{{ t('ocr.staleHint') }}</span>
        </button>
        <div v-if="hasMore" class="ocrp-more">
          <button class="ocrp-more-btn" :disabled="loading" @click="loadMore">{{ t('ocr.loadMore') }}</button>
        </div>
        <div v-if="!items.length && !loading && !loadError" class="ocrp-empty">{{ t('ocr.empty') }}</div>
        <div v-if="loading && !items.length" class="ocrp-empty">{{ t('ocr.loading') }}</div>
      </div>
    </aside>

    <!-- 右侧：原图对照 + 编辑 -->
    <section class="ocrp-work">
      <template v-if="current">
        <div class="ocrp-image-pane">
          <MergedCropPreview v-if="(current.question?.boxes.length ?? 0) > 1" :boxes="current.question!.boxes" />
          <CropPreview
            v-else-if="current.question?.boxes.length === 1"
            :image-url="current.question.boxes[0].image_url"
            :bbox="current.question.boxes[0].bbox"
          />
          <div v-else class="ocrp-noimg">{{ t('ocr.missingLocal') }}</div>
        </div>
        <div class="ocrp-edit-pane">
          <div class="ocrp-meta">
            <span class="ocrp-meta-id">#{{ current.question_id }}</span>
            <span v-if="current.question?.question_no" class="ocrp-meta-no">{{ current.question.question_no }}</span>
            <span v-if="current.question?.paper" class="ocrp-meta-paper">{{ paperLabel(current.question) }}</span>
            <span class="ocrp-item-status" :class="current.status === 'confirmed' ? 'is-confirmed' : 'is-draft'">
              {{ current.status === 'confirmed' ? t('ocr.statusConfirmed') : t('ocr.statusDraft') }}
            </span>
            <span v-if="!current.cloud" class="ocrp-badge ocrp-badge-bad">{{ t('ocr.cloudMissing') }}</span>
            <span v-else-if="current.mismatch" class="ocrp-badge ocrp-badge-bad">
              {{ t('ocr.mismatchDetail', { cloud: current.cloud.question_no ?? '?', local: current.question?.question_no ?? '?' }) }}
            </span>
            <span v-if="current.stale" class="ocrp-badge ocrp-badge-warn">{{ t('ocr.staleHint') }}</span>
            <span class="ocrp-meta-time">{{ timeLabel(current.updated_at) }}</span>
          </div>

          <div class="ocrp-toolbar">
            <div class="ocrp-viewtabs">
              <button class="ocrp-tab" :class="{ active: viewMode === 'render' }" @click="viewMode = 'render'">{{ t('ocr.render') }}</button>
              <button class="ocrp-tab" :class="{ active: viewMode === 'source' }" @click="viewMode = 'source'">{{ t('ocr.source') }}</button>
            </div>
            <div class="ocrp-actions">
              <button class="ocrp-btn" @click="copySource">{{ copied ? t('ocr.copied') : t('ocr.copy') }}</button>
              <button class="ocrp-btn" :disabled="saving || (!dirty && current.status === 'draft')" @click="persist('draft')">{{ t('ocr.revertDraft') }}</button>
              <button class="ocrp-btn ocrp-btn-primary" :disabled="saving" @click="persist('confirmed')">{{ t('ocr.confirmProofread') }}</button>
            </div>
          </div>

          <div v-if="actionError" class="ocrp-error">{{ actionError }}</div>
          <div class="ocrp-badges">
            <span v-if="hasFigure" class="ocrp-badge ocrp-badge-warn">{{ t('ocr.figureHint') }}</span>
            <span v-if="isPureFigure" class="ocrp-badge">{{ t('ocr.pureFigureHint') }}</span>
          </div>

          <div v-if="viewMode === 'render'" class="ocrp-rendered latex-body" v-html="renderedHtml"></div>
          <textarea
            v-else
            v-model="draft"
            class="ocrp-source"
            :spellcheck="false"
            :placeholder="t('ocr.sourcePlaceholder')"
          ></textarea>

          <div class="ocrp-savebar">
            <button class="ocrp-btn ocrp-btn-primary" :disabled="saving || !dirty" @click="persist(current.status)">
              {{ t('ocr.save') }} <span class="ocrp-kbd">Ctrl+S</span>
            </button>
            <span v-if="dirty" class="ocrp-dirty">{{ t('ocr.unsaved') }}</span>
          </div>
        </div>
      </template>
      <div v-else class="ocrp-placeholder">
        <span>{{ loading ? t('ocr.loading') : t('ocr.selectHint') }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ocrp {
  display: flex;
  gap: 14px;
  height: calc(100vh - 130px);
  min-height: 460px;
}

/* ── 左侧队列 ── */
.ocrp-queue {
  width: 280px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: 12px;
  min-height: 0;
}
.ocrp-queue-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ocrp-title {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}
.ocrp-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ocrp-icon-btn:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--text-tertiary);
}
.ocrp-tabs {
  display: flex;
  gap: 4px;
}
.ocrp-tab {
  flex: 1;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.ocrp-tab.active {
  background: var(--text-accent);
  border-color: var(--text-accent);
  color: #fff;
}
.ocrp-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
}
.ocrp-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}
.ocrp-item:hover {
  border-color: var(--text-tertiary);
}
.ocrp-item.selected {
  border-color: var(--text-accent);
  background: color-mix(in srgb, var(--text-accent) 8%, transparent);
}
.ocrp-item-top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ocrp-item-id {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-primary);
}
.ocrp-item-no {
  font-size: 12px;
  color: var(--text-secondary);
}
.ocrp-item-status {
  margin-left: auto;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
}
.ocrp-item-status.is-draft {
  background: rgba(217, 119, 6, 0.14);
  color: #d97706;
}
.ocrp-item-status.is-confirmed {
  background: rgba(22, 163, 74, 0.14);
  color: #16a34a;
}
.ocrp-item-paper {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ocrp-item-missing {
  color: #dc2626;
}
.ocrp-item-stale {
  color: #d97706;
}
.ocrp-more {
  text-align: center;
  padding: 4px 0;
}
.ocrp-more-btn {
  border: none;
  background: transparent;
  color: var(--text-accent);
  font-size: 12px;
  cursor: pointer;
}
.ocrp-empty {
  color: var(--text-tertiary);
  font-size: 12px;
  text-align: center;
  padding: 24px 0;
}

/* ── 右侧工作区 ── */
.ocrp-work {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 14px;
}
.ocrp-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  color: var(--text-tertiary);
  font-size: 13px;
}
.ocrp-image-pane {
  flex: 1;
  min-width: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: 12px;
}
.ocrp-noimg {
  color: var(--text-tertiary);
  font-size: 12px;
  text-align: center;
  padding: 40px 0;
}
.ocrp-edit-pane {
  flex: 1;
  min-width: 380px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: 12px;
  min-height: 0;
}
.ocrp-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ocrp-meta-id {
  font-weight: 700;
  font-size: 15px;
  color: var(--text-primary);
}
.ocrp-meta-no {
  font-size: 13px;
  color: var(--text-secondary);
}
.ocrp-meta-paper {
  font-size: 12px;
  color: var(--text-tertiary);
  max-width: 260px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ocrp-meta-time {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-tertiary);
}
.ocrp-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.ocrp-viewtabs {
  display: flex;
  gap: 4px;
}
.ocrp-viewtabs .ocrp-tab {
  flex: none;
}
.ocrp-actions {
  display: flex;
  gap: 6px;
}
.ocrp-btn {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.ocrp-btn:hover:not(:disabled) {
  border-color: var(--text-tertiary);
}
.ocrp-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ocrp-btn-primary {
  background: var(--text-accent);
  border-color: var(--text-accent);
  color: #fff;
}
.ocrp-error {
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(220, 38, 38, 0.1);
  color: #dc2626;
  font-size: 12px;
}
.ocrp-badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.ocrp-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--border);
  color: var(--text-secondary);
}
.ocrp-badge-warn {
  background: rgba(217, 119, 6, 0.14);
  color: #d97706;
}
.ocrp-badge-bad {
  background: rgba(220, 38, 38, 0.12);
  color: #dc2626;
}

/* 渲染区：字号/字体与 web 端 OCR 面板一致 */
.ocrp-rendered {
  flex: 1;
  overflow: auto;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-primary);
  min-height: 0;
}
/* 字体/字号/公式/表格排版由共享包 @paper/latex-render 的 .latex-body 统一提供 */
.ocrp-source {
  flex: 1;
  resize: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 12px 14px;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  min-height: 0;
}
.ocrp-source:focus {
  outline: none;
  border-color: var(--text-accent);
}
.ocrp-savebar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ocrp-kbd {
  font-size: 10px;
  opacity: 0.75;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 4px;
  padding: 0 4px;
  margin-left: 4px;
}
.ocrp-dirty {
  font-size: 12px;
  color: #d97706;
}
</style>
