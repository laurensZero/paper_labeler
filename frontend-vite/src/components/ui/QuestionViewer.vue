<script setup lang="ts">
import { computed } from 'vue'
import MergedCropPreview from './MergedCropPreview.vue'
import CropPreview from './CropPreview.vue'

defineOptions({ name: 'QuestionViewer' })

export interface QuestionBoxData {
  id: number
  page: number
  bbox: number[]
  image_url: string
}

export interface QuestionData {
  id: number
  paper_id: number
  question_no: string | null
  section: string | null
  sections: string[]
  status: 'draft' | 'confirmed'
  notes: string | null
  is_favorite: boolean
  updated_at: string
  boxes: QuestionBoxData[]
  paper?: {
    id: number
    filename: string
    exam_code: string | null
  }
  __ansBoxes?: QuestionBoxData[]
  __ansOpen?: boolean
  __ansMeta?: string
}

const props = defineProps<{
  question: QuestionData | null
}>()

const emit = defineEmits<{
  'toggle-favorite': []
  'edit': []
  'edit-answer': []
  'locate': []
  'delete': []
}>()

const paperLabel = computed(() => {
  const p = props.question?.paper
  if (!p) return ''
  return p.exam_code || p.filename || ''
})

const sectionDisplay = computed(() => {
  const q = props.question
  if (!q) return ''
  if (q.sections?.length) return q.sections.join(' / ')
  if (q.section) return q.section
  return ''
})

const primaryBox = computed(() => {
  const q = props.question
  if (!q?.boxes?.length) return null
  return q.boxes[0]
})

const hasAnswerBoxes = computed(() => {
  return (props.question?.__ansBoxes?.length ?? 0) > 0
})
</script>

<template>
  <div class="qv" v-if="question">
    <!-- Header -->
    <div class="qv-header">
      <div class="qv-header-left">
        <span class="qv-qno">{{ question.question_no || '?' }}</span>
        <span v-if="paperLabel" class="qv-paper">{{ paperLabel }}</span>
        <span v-if="sectionDisplay" class="qv-section">{{ sectionDisplay }}</span>
      </div>
      <div class="qv-header-right">
        <button
          class="qv-fav"
          :class="{ 'qv-fav--active': question.is_favorite }"
          @click="emit('toggle-favorite')"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" :fill="question.is_favorite ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
        </button>
        <div class="qv-menu">
          <button class="qv-menu-trigger">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>
            </svg>
          </button>
          <div class="qv-menu-dropdown">
            <button @click="emit('edit')">编辑题目</button>
            <button @click="emit('edit-answer')">编辑答案</button>
            <button @click="emit('locate')">定位原卷</button>
            <button class="qv-menu-danger" @click="emit('delete')">删除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Notes -->
    <div v-if="question.notes" class="qv-notes">{{ question.notes }}</div>

    <!-- Question content -->
    <div class="qv-content">
      <div v-if="primaryBox" class="qv-image-wrap">
        <MergedCropPreview v-if="question.boxes.length > 1" :boxes="question.boxes" />
        <CropPreview
          v-else
          :image-url="primaryBox.image_url"
          :bbox="primaryBox.bbox"
        />
      </div>
      <div v-else class="qv-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
        </svg>
        <span>无题目图片</span>
      </div>
    </div>

    <!-- Answer section -->
    <div v-if="hasAnswerBoxes" class="qv-answer">
      <div class="qv-answer-header">
        <span class="qv-answer-label">答案 (MS)</span>
        <span class="qv-answer-meta">{{ question.__ansMeta }}</span>
      </div>
      <div class="qv-answer-boxes">
        <div v-for="(b, idx) in question.__ansBoxes" :key="idx" class="qv-answer-box">
          <CropPreview :image-url="b.image_url ?? ''" :bbox="b.bbox" />
        </div>
      </div>
    </div>
  </div>

  <!-- Empty state -->
  <div class="qv-empty-state" v-else>
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>
      <path d="M8 7h6"/>
      <path d="M8 11h8"/>
    </svg>
    <span>选择一道题目开始查看</span>
  </div>
</template>

<style scoped>
.qv {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
}

/* Header */
.qv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 0 16px;
  flex-shrink: 0;
}

.qv-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.qv-qno {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.5px;
}

.qv-paper {
  font-size: 13px;
  color: var(--text-secondary);
  padding: 2px 8px;
  background: var(--bg-input);
  border-radius: var(--radius-xs);
}

.qv-section {
  font-size: 13px;
  color: var(--text-accent);
  font-weight: 500;
}

.qv-header-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.qv-fav {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: none;
  color: var(--text-tertiary);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all 120ms ease;
}

.qv-fav:hover {
  background: var(--bg-hover);
  color: var(--danger);
}

.qv-fav--active {
  color: var(--danger);
}

/* More menu */
.qv-menu {
  position: relative;
}

.qv-menu-trigger {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: none;
  color: var(--text-tertiary);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all 120ms ease;
}

.qv-menu-trigger:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.qv-menu:hover .qv-menu-dropdown {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.qv-menu-dropdown {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  min-width: 140px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lg);
  padding: 4px;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-4px);
  transition: all 120ms ease;
  z-index: 10;
}

.qv-menu-dropdown button {
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: none;
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-xs);
  transition: background 80ms ease;
}

.qv-menu-dropdown button:hover {
  background: var(--bg-hover);
}

.qv-menu-danger {
  color: var(--danger) !important;
}

.qv-menu-danger:hover {
  background: rgba(239, 68, 68, 0.08) !important;
}

/* Notes */
.qv-notes {
  font-size: 13px;
  color: var(--text-secondary);
  padding: 0 0 12px;
  line-height: 1.5;
  flex-shrink: 0;
}

/* Content */
.qv-content {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: flex-start;
}

.qv-image-wrap {
  width: 100%;
  border-radius: var(--radius-lg);
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg-input);
}

.qv-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  width: 100%;
  min-height: 200px;
  color: var(--text-tertiary);
  font-size: 14px;
}

/* Answer */
.qv-answer {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.qv-answer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.qv-answer-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.qv-answer-meta {
  font-size: 12px;
  color: var(--text-tertiary);
}

.qv-answer-boxes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.qv-answer-box {
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg-input);
}

/* Empty state */
.qv-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 16px;
  color: var(--text-tertiary);
  font-size: 14px;
}
</style>
