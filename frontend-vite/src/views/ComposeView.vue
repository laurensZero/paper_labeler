<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useComposeStore } from '@/stores/compose'
import { useFilterStore } from '@/stores/filter'
import { useSectionsStore } from '@/stores/sections'
import { usePapersStore } from '@/stores/papers'
import { useAppStore } from '@/stores/app'
import { useDialogStore } from '@/stores/dialog'
import { useExportStore } from '@/stores/export'
import { questionsApi } from '@/api/endpoints'
import MultiSelect from '@/components/ui/MultiSelect.vue'
import SectionCascadeSelect from '@/components/ui/SectionCascadeSelect.vue'
import type { Question, FilterQuestion } from '@/types'

defineOptions({ name: 'ComposeView' })

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const composeStore = useComposeStore()
const filterStore = useFilterStore()
const sectionsStore = useSectionsStore()
const papersStore = usePapersStore()
const appStore = useAppStore()
const dialogStore = useDialogStore()
const exportStore = useExportStore()

const {
  compositions,
  current,
  items,
  dirty,
  loading,
  selectedItemId,
  previewMode,
  questionItemCount,
  blankPageCount,
  estimatedPages,
  groupedItems,
} = storeToRefs(composeStore)

/* ── Question bank filter state ── */
const bankSection = ref('')
const bankYearMulti = ref<string[]>([])
const bankSeasonMulti = ref<string[]>([])
const bankPaperMulti = ref<number[]>([])
const bankFavOnly = ref(false)
const bankResults = ref<Question[]>([])
const bankLoading = ref(false)
const bankPage = ref(1)
const bankTotal = ref(0)
const bankPageSize = ref(30)

/* ── Composition list modal ── */
const showListModal = ref(false)
const newName = ref('')

/* ── Edit name inline ── */
const editingName = ref(false)
const editNameInput = ref('')

/* ── Load composition from route ── */
onMounted(async () => {
  await composeStore.loadCompositions()
  const id = route.params.id
  if (id) {
    await composeStore.loadComposition(Number(id))
  }
})

watch(() => route.params.id, async (id) => {
  if (id) {
    await composeStore.loadComposition(Number(id))
  }
})

/* ── Year/Season options ── */
const yearOptions = computed(() => {
  const years = new Set<string>()
  papersStore.papers.forEach(p => {
    if (p.year_token) years.add(p.year_token)
  })
  return Array.from(years).sort((a, b) => Number(b) - Number(a))
})

const seasonOptions = [
  { value: 'm', label: 'Spring (m)' },
  { value: 's', label: 'Summer (s)' },
  { value: 'w', label: 'Winter (w)' },
]

const sectionCascadeOptions = computed(() => {
  const groups: { label: string; options: { value: string; label: string }[] }[] = [
    { label: t('filter.module'), options: [{ value: '', label: t('filter.allModules') }] },
  ]
  for (const g of sectionsStore.sectionOptionGroupsAll || []) {
    groups.push({
      label: g.label,
      options: g.options.map(o => ({ value: o, label: sectionsStore.sectionDisplayName(o) })),
    })
  }
  return groups
})

/* ── Search questions ── */
async function searchBank(resetPage = true) {
  if (resetPage) bankPage.value = 1
  bankLoading.value = true
  try {
    const resp = await questionsApi.search({
      section: bankSection.value || undefined,
      years: bankYearMulti.value.length ? bankYearMulti.value : undefined,
      seasons: bankSeasonMulti.value.length ? bankSeasonMulti.value : undefined,
      paperIds: bankPaperMulti.value.length ? bankPaperMulti.value : undefined,
      favorite: bankFavOnly.value || undefined,
      page: bankPage.value,
      pageSize: bankPageSize.value,
    })
    bankResults.value = (resp as any).questions || []
    bankTotal.value = (resp as any).total || 0
  } catch (e) {
    appStore.setStatus(`搜索失败：${e}`, 'err')
  } finally {
    bankLoading.value = false
  }
}

onMounted(() => searchBank())

/* ── Check if question is in composition ── */
function isInComposition(questionId: number): boolean {
  return items.value.some(i => i.question_id === questionId && i.item_type === 'question')
}

/* ── Toggle question in composition ── */
async function toggleQuestion(q: Question) {
  if (!current.value) {
    appStore.setStatus(t('compose.emptyPanel'), 'info')
    return
  }
  if (isInComposition(q.id)) {
    const item = items.value.find(i => i.question_id === q.id && i.item_type === 'question')
    if (item) await composeStore.removeItem(item.id)
  } else {
    await composeStore.addQuestion(q.id)
  }
}

/* ── Composition management ── */
async function createNew() {
  const name = newName.value.trim() || t('compose.untitled')
  const id = await composeStore.createComposition({ name })
  if (id) {
    newName.value = ''
    router.push({ name: 'compose-edit', params: { id: String(id) } })
    showListModal.value = false
  }
}

async function openComposition(id: number) {
  router.push({ name: 'compose-edit', params: { id: String(id) } })
  showListModal.value = false
}

async function deleteComposition(id: number) {
  const ok = await dialogStore.confirm(t('compose.confirmDelete'), {
    title: t('compose.confirmDeleteTitle'),
  })
  if (!ok) return
  await composeStore.deleteComposition(id)
  if (current.value?.id === id) {
    router.push({ name: 'compose' })
  }
}

async function duplicateComposition(id: number) {
  const newId = await composeStore.duplicateComposition(id)
  if (newId) {
    router.push({ name: 'compose-edit', params: { id: String(newId) } })
  }
}

function startEditName() {
  if (!current.value) return
  editNameInput.value = current.value.name
  editingName.value = true
}

function finishEditName() {
  if (!current.value) return
  const name = editNameInput.value.trim()
  if (name && name !== current.value.name) {
    composeStore.updateComposition({ name })
  }
  editingName.value = false
}

/* ── Preview item click ── */
function onPreviewItemClick(itemId: number) {
  composeStore.selectItem(itemId === selectedItemId.value ? null : itemId)
}

/* ── Keyboard shortcuts ── */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Delete' && selectedItemId.value != null) {
    composeStore.removeItem(selectedItemId.value)
  }
  if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    // Save is auto, just clear dirty
    appStore.setStatus('已保存', 'ok')
  }
}

/* ── Export ── */
async function exportComposition() {
  if (!current.value || !items.value.length) {
    appStore.setStatus('没有可导出的题目', 'err')
    return
  }
  const ids = items.value
    .filter(i => i.item_type === 'question')
    .map(i => i.question_id)
  exportStore.pendingExportIds = ids
  exportStore.exportWizardOpen = true
}
</script>

<template>
  <div class="compose-view" @keydown="onKeydown" tabindex="0">
    <!-- Empty state: no composition selected -->
    <div v-if="!current" class="compose-empty-state">
      <div class="empty-state-content">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="empty-icon">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="12" y1="11" x2="12" y2="17" />
          <line x1="9" y1="14" x2="15" y2="14" />
        </svg>
        <h2>{{ t('compose.title') }}</h2>
        <p>{{ t('compose.emptyPanel') }}</p>
        <div class="empty-actions">
          <button class="btn-primary" @click="showListModal = true">
            {{ t('compose.loadList') }}
          </button>
          <button class="btn-secondary" @click="createNew">
            {{ t('compose.newComposition') }}
          </button>
        </div>
      </div>

      <!-- Composition list modal -->
      <Teleport to="body">
        <div v-if="showListModal" class="modal-overlay" @click.self="showListModal = false">
          <div class="modal-content">
            <div class="modal-header">
              <h3>{{ t('compose.loadList') }}</h3>
              <button class="modal-close" @click="showListModal = false">×</button>
            </div>
            <div class="modal-body">
              <div class="new-comp-row">
                <input
                  v-model="newName"
                  :placeholder="t('compose.compositionName')"
                  class="new-comp-input"
                  @keyup.enter="createNew"
                />
                <button class="btn-primary btn-sm" @click="createNew">
                  {{ t('compose.newComposition') }}
                </button>
              </div>
              <div class="comp-list">
                <div
                  v-for="comp in compositions"
                  :key="comp.id"
                  class="comp-list-item"
                  @click="openComposition(comp.id)"
                >
                  <div class="comp-list-info">
                    <span class="comp-list-name">{{ comp.name }}</span>
                    <span class="comp-list-meta">{{ comp.item_count }} {{ t('compose.totalQuestions').toLowerCase() }}</span>
                  </div>
                  <div class="comp-list-actions">
                    <button class="btn-icon" @click.stop="duplicateComposition(comp.id)" :title="t('compose.duplicate')">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                    <button class="btn-icon btn-icon--danger" @click.stop="deleteComposition(comp.id)" :title="t('compose.delete')">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </div>
                </div>
                <div v-if="!compositions.length" class="comp-list-empty">
                  暂无方案
                </div>
              </div>
            </div>
          </div>
        </div>
      </Teleport>
    </div>

    <!-- Main compose layout -->
    <template v-else>
      <!-- Toolbar -->
      <div class="compose-toolbar">
        <div class="toolbar-left">
          <button class="btn-ghost" @click="showListModal = true" :title="t('compose.loadList')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          </button>
          <div v-if="editingName" class="name-edit">
            <input
              v-model="editNameInput"
              class="name-input"
              @keyup.enter="finishEditName"
              @blur="finishEditName"
              autofocus
            />
          </div>
          <div v-else class="name-display" @click="startEditName">
            <span>{{ current.name }}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </div>
          <span v-if="dirty" class="dirty-dot" title="有未保存的修改">●</span>
        </div>
        <div class="toolbar-right">
          <button class="btn-ghost" @click="duplicateComposition(current.id)" :title="t('compose.duplicate')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <button class="btn-ghost btn-ghost--danger" @click="deleteComposition(current.id)" :title="t('compose.delete')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
          <button class="btn-primary" @click="exportComposition" :disabled="!items.length">
            {{ t('compose.export') }}
          </button>
        </div>
      </div>

      <!-- Three column layout -->
      <div class="compose-body">
        <!-- Left: Question Bank Panel -->
        <div class="compose-panel compose-panel--bank">
          <div class="panel-header">
            <span>{{ t('compose.questionPanel') }}</span>
          </div>
          <div class="bank-filters">
            <SectionCascadeSelect
              v-model="bankSection"
              :groups="sectionCascadeOptions"
              @update:model-value="searchBank()"
            />
            <MultiSelect
              v-model="bankYearMulti"
              :options="yearOptions.map(y => ({ value: y, label: y }))"
              :placeholder="'Year'"
              @update:model-value="searchBank()"
            />
            <MultiSelect
              v-model="bankSeasonMulti"
              :options="seasonOptions"
              :placeholder="'Season'"
              @update:model-value="searchBank()"
            />
            <label class="fav-filter">
              <input type="checkbox" v-model="bankFavOnly" @change="searchBank()" />
              <span>★</span>
            </label>
          </div>
          <div class="bank-list">
            <div v-if="bankLoading" class="bank-loading">加载中...</div>
            <template v-else>
              <div
                v-for="q in bankResults"
                :key="q.id"
                class="bank-item"
                :class="{ 'bank-item--added': isInComposition(q.id) }"
                @click="toggleQuestion(q)"
              >
                <div class="bank-item-check">
                  <svg v-if="isInComposition(q.id)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div class="bank-item-info">
                  <span class="bank-item-qno">{{ q.question_no || '?' }}</span>
                  <span class="bank-item-sections">{{ q.sections?.[0] || '' }}</span>
                </div>
                <img
                  v-if="q.preview_image_url"
                  :src="q.preview_image_url"
                  class="bank-item-thumb"
                  loading="lazy"
                />
              </div>
            </template>
            <div v-if="!bankLoading && bankTotal > bankPageSize" class="bank-pagination">
              <button :disabled="bankPage <= 1" @click="bankPage--; searchBank(false)">‹</button>
              <span>{{ bankPage }} / {{ Math.ceil(bankTotal / bankPageSize) }}</span>
              <button :disabled="bankPage >= Math.ceil(bankTotal / bankPageSize)" @click="bankPage++; searchBank(false)">›</button>
            </div>
          </div>
        </div>

        <!-- Center: Preview -->
        <div class="compose-panel compose-panel--preview">
          <div class="preview-toolbar">
            <div class="preview-mode-toggle">
              <button
                :class="{ active: previewMode === 'grouped' }"
                @click="previewMode = 'grouped'"
              >
                {{ t('compose.groupBySection') }}
              </button>
              <button
                :class="{ active: previewMode === 'free' }"
                @click="previewMode = 'free'"
              >
                {{ t('compose.freeOrder') }}
              </button>
            </div>
          </div>
          <div class="preview-scroll">
            <div v-if="!items.length" class="preview-empty">
              {{ t('compose.empty') }}
            </div>
            <template v-else>
              <!-- Grouped mode -->
              <template v-if="previewMode === 'grouped' && groupedItems">
                <template v-for="group in groupedItems" :key="group.section">
                  <div v-if="current.show_section_headers" class="section-header">
                    {{ group.section === '__ungrouped' ? t('compose.sectionHeader') : group.section }}
                  </div>
                  <template v-for="item in group.items" :key="item.id">
                    <div
                      v-if="item.item_type === 'question'"
                      class="preview-page"
                      :class="{ 'preview-page--selected': selectedItemId === item.id }"
                      @click="onPreviewItemClick(item.id)"
                    >
                      <div class="page-header" v-if="current.show_question_info">
                        <span class="page-qno">{{ item.question_no || '?' }}</span>
                        <span class="page-sections">{{ item.sections?.join(', ') || '' }}</span>
                        <span class="page-source">{{ item.paper_exam_code || '' }}</span>
                      </div>
                      <div class="page-content">
                        <div class="page-frame">
                          <img
                            v-if="item.preview_image_url"
                            :src="item.preview_image_url"
                            class="page-image"
                          />
                        </div>
                      </div>
                    </div>
                    <div v-else class="preview-blank-page" :class="{ 'preview-page--selected': selectedItemId === item.id }" @click="onPreviewItemClick(item.id)">
                      <span>{{ t('compose.insertBlank') }}</span>
                    </div>
                    <!-- Attached blank pages -->
                    <div
                      v-for="n in (item.item_type === 'question' ? item.blank_pages : 0)"
                      :key="`blank-${item.id}-${n}`"
                      class="preview-blank-page"
                    >
                      <span>{{ t('compose.insertBlank') }}</span>
                    </div>
                  </template>
                </template>
              </template>
              <!-- Free mode -->
              <template v-else>
                <template v-for="item in items" :key="item.id">
                  <div
                    v-if="item.item_type === 'question'"
                    class="preview-page"
                    :class="{ 'preview-page--selected': selectedItemId === item.id }"
                    @click="onPreviewItemClick(item.id)"
                  >
                    <div class="page-header" v-if="current.show_question_info">
                      <span class="page-qno">{{ item.question_no || '?' }}</span>
                      <span class="page-sections">{{ item.sections?.join(', ') || '' }}</span>
                      <span class="page-source">{{ item.paper_exam_code || '' }}</span>
                    </div>
                    <div class="page-content">
                      <div class="page-frame">
                        <img
                          v-if="item.preview_image_url"
                          :src="item.preview_image_url"
                          class="page-image"
                        />
                      </div>
                    </div>
                  </div>
                  <div v-else class="preview-blank-page" :class="{ 'preview-page--selected': selectedItemId === item.id }" @click="onPreviewItemClick(item.id)">
                    <span>{{ t('compose.insertBlank') }}</span>
                  </div>
                  <div
                    v-for="n in (item.item_type === 'question' ? item.blank_pages : 0)"
                    :key="`blank-${item.id}-${n}`"
                    class="preview-blank-page"
                  >
                    <span>{{ t('compose.insertBlank') }}</span>
                  </div>
                </template>
              </template>
            </template>
          </div>
        </div>

        <!-- Right: Properties + Stats -->
        <div class="compose-panel compose-panel--props">
          <div class="panel-header">
            <span>{{ t('compose.stats') }}</span>
          </div>
          <div class="stats-grid">
            <div class="stat-item">
              <span class="stat-value">{{ questionItemCount }}</span>
              <span class="stat-label">{{ t('compose.totalQuestions') }}</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">{{ blankPageCount }}</span>
              <span class="stat-label">{{ t('compose.totalBlankPages') }}</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">{{ estimatedPages }}</span>
              <span class="stat-label">{{ t('compose.estimatedPages') }}</span>
            </div>
          </div>

          <div class="panel-header">
            <span>{{ t('compose.properties') }}</span>
          </div>
          <div class="props-section">
            <label class="prop-label">{{ t('compose.title_label') }}</label>
            <input
              class="prop-input"
              :value="current.title || ''"
              @input="composeStore.updateComposition({ title: ($event.target as HTMLInputElement).value || null })"
            />

            <label class="prop-label">{{ t('compose.headerText') }}</label>
            <input
              class="prop-input"
              :value="current.header_text || ''"
              @input="composeStore.updateComposition({ headerText: ($event.target as HTMLInputElement).value || null })"
            />

            <label class="prop-label">{{ t('compose.footerText') }}</label>
            <input
              class="prop-input"
              :value="current.footer_text || ''"
              @input="composeStore.updateComposition({ footerText: ($event.target as HTMLInputElement).value || null })"
            />

            <div class="prop-toggle">
              <label>
                <input type="checkbox" :checked="current.include_answers" @change="composeStore.toggleAnswers()" />
                {{ t('compose.answerToggle') }}
              </label>
            </div>

            <div v-if="current.include_answers" class="prop-toggle">
              <label class="prop-label">{{ t('compose.answerPlacement') }}</label>
              <select
                class="prop-select"
                :value="current.answers_placement"
                @change="composeStore.setAnswersPlacement(($event.target as HTMLSelectElement).value as any)"
              >
                <option value="end">{{ t('compose.placementEnd') }}</option>
                <option value="interleaved">{{ t('compose.placementInterleaved') }}</option>
              </select>
            </div>

            <div class="prop-toggle">
              <label>
                <input type="checkbox" :checked="current.show_question_info" @change="composeStore.updateComposition({ showQuestionInfo: !current.show_question_info })" />
                {{ t('compose.showQuestionInfo') }}
              </label>
            </div>
            <div class="prop-toggle">
              <label>
                <input type="checkbox" :checked="current.show_page_numbers" @change="composeStore.updateComposition({ showPageNumbers: !current.show_page_numbers })" />
                {{ t('compose.showPageNumbers') }}
              </label>
            </div>
            <div class="prop-toggle">
              <label>
                <input type="checkbox" :checked="current.show_section_headers" @change="composeStore.updateComposition({ showSectionHeaders: !current.show_section_headers })" />
                {{ t('compose.showSectionHeaders') }}
              </label>
            </div>
          </div>

          <!-- Selected item properties -->
          <template v-if="selectedItemId != null">
            <div class="panel-header">
              <span>选中题目</span>
            </div>
            <div class="selected-item-props">
              <template v-if="composeStore.selectedItems?.item_type === 'question'">
                <div class="prop-row">
                  <span>题号: {{ composeStore.selectedItems.question_no || '?' }}</span>
                </div>
                <div class="prop-row">
                  <span>来源: {{ composeStore.selectedItems.paper_exam_code || '-' }}</span>
                </div>
                <label class="prop-label">{{ t('compose.blankPages') }}</label>
                <div class="blank-pages-control">
                  <button @click="composeStore.updateItemBlankPages(selectedItemId, Math.max(0, composeStore.selectedItems.blank_pages - 1))">-</button>
                  <span>{{ composeStore.selectedItems.blank_pages }}</span>
                  <button @click="composeStore.updateItemBlankPages(selectedItemId, composeStore.selectedItems.blank_pages + 1)">+</button>
                </div>
              </template>
              <button class="btn-ghost btn-ghost--danger btn-sm" @click="composeStore.removeItem(selectedItemId)">
                {{ t('compose.removeItem') }}
              </button>
            </div>
          </template>
        </div>
      </div>
    </template>

    <!-- Composition list modal (shared) -->
    <Teleport to="body">
      <div v-if="showListModal && current" class="modal-overlay" @click.self="showListModal = false">
        <div class="modal-content">
          <div class="modal-header">
            <h3>{{ t('compose.loadList') }}</h3>
            <button class="modal-close" @click="showListModal = false">×</button>
          </div>
          <div class="modal-body">
            <div class="new-comp-row">
              <input
                v-model="newName"
                :placeholder="t('compose.compositionName')"
                class="new-comp-input"
                @keyup.enter="createNew"
              />
              <button class="btn-primary btn-sm" @click="createNew">
                {{ t('compose.newComposition') }}
              </button>
            </div>
            <div class="comp-list">
              <div
                v-for="comp in compositions"
                :key="comp.id"
                class="comp-list-item"
                :class="{ 'comp-list-item--active': comp.id === current?.id }"
                @click="openComposition(comp.id)"
              >
                <div class="comp-list-info">
                  <span class="comp-list-name">{{ comp.name }}</span>
                  <span class="comp-list-meta">{{ comp.item_count }} {{ t('compose.totalQuestions').toLowerCase() }}</span>
                </div>
                <div class="comp-list-actions">
                  <button class="btn-icon" @click.stop="duplicateComposition(comp.id)" :title="t('compose.duplicate')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  </button>
                  <button class="btn-icon btn-icon--danger" @click.stop="deleteComposition(comp.id)" :title="t('compose.delete')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                </div>
              </div>
              <div v-if="!compositions.length" class="comp-list-empty">
                暂无方案
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.compose-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  outline: none;
}

/* ── Empty state ── */
.compose-empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.empty-state-content {
  text-align: center;
  color: var(--text-secondary);
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: 16px;
}

.empty-state-content h2 {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.empty-state-content p {
  margin: 0 0 24px;
}

.empty-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}

/* ── Toolbar ── */
.compose-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex-shrink: 0;
  gap: 12px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.name-display {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
  padding: 4px 8px;
  border-radius: var(--radius-xs);
  transition: background 100ms;
  min-width: 0;
}

.name-display:hover {
  background: var(--bg-hover);
}

.name-display span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name-display svg {
  flex-shrink: 0;
  opacity: 0.5;
}

.name-input {
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  padding: 4px 8px;
  border: 1px solid var(--border-accent);
  border-radius: var(--radius-xs);
  background: var(--bg-input);
  color: var(--text-primary);
  outline: none;
  width: 200px;
}

.dirty-dot {
  color: var(--warning);
  font-size: 18px;
}

/* ── Three column layout ── */
.compose-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.compose-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.compose-panel--bank {
  width: 280px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-sidebar);
}

.compose-panel--preview {
  flex: 1;
  min-width: 0;
  background: var(--bg-main);
}

.compose-panel--props {
  width: 260px;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: var(--bg-sidebar);
  overflow-y: auto;
}

.panel-header {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid var(--border);
}

/* ── Bank filters ── */
.bank-filters {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.fav-filter {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  cursor: pointer;
}

.fav-filter input {
  margin: 0;
}

/* ── Bank list ── */
.bank-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.bank-loading {
  padding: 20px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

.bank-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  transition: background 100ms;
}

.bank-item:hover {
  background: var(--bg-hover);
}

.bank-item--added {
  background: var(--accent-soft);
}

.bank-item-check {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--accent);
}

.bank-item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.bank-item-qno {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.bank-item-sections {
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bank-item-thumb {
  width: 48px;
  height: 32px;
  object-fit: cover;
  border-radius: 3px;
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.bank-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.bank-pagination button {
  padding: 2px 8px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  border-radius: var(--radius-xs);
  cursor: pointer;
  color: var(--text-primary);
}

.bank-pagination button:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ── Preview ── */
.preview-toolbar {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  gap: 12px;
}

.preview-mode-toggle {
  display: flex;
  gap: 2px;
  background: var(--bg-input);
  border-radius: var(--radius-xs);
  padding: 2px;
}

.preview-mode-toggle button {
  padding: 4px 12px;
  border: none;
  background: none;
  font-size: 12px;
  font-family: inherit;
  color: var(--text-secondary);
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: all 100ms;
}

.preview-mode-toggle button.active {
  background: var(--bg-sidebar);
  color: var(--text-primary);
  font-weight: 500;
  box-shadow: 0 1px 2px rgba(0,0,0,0.1);
}

.preview-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.preview-empty {
  padding: 60px 20px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 14px;
}

/* ── Preview page ── */
.preview-page {
  width: 420px;
  min-height: 560px;
  background: white;
  border: 1px solid var(--border);
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  border-radius: 4px;
  cursor: pointer;
  transition: box-shadow 150ms, border-color 150ms;
  overflow: hidden;
}

.preview-page:hover {
  box-shadow: 0 4px 16px rgba(0,0,0,0.12);
}

.preview-page--selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.page-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  border-bottom: 1px solid #eee;
  background: #fafafa;
}

.page-qno {
  font-weight: 700;
  color: #333;
}

.page-sections {
  color: #666;
}

.page-source {
  color: #999;
  margin-left: auto;
}

.page-content {
  padding: 8px;
}

.page-frame {
  border: 2px solid #000;
  border-radius: 2px;
  overflow: hidden;
}

.page-image {
  width: 100%;
  display: block;
}

/* ── Blank page ── */
.preview-blank-page {
  width: 420px;
  min-height: 560px;
  background: #fafafa;
  border: 2px dashed #ccc;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ccc;
  font-style: italic;
  font-size: 14px;
  cursor: pointer;
  transition: border-color 150ms;
}

.preview-blank-page:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.preview-blank-page.preview-page--selected {
  border-color: var(--accent);
  border-style: solid;
}

/* ── Section header ── */
.section-header {
  width: 420px;
  padding: 10px 16px;
  background: #f0f0f0;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-weight: 600;
  font-size: 14px;
  color: #333;
}

/* ── Stats ── */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
}

.stat-label {
  font-size: 10px;
  color: var(--text-tertiary);
  text-transform: uppercase;
}

/* ── Properties ── */
.props-section {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.prop-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  margin-top: 4px;
}

.prop-input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
}

.prop-input:focus {
  border-color: var(--border-accent);
}

.prop-select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
}

.prop-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-primary);
}

.prop-toggle label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.prop-toggle input[type="checkbox"] {
  margin: 0;
}

/* ── Selected item props ── */
.selected-item-props {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.prop-row {
  font-size: 13px;
  color: var(--text-primary);
}

.blank-pages-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.blank-pages-control button {
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  border-radius: var(--radius-xs);
  cursor: pointer;
  font-size: 16px;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.blank-pages-control button:hover {
  background: var(--bg-hover);
}

.blank-pages-control span {
  font-size: 16px;
  font-weight: 600;
  min-width: 24px;
  text-align: center;
}

/* ── Buttons ── */
.btn-primary {
  padding: 7px 16px;
  border: none;
  background: var(--accent);
  color: white;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: opacity 100ms;
}

.btn-primary:hover {
  opacity: 0.9;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.btn-secondary {
  padding: 7px 16px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: background 100ms;
}

.btn-secondary:hover {
  background: var(--bg-hover);
}

.btn-ghost {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  border: none;
  background: none;
  color: var(--text-secondary);
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: all 100ms;
}

.btn-ghost:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn-ghost--danger:hover {
  background: rgba(239, 68, 68, 0.1);
  color: var(--danger);
}

.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.btn-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: none;
  color: var(--text-secondary);
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: all 100ms;
}

.btn-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn-icon--danger:hover {
  background: rgba(239, 68, 68, 0.1);
  color: var(--danger);
}

/* ── Modal ── */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-content {
  background: var(--bg-sidebar);
  border-radius: 12px;
  width: 480px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.modal-close {
  width: 28px;
  height: 28px;
  border: none;
  background: none;
  font-size: 20px;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: var(--radius-xs);
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

.new-comp-row {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.new-comp-input {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
}

.new-comp-input:focus {
  border-color: var(--border-accent);
}

.comp-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.comp-list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: all 100ms;
}

.comp-list-item:hover {
  background: var(--bg-hover);
}

.comp-list-item--active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.comp-list-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.comp-list-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.comp-list-meta {
  font-size: 12px;
  color: var(--text-tertiary);
}

.comp-list-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.comp-list-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}
</style>
