<script setup lang="ts">
import { computed } from 'vue'
import CropPreview from './CropPreview.vue'

defineOptions({ name: 'FilterQuestionCard' })

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
}

const props = withDefaults(defineProps<{
  question: QuestionData
  selected?: boolean
  onEdit?: (question: QuestionData) => void
  onAnswer?: (question: QuestionData) => void
}>(), {
  selected: false,
})

const emit = defineEmits<{
  'update:selected': [value: boolean]
  'toggle-favorite': [question: QuestionData]
}>()

const statusLabel = computed(() => {
  switch (props.question.status) {
    case 'confirmed': return '已确认'
    case 'draft': return '草稿'
    default: return props.question.status
  }
})

const statusClass = computed(() => ({
  'fqc-status--confirmed': props.question.status === 'confirmed',
  'fqc-status--draft': props.question.status === 'draft',
}))

const sectionDisplay = computed(() => {
  const s = props.question.sections
  if (s && s.length > 0) return s.join(', ')
  if (props.question.section) return props.question.section
  return null
})

const paperLabel = computed(() => {
  const p = props.question.paper
  if (!p) return null
  return p.exam_code || p.filename
})

const primaryBox = computed(() => {
  if (!props.question.boxes || props.question.boxes.length === 0) return null
  return props.question.boxes[0]
})

function onToggleFavorite() {
  emit('toggle-favorite', props.question)
}
</script>

<template>
  <div class="fqc" :class="{ 'fqc--selected': selected }">
    <!-- Selection checkbox -->
    <label class="fqc-select" @click.stop>
      <input
        type="checkbox"
        :checked="selected"
        @change="emit('update:selected', ($event.target as HTMLInputElement).checked)"
      />
      <span class="fqc-select-mark">
        <svg v-if="selected" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    </label>

    <!-- Preview thumbnail -->
    <div class="fqc-preview">
      <CropPreview
        v-if="primaryBox"
        :image-url="primaryBox.image_url"
        :bbox="primaryBox.bbox"
      />
      <div v-else class="fqc-preview-empty">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
        </svg>
      </div>
    </div>

    <!-- Content -->
    <div class="fqc-content">
      <div class="fqc-header">
        <span class="fqc-question-no">{{ question.question_no || '未编号' }}</span>
        <span class="fqc-status" :class="statusClass">{{ statusLabel }}</span>
        <button
          class="fqc-fav"
          :class="{ 'fqc-fav--active': question.is_favorite }"
          @click.stop="onToggleFavorite"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" :fill="question.is_favorite ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
        </button>
      </div>

      <div class="fqc-meta">
        <span v-if="paperLabel" class="fqc-paper">{{ paperLabel }}</span>
        <span v-if="sectionDisplay" class="fqc-section">{{ sectionDisplay }}</span>
      </div>

      <div v-if="question.notes" class="fqc-notes">
        {{ question.notes }}
      </div>

      <div class="fqc-actions">
        <button v-if="onEdit" class="fqc-action" @click.stop="onEdit(question)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          编辑
        </button>
        <button v-if="onAnswer" class="fqc-action" @click.stop="onAnswer(question)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          答案
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fqc {
  display: flex;
  gap: 12px;
  padding: 14px;
  background: var(--bg-card);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  transition: all var(--duration-normal) var(--ease-out);
  cursor: default;
}

.fqc:hover {
  background: var(--bg-card-hover);
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}

.fqc--selected {
  border-color: var(--border-accent);
  background: var(--accent-soft);
}

/* Checkbox */
.fqc-select {
  display: flex;
  align-items: flex-start;
  padding-top: 2px;
  cursor: pointer;
  flex-shrink: 0;
}

.fqc-select input {
  display: none;
}

.fqc-select-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 1.5px solid var(--border-strong);
  border-radius: 5px;
  background: transparent;
  transition: all var(--duration-fast) var(--ease-out);
  color: white;
  flex-shrink: 0;
}

.fqc--selected .fqc-select-mark {
  background: var(--accent);
  border-color: var(--accent);
}

/* Preview */
.fqc-preview {
  width: 100%;
  min-height: 200px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-input);
}

.fqc-preview-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 200px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-tertiary);
}

/* Content */
.fqc-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fqc-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fqc-question-no {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.2px;
}

.fqc-status {
  display: inline-flex;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.fqc-status--confirmed {
  background: rgba(52, 199, 89, 0.12);
  color: var(--success);
}

.fqc-status--draft {
  background: rgba(255, 159, 10, 0.12);
  color: var(--warning);
}

.fqc-fav {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: none;
  color: var(--text-tertiary);
  cursor: pointer;
  border-radius: var(--radius-xs);
  transition: all var(--duration-fast) var(--ease-out);
  margin-left: auto;
  flex-shrink: 0;
}

.fqc-fav:hover {
  background: var(--bg-hover);
  color: var(--danger);
}

.fqc-fav--active {
  color: var(--danger);
}

.fqc-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.fqc-paper {
  padding: 1px 6px;
  background: var(--bg-input);
  border-radius: var(--radius-xs);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fqc-section {
  color: var(--text-accent);
  font-weight: 500;
}

.fqc-notes {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fqc-actions {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}

.fqc-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  font-family: inherit;
  transition: all var(--duration-fast) var(--ease-out);
}

.fqc-action:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
  color: var(--text-primary);
}
</style>
