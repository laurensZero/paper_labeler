<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useAnswerStore } from '@/stores/answer'
import { usePapersStore } from '@/stores/papers'
import { useAppStore } from '@/stores/app'
import { useDialogStore } from '@/stores/dialog'
import { api } from '@/api/client'
import { papersApi } from '@/api/endpoints'
import type { PaperListItem } from '@/types/paper'

const { t } = useI18n()
defineOptions({ name: 'AnswerAdmin' })

const router = useRouter()
const answerStore = useAnswerStore()
const papersStore = usePapersStore()
const appStore = useAppStore()
const dialogStore = useDialogStore()

const { answerPaperList } = storeToRefs(answerStore)
const { papers } = storeToRefs(papersStore)

type TabKey = 'all' | 'bound' | 'unbound' | 'done' | 'todo'
const activeTab = ref<TabKey>('all')

// ── Stats ──
const stats = computed(() => {
  const qps = papers.value
  const totalQp = qps.length
  const boundQp = qps.filter(p => p.paired_paper_id != null).length
  const doneQp = qps.filter(p => p.done).length
  const totalMs = answerPaperList.value.length
  const unpairedMs = answerPaperList.value.filter(p => p.paired_paper_id == null).length
  const totalQuestions = qps.reduce((s, p) => s + (p.question_count || 0), 0)
  const totalAnswers = qps.reduce((s, p) => s + (p.answers_marked || 0), 0)
  return { totalQp, boundQp, doneQp, totalMs, unpairedMs, totalQuestions, totalAnswers }
})

// ── Tab counts ──
const tabCounts = computed(() => ({
  all: papers.value.length,
  bound: papers.value.filter(p => p.paired_paper_id != null).length,
  unbound: papers.value.filter(p => p.paired_paper_id == null).length,
  done: papers.value.filter(p => p.done).length,
  todo: papers.value.filter(p => !p.done).length,
}))

// ── Filtered list ──
const filteredPapers = computed(() => {
  const list = papers.value
  if (activeTab.value === 'bound') return list.filter(p => p.paired_paper_id != null)
  if (activeTab.value === 'unbound') return list.filter(p => p.paired_paper_id == null)
  if (activeTab.value === 'done') return list.filter(p => p.done)
  if (activeTab.value === 'todo') return list.filter(p => !p.done)
  return list
})

// ── Helpers ──
function formatPaperName(p: { examCode?: string | null; exam_code?: string | null; filename?: string }) {
  return papersStore.formatPaperName(p as Parameters<typeof papersStore.formatPaperName>[0])
}

function displayLabel(p: PaperListItem): string {
  const no = p.display_no != null ? p.display_no : p.id
  return `#${no}`
}

function msPaperName(p: PaperListItem): string | null {
  if (p.paired_paper_id == null) return null
  const ms = answerPaperList.value.find(a => a.id === p.paired_paper_id)
  if (ms) return formatPaperName(ms) || `#${ms.id}`
  return `#${p.paired_paper_id}`
}

// ── Actions ──
async function refresh() {
  await Promise.all([
    papersStore.refreshPapers(),
    answerStore.refreshAnswerPapers(),
  ])
}

async function startMark(p: PaperListItem) {
  await papersStore.openPaper(p.id)
  router.push({ name: 'mark', params: { paperId: String(p.id) } })
}

async function startAnswerMark(p: PaperListItem) {
  if (p.paired_paper_id == null) return
  await papersStore.openPaper(p.id)
  await answerStore.openAnswerForPaper(p.paired_paper_id)
  router.push({ name: 'answer', params: { paperId: String(p.id) } })
}

async function deletePaper(p: PaperListItem) {
  if (!await dialogStore.confirm(t('paperAdmin.deleteConfirm', { id: p.id, name: formatPaperName(p) || p.filename }), {
    title: t('paperAdmin.deleteTitle'),
    confirmText: t('dialog.delete'),
    danger: true,
  })) return
  const confirmText = await dialogStore.prompt(t('paperAdmin.deletePrompt', { id: p.id }), '', {
    title: t('paperAdmin.deleteTitle'),
    confirmText: t('dialog.delete'),
    danger: true,
  })
  if (String(confirmText || '').trim() !== String(p.id)) return
  try {
    appStore.setStatus(t('paperAdmin.deleting'))
    await api(`/papers/${p.id}`, { method: 'DELETE' })
    appStore.setStatus(t('paperAdmin.deleted'), 'ok')
    await papersStore.refreshPapers()
    await answerStore.refreshAnswerPapers()
  } catch (e) {
    appStore.setStatus(String(e), 'err')
  }
}

async function toggleDone(p: PaperListItem) {
  try {
    await papersApi.update(p.id, { done: !p.done })
    appStore.setStatus(t(p.done ? 'paperAdmin.unmarkDone' : 'paperAdmin.markDone'), 'ok')
    await papersStore.refreshPapers()
  } catch (e) {
    appStore.setStatus(String(e), 'err')
  }
}

function progressPercent(p: PaperListItem): number {
  if (!p.question_count) return 0
  return Math.min(100, Math.round((p.answers_marked / p.question_count) * 100))
}

onMounted(async () => {
  await Promise.all([
    papersStore.refreshPapers(),
    answerStore.refreshAnswerPapers(),
  ])
})
</script>

<template>
  <div class="paper-admin">
    <!-- Header -->
    <div class="card">
      <div class="admin-header">
        <div class="admin-header-left">
          <div class="card-title" style="margin-bottom: 0">{{ t('paperAdmin.title') }}</div>
        </div>
        <button class="btn" @click="refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          {{ t('paperAdmin.refresh') }}
        </button>
      </div>
    </div>

    <!-- Stats dashboard -->
    <div class="stats-grid">
      <div class="card stat-card">
        <div class="stat-value">{{ stats.totalQp }}</div>
        <div class="stat-label">{{ t('paperAdmin.statTotalPapers') }}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">{{ stats.boundQp }}</div>
        <div class="stat-label">{{ t('paperAdmin.statBoundPapers') }}</div>
        <div class="stat-sub" v-if="stats.totalQp > 0">
          {{ t('paperAdmin.statUnbound', { count: stats.totalQp - stats.boundQp }) }}
        </div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">{{ stats.doneQp }}</div>
        <div class="stat-label">{{ t('paperAdmin.statDonePapers') }}</div>
        <div class="stat-sub" v-if="stats.totalQp > 0">
          {{ t('paperAdmin.statTodo', { count: stats.totalQp - stats.doneQp }) }}
        </div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">{{ stats.totalAnswers }}<span class="stat-denom">/{{ stats.totalQuestions }}</span></div>
        <div class="stat-label">{{ t('paperAdmin.statAnswers') }}</div>
        <div class="stat-sub" v-if="stats.totalQuestions > 0">
          {{ Math.round((stats.totalAnswers / stats.totalQuestions) * 100) }}%
        </div>
      </div>
      <div class="card stat-card" v-if="stats.totalMs > 0">
        <div class="stat-value">{{ stats.totalMs }}</div>
        <div class="stat-label">{{ t('paperAdmin.msSummary') }}</div>
        <div class="stat-sub" :class="stats.unpairedMs > 0 ? 'stat-warn' : 'stat-ok'">
          <template v-if="stats.unpairedMs > 0">{{ t('paperAdmin.msUnpaired', { count: stats.unpairedMs }) }}</template>
          <template v-else>{{ t('paperAdmin.msAllPaired') }}</template>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="tab-bar">
      <button
        v-for="key in (['all', 'done', 'todo', 'bound', 'unbound'] as TabKey[])"
        :key="key"
        class="tab-btn"
        :class="{ active: activeTab === key }"
        @click="activeTab = key"
      >
        {{ t(`paperAdmin.tab_${key}`) }}
        <span class="tab-count">{{ tabCounts[key] }}</span>
      </button>
    </div>

    <!-- Empty state -->
    <div v-if="!filteredPapers.length" class="card">
      <div class="empty">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
        </div>
        <div class="empty-text">{{ activeTab === 'all' ? t('paperAdmin.empty') : t('paperAdmin.emptyFiltered') }}</div>
      </div>
    </div>

    <!-- Paper list -->
    <div v-else class="paper-grid">
      <div
        v-for="p in filteredPapers"
        :key="p.id"
        class="card paper-card"
        :class="{ 'paper-done': p.done }"
      >
        <div class="paper-card-header">
          <div class="paper-card-title">
            <span class="paper-id">{{ displayLabel(p) }}</span>
            <span v-if="p.done" class="badge badge-done">{{ t('paperAdmin.done') }}</span>
            <span v-if="p.paired_paper_id != null" class="badge badge-bound">{{ t('paperAdmin.bound') }}</span>
            <span v-else class="badge badge-unbound">{{ t('paperAdmin.unbound') }}</span>
          </div>
          <button
            class="btn btn-ghost btn-icon btn-delete"
            v-tooltip="t('paperAdmin.deleteTitle')"
            @click="deletePaper(p)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
          </button>
        </div>

        <div class="paper-name" v-tooltip="formatPaperName(p) || p.filename">
          {{ formatPaperName(p) || p.filename }}
        </div>

        <div class="paper-meta-grid">
          <div class="meta-item">
            <span class="meta-label">{{ t('paperAdmin.pages') }}</span>
            <span class="meta-value">{{ p.page_count ?? '?' }}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">{{ t('paperAdmin.questions') }}</span>
            <span class="meta-value">{{ p.question_count ?? '?' }}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">{{ t('paperAdmin.answersMarked') }}</span>
            <span class="meta-value" :class="{ 'meta-complete': p.question_count > 0 && p.answers_marked >= p.question_count }">
              {{ p.answers_marked ?? 0 }}
            </span>
          </div>
          <div class="meta-item">
            <span class="meta-label">{{ t('paperAdmin.pairedMs') }}</span>
            <span class="meta-value paired-value" :class="{ 'meta-unpaired': !p.paired_paper_id }">
              {{ msPaperName(p) ?? t('paperAdmin.noMs') }}
            </span>
          </div>
        </div>

        <!-- Progress bar -->
        <div v-if="p.question_count > 0" class="progress-bar-wrap">
          <div class="progress-bar" :style="{ width: `${progressPercent(p)}%` }" />
        </div>

        <div class="paper-card-footer">
          <div class="btn-group">
            <button
              class="btn btn-sm"
              :class="p.done ? 'btn-done-active' : ''"
              v-tooltip="p.done ? t('paperAdmin.unmarkDone') : t('paperAdmin.markDone')"
              @click="toggleDone(p)"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {{ p.done ? t('paperAdmin.unmarkDone') : t('paperAdmin.markDone') }}
            </button>
            <button class="btn btn-sm" @click="startMark(p)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              {{ t('paperAdmin.markQuestions') }}
            </button>
            <button
              v-if="p.paired_paper_id != null"
              class="btn btn-primary btn-sm"
              @click="startAnswerMark(p)"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              {{ t('paperAdmin.markAnswers') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.paper-admin {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ── Header ── */
.admin-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.admin-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* ── Stats grid ── */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}

.stat-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 20px 16px;
  text-align: center;
}

.stat-value {
  font-size: 32px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.1;
}

.stat-denom {
  font-size: 18px;
  font-weight: 400;
  color: var(--text-tertiary);
}

.stat-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.stat-sub {
  font-size: 11px;
  color: var(--text-tertiary);
}

.stat-warn {
  color: var(--warning);
}

.stat-ok {
  color: var(--success);
}

/* ── Tabs ── */
.tab-bar {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0;
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
  margin-bottom: -1px;
}

.tab-btn:hover {
  color: var(--text-primary);
}

.tab-btn.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

.tab-count {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--bg-hover);
  color: var(--text-tertiary);
}

.tab-btn.active .tab-count {
  background: rgba(99, 102, 241, 0.12);
  color: var(--accent);
}

/* ── Paper grid ── */
.paper-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 14px;
}

/* ── Paper card ── */
.paper-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: all var(--duration-normal) var(--ease-out);
}

.paper-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.paper-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.paper-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.paper-id {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
}

.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: var(--radius-sm);
}

.badge-done {
  color: var(--success);
  background: rgba(52, 199, 89, 0.1);
}

.badge-bound {
  color: var(--accent);
  background: rgba(99, 102, 241, 0.1);
}

.badge-unbound {
  color: var(--text-tertiary);
  background: var(--bg-hover);
}

.paper-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Meta grid ── */
.paper-meta-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.meta-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.meta-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.meta-complete {
  color: var(--success);
}

.meta-unpaired {
  color: var(--text-tertiary);
  font-weight: 400;
  font-size: 12px;
}

.paired-value {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Progress bar ── */
.progress-bar-wrap {
  height: 4px;
  background: var(--bg-hover);
  border-radius: 2px;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width var(--duration-normal) var(--ease-out);
}

/* ── Card footer ── */
.paper-card-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  margin-top: auto;
  padding-top: 4px;
}

.btn-group {
  display: flex;
  gap: 6px;
}

.btn-sm {
  padding: 5px 12px;
  font-size: 12px;
}

/* ── Button variants ── */
.btn-icon {
  padding: 6px;
  min-width: 32px;
  min-height: 32px;
}

.btn-delete {
  color: var(--text-tertiary);
  opacity: 0.5;
  transition: all var(--duration-fast) var(--ease-out);
}

.paper-card:hover .btn-delete {
  opacity: 1;
}

.btn-delete:hover {
  color: var(--danger);
  background: rgba(255, 59, 48, 0.08);
}

.btn-done-active {
  color: var(--success);
  background: rgba(52, 199, 89, 0.08);
}

.btn-done-active:hover {
  color: var(--success);
  background: rgba(52, 199, 89, 0.15);
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

/* ── Done card subtle ── */
.paper-done {
  opacity: 0.85;
}
</style>
