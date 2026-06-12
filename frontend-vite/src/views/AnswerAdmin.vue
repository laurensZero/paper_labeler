<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useAnswerStore } from '@/stores/answer'
import { usePapersStore } from '@/stores/papers'
import { useAppStore } from '@/stores/app'
import { useDialogStore } from '@/stores/dialog'
import { api } from '@/api/client'
import type { AnswerPaperListItem } from '@/types/paper'

const { t } = useI18n()
defineOptions({ name: 'AnswerAdmin' })

const router = useRouter()
const answerStore = useAnswerStore()
const papersStore = usePapersStore()
const appStore = useAppStore()
const dialogStore = useDialogStore()

const { answerPaperList } = storeToRefs(answerStore)

function formatPaperName(p: { examCode?: string | null; exam_code?: string | null; filename?: string }) {
  return papersStore.formatPaperName(p as any)
}

function displayLabel(p: AnswerPaperListItem): string {
  const no = p.display_no != null ? p.display_no : p.id
  return `#${no}`
}

async function refresh() {
  await answerStore.refreshAnswerPapers()
}

async function startAnswerMark(p: AnswerPaperListItem) {
  const qpId = p.paired_paper_id != null ? Number(p.paired_paper_id) : null
  if (!qpId || !Number.isFinite(qpId)) {
    await dialogStore.alert(t('answerAdmin.noPair'))
    return
  }
  // Open the QP paper first, then navigate to answer view
  await papersStore.openPaper(qpId)
  await answerStore.openAnswerForPaper(p.id)
  router.push({ name: 'answer', params: { paperId: String(qpId) } })
}

async function deleteAnswerPaper(p: AnswerPaperListItem) {
  if (!await dialogStore.confirm(t('answerAdmin.deleteConfirm', { id: p.id }), {
    title: t('answerAdmin.delete'),
    confirmText: t('dialog.delete'),
    danger: true,
  })) return
  const confirmText = await dialogStore.prompt(t('answerAdmin.deletePrompt', { id: p.id }), '', {
    title: t('answerAdmin.delete'),
    confirmText: t('dialog.delete'),
    danger: true,
  })
  if (String(confirmText || '').trim() !== String(p.id)) return
  try {
    appStore.setStatus(t('answerAdmin.deleting', { id: p.id }))
    await api(`/papers/${p.id}`, { method: 'DELETE' })
    appStore.setStatus(t('answerAdmin.deleted'), 'ok')
    await answerStore.refreshAnswerPapers()
  } catch (e) {
    appStore.setStatus(String(e), 'err')
  }
}

function pairedPaperName(p: AnswerPaperListItem): string {
  if (!p.paired_paper_id) return t('answerAdmin.unpaired')
  // Try to find in papers store
  const paired = papersStore.papers.find((pp) => pp.id === p.paired_paper_id)
  if (paired) return formatPaperName(paired) || `#${p.paired_paper_id}`
  return `#${p.paired_paper_id}`
}

onMounted(async () => {
  await Promise.all([
    papersStore.refreshPapers(),
    answerStore.refreshAnswerPapers(),
  ])
})
</script>

<template>
  <div class="answer-admin">
    <!-- Header -->
    <div class="card">
      <div class="admin-header">
        <div class="admin-header-left">
          <div class="card-title" style="margin-bottom: 0">{{ t('answerAdmin.title') }}</div>
          <span class="admin-count">{{ t('answerAdmin.count', { count: answerPaperList.length }) }}</span>
        </div>
        <div class="admin-header-right">
          <button class="btn" @click="refresh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            {{ t('answerAdmin.refresh') }}
          </button>
        </div>
      </div>
      <p class="admin-hint">{{ t('answerAdmin.hint') }}</p>
    </div>

    <!-- Empty state -->
    <div v-if="!answerPaperList.length" class="card">
      <div class="empty">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
        </div>
        <div class="empty-text">{{ t('answerAdmin.empty') }}</div>
      </div>
    </div>

    <!-- Answer paper list -->
    <div v-else class="paper-grid">
      <div
        v-for="p in answerPaperList"
        :key="p.id"
        class="card paper-card"
      >
        <div class="paper-card-header">
          <div class="paper-card-title">
            <span class="paper-label">{{ t('answerAdmin.answerPaper') }}</span>
            <span class="paper-id">{{ displayLabel(p) }}</span>
            <span v-if="p.done" class="done-badge">{{ t('answerAdmin.done') }}</span>
          </div>
          <button
            class="btn btn-ghost btn-icon btn-delete"
            :title="t('answerAdmin.delete')"
            @click="deleteAnswerPaper(p)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
          </button>
        </div>

        <div class="paper-name" :title="formatPaperName(p) || p.filename">
          {{ formatPaperName(p) || p.filename }}
        </div>

        <div class="paper-meta-grid">
          <div class="meta-item">
            <span class="meta-label">{{ t('answerAdmin.pages') }}</span>
            <span class="meta-value">{{ p.page_count ?? '?' }}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">{{ t('answerAdmin.questions') }}</span>
            <span class="meta-value">{{ p.question_count ?? '?' }}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">{{ t('answerAdmin.answersMarked') }}</span>
            <span class="meta-value" :class="{ 'meta-complete': p.question_count > 0 && p.answers_marked >= p.question_count }">
              {{ p.answers_marked ?? 0 }}
            </span>
          </div>
          <div class="meta-item">
            <span class="meta-label">{{ t('answerAdmin.pairedQp') }}</span>
            <span class="meta-value paired-value" :class="{ 'meta-unpaired': !p.paired_paper_id }">
              {{ pairedPaperName(p) }}
            </span>
          </div>
        </div>

        <!-- Progress bar -->
        <div v-if="p.question_count > 0" class="progress-bar-wrap">
          <div
            class="progress-bar"
            :style="{ width: `${Math.min(100, Math.round((p.answers_marked / p.question_count) * 100))}%` }"
          />
        </div>

        <div class="paper-card-footer">
          <button class="btn btn-primary btn-sm" @click="startAnswerMark(p)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            {{ t('answerAdmin.startMarking') }}
          </button>
          <span class="paper-id-text">id={{ p.id }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.answer-admin {
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

.admin-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.admin-count {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
  padding: 3px 10px;
  background: var(--bg-hover);
  border-radius: 999px;
}

.admin-hint {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 10px;
  line-height: 1.5;
}

/* ── Paper grid ── */
.paper-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 14px;
}

/* ── Paper card ── */
.paper-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
}

.paper-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-tertiary);
}

.paper-id {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
}

.done-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--success);
  background: rgba(52, 199, 89, 0.1);
  border-radius: 999px;
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
  justify-content: space-between;
  margin-top: auto;
  padding-top: 4px;
}

.paper-id-text {
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
}

/* ── Button variants ── */
.btn-icon {
  padding: 6px;
  min-width: 32px;
  min-height: 32px;
}

.btn-sm {
  padding: 5px 12px;
  font-size: 12px;
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
</style>
