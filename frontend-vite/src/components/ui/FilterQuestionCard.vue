<script setup lang="ts">
import { computed } from 'vue'
import CropPreview from './CropPreview.vue'
import AppCheckbox from './AppCheckbox.vue'

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
    <div class="fqc-main">
      <!-- Checkbox -->
      <div class="fqc-select" @click.stop>
        <AppCheckbox
          :model-value="selected"
          @update:model-value="emit('update:selected', $event)"
        />
      </div>

      <!-- Content -->
      <div class="fqc-content">
        <div class="fqc-header">
          <span class="fqc-question-no">{{ question.question_no || '未编号' }}</span>
          <span class="fqc-status" :class="statusClass">{{ statusLabel }}</span>
          <span v-if="paperLabel" class="fqc-paper">{{ paperLabel }}</span>
          <span v-if="sectionDisplay" class="fqc-section">{{ sectionDisplay }}</span>
          <span v-if="question.notes" class="fqc-notes">{{ question.notes }}</span>
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

        <!-- Preview -->
        <div v-if="primaryBox" class="fqc-preview">
          <CropPreview
            :image-url="primaryBox.image_url"
            :bbox="primaryBox.bbox"
          />
        </div>

        <!-- Actions -->
        <div class="fqc-actions">
          <button v-if="onEdit" class="fqc-action" @click.stop="onEdit(question)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            编辑
          </button>
          <button v-if="onAnswer" class="fqc-action" @click.stop="onAnswer(question)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            答案
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fqc {
  padding: 12px 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  transition: all var(--duration-fast) var(--ease-out);
  cursor: default;
}

.fqc:hover {
  border-color: var(--border-strong);
}

.fqc--selected {
  border-color: var(--border-accent);
  background: var(--accent-soft);
}

.fqc-main {
  display: flex;
  gap: 10px;
}

/* Checkbox */
.fqc-select {
  display: flex;
  align-items: flex-start;
  padding-top: 2px;
  flex-shrink: 0;
}

/* Content */
.fqc-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fqc-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.fqc-question-no {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.2px;
}

.fqc-status {
  display: inline-flex;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 500;
  border-radius: var(--radius-xs);
  background: var(--bg-input);
  color: var(--text-secondary);
}

.fqc-status--confirmed {
  background: rgba(16, 185, 129, 0.1);
  color: var(--success);
}

.fqc-status--draft {
  background: rgba(245, 158, 11, 0.1);
  color: var(--warning);
}

.fqc-paper {
  font-size: 12px;
  padding: 1px 6px;
  background: var(--bg-input);
  border-radius: var(--radius-xs);
  color: var(--text-secondary);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fqc-section {
  font-size: 12px;
  color: var(--text-accent);
  font-weight: 500;
}

.fqc-notes {
  font-size: 12px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.fqc-fav {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
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

/* Preview */
.fqc-preview {
  width: 100%;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg-input);
}

/* Actions */
.fqc-actions {
  display: flex;
  gap: 4px;
}

.fqc-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
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
