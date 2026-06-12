<script setup lang="ts">
import { computed } from 'vue'
import SectionTagEditor from './SectionTagEditor.vue'

defineOptions({ name: 'Inspector' })

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
  paper?: {
    id: number
    filename: string
    exam_code: string | null
  }
  __ansBoxes?: any[]
  __ansOpen?: boolean
  __ansMeta?: string
  __ansLoaded?: boolean
}

const props = withDefaults(defineProps<{
  question: QuestionData | null
  collapsed?: boolean
  ansOpen?: boolean
  ansLoaded?: boolean
  ansBoxCount?: number
  editMode?: boolean
  editSections?: string[]
  editNotes?: string
  sectionOptions?: { label: string; options: { value: string; label: string }[] }[]
}>(), {
  collapsed: false,
  ansOpen: false,
  ansLoaded: false,
  ansBoxCount: 0,
  editMode: false,
  editSections: () => [],
  editNotes: '',
  sectionOptions: () => [],
})

const emit = defineEmits<{
  'toggle-favorite': []
  'toggle-collapse': []
  'edit': []
  'edit-answer': []
  'locate': []
  'delete': []
  'toggle-answer': []
  'cancel-edit': []
  'save-edit': []
  'go-to-mark': []
  'update:editSections': [value: string[]]
  'update:editNotes': [value: string]
}>()

const paperLabel = computed(() => {
  const p = props.question?.paper
  if (!p) return ''
  return p.exam_code || p.filename || ''
})

const sectionDisplay = computed(() => {
  const q = props.question
  if (!q) return []
  if (q.sections?.length) return q.sections
  if (q.section) return [q.section]
  return []
})

const statusLabel = computed(() => {
  if (!props.question) return ''
  switch (props.question.status) {
    case 'confirmed': return '已确认'
    case 'draft': return '草稿'
    default: return props.question.status
  }
})

const answerButtonText = computed(() => {
  if (!props.question) return ''
  if (props.ansOpen) return '隐藏答案'
  if (props.ansLoaded && props.ansBoxCount > 0) return '显示答案'
  if (props.ansLoaded) return '无答案'
  return '显示答案'
})
</script>

<template>
  <div class="inspector" :class="{ 'inspector--collapsed': collapsed }">
    <button class="inspector-toggle" @click="emit('toggle-collapse')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline :points="collapsed ? '9 18 15 12 9 6' : '15 18 9 12 15 6'" />
      </svg>
    </button>

    <template v-if="!collapsed && question">
      <!-- Question number -->
      <div class="inspector-section">
        <div class="inspector-qno">{{ question.question_no || '?' }}</div>
        <div class="inspector-meta">
          <span v-if="paperLabel" class="inspector-paper">{{ paperLabel }}</span>
          <span class="inspector-status" :class="{ 'inspector-status--confirmed': question.status === 'confirmed', 'inspector-status--draft': question.status === 'draft' }">{{ statusLabel }}</span>
        </div>
      </div>

      <!-- Quick edit panel -->
      <template v-if="editMode">
        <div class="inspector-section">
          <div class="inspector-label">分类</div>
          <SectionTagEditor
            :model-value="editSections"
            :option-groups="sectionOptions"
            placeholder="选择分类..."
            @update:model-value="emit('update:editSections', $event)"
          />
        </div>
        <div class="inspector-section">
          <div class="inspector-label">备注</div>
          <textarea
            class="inspector-textarea"
            :value="editNotes"
            placeholder="备注..."
            @input="emit('update:editNotes', ($event.target as HTMLTextAreaElement).value)"
          ></textarea>
        </div>
        <div class="inspector-section inspector-section--actions">
          <button class="inspector-action inspector-action--primary" @click="emit('save-edit')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            <span>保存</span>
          </button>
          <button class="inspector-action" @click="emit('go-to-mark')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            <span>去框选修改</span>
          </button>
          <button class="inspector-action" @click="emit('cancel-edit')">
            <span>取消</span>
          </button>
        </div>
      </template>

      <!-- View mode -->
      <template v-else>
        <!-- Labels -->
        <div class="inspector-section">
          <div class="inspector-label">标签</div>
          <div class="inspector-tags">
            <span v-for="s in sectionDisplay" :key="s" class="inspector-tag">{{ s }}</span>
            <span v-if="!sectionDisplay.length" class="inspector-tag inspector-tag--empty">未分类</span>
          </div>
        </div>

        <!-- Notes -->
        <div v-if="question.notes" class="inspector-section">
          <div class="inspector-label">备注</div>
          <div class="inspector-notes">{{ question.notes }}</div>
        </div>

        <!-- Answer -->
        <div class="inspector-section">
          <div class="inspector-label">答案</div>
          <button class="inspector-action-btn" @click="emit('toggle-answer')">
            {{ answerButtonText }}
          </button>
        </div>

        <!-- Actions -->
        <div class="inspector-section inspector-section--actions">
          <button class="inspector-action" @click="emit('toggle-favorite')">
          <svg width="14" height="14" viewBox="0 0 24 24" :fill="question.is_favorite ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
          <span>{{ question.is_favorite ? '取消收藏' : '收藏' }}</span>
        </button>
        <button class="inspector-action" @click="emit('edit')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          <span>编辑题目</span>
        </button>
        <button class="inspector-action" @click="emit('edit-answer')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
          </svg>
          <span>编辑答案</span>
        </button>
        <button class="inspector-action" @click="emit('locate')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <span>定位原卷</span>
        </button>
        <button class="inspector-action inspector-action--danger" @click="emit('delete')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
          <span>删除</span>
        </button>
      </div>
      </template>
    </template>

    <template v-else-if="!collapsed">
      <div class="inspector-empty">
        <span>选择题目查看属性</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.inspector {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border-left: 1px solid var(--border);
  overflow-y: auto;
  position: relative;
  transition: width 200ms var(--ease-out);
}

.inspector--collapsed {
  width: 36px;
  overflow: hidden;
}

.inspector-toggle {
  position: absolute;
  top: 8px;
  left: 4px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: var(--text-tertiary);
  cursor: pointer;
  border-radius: var(--radius-xs);
  transition: all 100ms ease;
  z-index: 1;
}

.inspector-toggle:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.inspector-section {
  padding: 12px 14px 12px 36px;
  border-bottom: 1px solid var(--border);
}

.inspector-section--actions {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-bottom: none;
}

.inspector-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
  margin-bottom: 6px;
}

.inspector-qno {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.5px;
  line-height: 1;
  margin-bottom: 8px;
}

.inspector-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}

.inspector-paper {
  font-size: 12px;
  color: var(--text-secondary);
  padding: 1px 6px;
  background: var(--bg-input);
  border-radius: var(--radius-xs);
}

.inspector-status {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--bg-input);
  color: var(--text-secondary);
}

.inspector-status--confirmed {
  background: rgba(16, 185, 129, 0.1);
  color: var(--success);
}

.inspector-status--draft {
  background: rgba(245, 158, 11, 0.1);
  color: var(--warning);
}

.inspector-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.inspector-tag {
  font-size: 12px;
  padding: 2px 8px;
  background: var(--accent-soft);
  color: var(--text-accent);
  border-radius: var(--radius-xs);
}

.inspector-tag--empty {
  background: var(--bg-input);
  color: var(--text-tertiary);
}

.inspector-notes {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.inspector-action-btn {
  padding: 4px 10px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: all 100ms ease;
}

.inspector-action-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.inspector-action {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: all 100ms ease;
}

.inspector-action:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.inspector-action--danger {
  color: var(--danger);
}

.inspector-action--danger:hover {
  background: rgba(239, 68, 68, 0.06);
  color: var(--danger);
}

.inspector-action--primary {
  color: var(--text-accent);
  font-weight: 600;
}

.inspector-action--primary:hover {
  background: var(--accent-soft);
}

.inspector-textarea {
  width: 100%;
  min-height: 60px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--bg-input);
  font-size: 13px;
  font-family: inherit;
  color: var(--text-primary);
  outline: none;
  resize: vertical;
  transition: border-color 100ms ease;
}

.inspector-textarea:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.inspector-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-tertiary);
  font-size: 13px;
  padding: 36px 14px;
}

@media (max-width: 900px) {
  .inspector {
    width: 100%;
    border-left: none;
    border-top: 1px solid var(--border);
    max-height: 240px;
  }

  .inspector--collapsed {
    width: 100%;
    height: 36px;
  }
}
</style>
