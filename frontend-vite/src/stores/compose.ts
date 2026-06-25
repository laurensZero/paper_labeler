import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { compositionsApi } from '@/api/endpoints'
import { useAppStore } from './app'
import { useDialogStore } from './dialog'
import type {
  Composition,
  CompositionDetail,
  CompositionItemDetail,
  CompositionCreateParams,
  CompositionUpdateParams,
} from '@/types'

export const useComposeStore = defineStore('compose', () => {
  // --- state ---
  const compositions = ref<Composition[]>([])
  const current = ref<CompositionDetail | null>(null)
  const items = ref<CompositionItemDetail[]>([])
  const dirty = ref(false)
  const loading = ref(false)
  const saving = ref(false)
  const selectedItemId = ref<number | null>(null)
  const previewMode = ref<'grouped' | 'free'>('grouped')

  // --- computed ---
  const itemCount = computed(() => items.value.length)
  const questionItemCount = computed(() => items.value.filter(i => i.item_type === 'question').length)
  const blankPageCount = computed(() => {
    let count = 0
    for (const item of items.value) {
      if (item.item_type === 'blank_page') count++
      else count += item.blank_pages
    }
    return count
  })
  const estimatedPages = computed(() => questionItemCount.value + blankPageCount.value)
  const selectedItems = computed(() => {
    const sel = selectedItemId.value
    return sel != null ? items.value.find(i => i.id === sel) ?? null : null
  })

  /** Section-grouped items for preview */
  const groupedItems = computed(() => {
    if (!current.value?.group_by_section) return null
    const groups: { section: string; items: CompositionItemDetail[] }[] = []
    const sectionMap = new Map<string, CompositionItemDetail[]>()
    const order: string[] = []

    for (const item of items.value) {
      if (item.item_type === 'blank_page') {
        // Attach blank page to the previous section
        const lastSection = order.length ? order[order.length - 1] : '__ungrouped'
        if (!sectionMap.has(lastSection)) {
          sectionMap.set(lastSection, [])
          order.push(lastSection)
        }
        sectionMap.get(lastSection)!.push(item)
        continue
      }
      const section = item.sections?.[0] || '__ungrouped'
      if (!sectionMap.has(section)) {
        sectionMap.set(section, [])
        order.push(section)
      }
      sectionMap.get(section)!.push(item)
    }

    for (const section of order) {
      groups.push({ section, items: sectionMap.get(section)! })
    }
    return groups
  })

  // --- actions ---

  async function loadCompositions() {
    try {
      compositions.value = await compositionsApi.list()
    } catch (e) {
      useAppStore().setStatus(`加载方案列表失败：${e}`, 'err')
    }
  }

  async function loadComposition(id: number) {
    loading.value = true
    try {
      const detail = await compositionsApi.get(id)
      current.value = detail
      items.value = detail.items || []
      dirty.value = false
      selectedItemId.value = null
    } catch (e) {
      useAppStore().setStatus(`加载方案失败：${e}`, 'err')
    } finally {
      loading.value = false
    }
  }

  async function createComposition(params: CompositionCreateParams): Promise<number | null> {
    try {
      const comp = await compositionsApi.create(params)
      compositions.value.unshift(comp)
      return comp.id
    } catch (e) {
      useAppStore().setStatus(`创建方案失败：${e}`, 'err')
      return null
    }
  }

  async function updateComposition(params: CompositionUpdateParams) {
    if (!current.value) return
    try {
      const updated = await compositionsApi.update(current.value.id, params)
      // Update current detail fields
      Object.assign(current.value, updated)
      // Update list entry
      const idx = compositions.value.findIndex(c => c.id === updated.id)
      if (idx >= 0) compositions.value[idx] = updated
      dirty.value = false
    } catch (e) {
      useAppStore().setStatus(`更新方案失败：${e}`, 'err')
    }
  }

  async function deleteComposition(id: number) {
    try {
      await compositionsApi.delete(id)
      compositions.value = compositions.value.filter(c => c.id !== id)
      if (current.value?.id === id) {
        current.value = null
        items.value = []
        dirty.value = false
      }
    } catch (e) {
      useAppStore().setStatus(`删除方案失败：${e}`, 'err')
    }
  }

  async function duplicateComposition(id: number): Promise<number | null> {
    try {
      const comp = await compositionsApi.duplicate(id)
      compositions.value.unshift(comp)
      return comp.id
    } catch (e) {
      useAppStore().setStatus(`复制方案失败：${e}`, 'err')
      return null
    }
  }

  async function addQuestion(questionId: number) {
    if (!current.value) return
    // Check duplicate
    if (items.value.some(i => i.question_id === questionId && i.item_type === 'question')) {
      useAppStore().setStatus('该题已在方案中', 'info')
      return
    }
    try {
      const item = await compositionsApi.addItem(current.value.id, { questionId })
      items.value.push(item)
      dirty.value = true
    } catch (e) {
      useAppStore().setStatus(`添加题目失败：${e}`, 'err')
    }
  }

  async function removeItem(itemId: number) {
    if (!current.value) return
    try {
      await compositionsApi.removeItem(current.value.id, itemId)
      items.value = items.value.filter(i => i.id !== itemId)
      if (selectedItemId.value === itemId) selectedItemId.value = null
      dirty.value = true
    } catch (e) {
      useAppStore().setStatus(`移除失败：${e}`, 'err')
    }
  }

  async function updateItemBlankPages(itemId: number, blankPages: number) {
    if (!current.value) return
    try {
      const updated = await compositionsApi.updateItem(current.value.id, itemId, { blankPages })
      const idx = items.value.findIndex(i => i.id === itemId)
      if (idx >= 0) items.value[idx] = { ...items.value[idx], ...updated }
      dirty.value = true
    } catch (e) {
      useAppStore().setStatus(`更新失败：${e}`, 'err')
    }
  }

  async function insertBlankPage(afterItemId?: number) {
    if (!current.value) return
    try {
      const item = await compositionsApi.insertBlankPage(current.value.id, afterItemId)
      // Reload to get correct sort orders
      await loadComposition(current.value.id)
    } catch (e) {
      useAppStore().setStatus(`插入空白页失败：${e}`, 'err')
    }
  }

  async function reorderItems(itemIds: number[]) {
    if (!current.value) return
    try {
      await compositionsApi.reorder(current.value.id, { itemIds })
      // Reorder local items to match
      const map = new Map(items.value.map(i => [i.id, i]))
      const reordered = itemIds.map(id => map.get(id)).filter(Boolean) as CompositionItemDetail[]
      // Append any items not in the reorder list (shouldn't happen but be safe)
      const idSet = new Set(itemIds)
      for (const item of items.value) {
        if (!idSet.has(item.id)) reordered.push(item)
      }
      items.value = reordered
      dirty.value = true
    } catch (e) {
      useAppStore().setStatus(`排序失败：${e}`, 'err')
    }
  }

  async function addQuestionsBatch(questionIds: number[]) {
    if (!current.value) return
    try {
      const result = await compositionsApi.addItemsBatch(current.value.id, { questionIds })
      // Reload to get full item details
      await loadComposition(current.value.id)
      if (result.skipped.length) {
        useAppStore().setStatus(`已添加 ${result.added} 题，跳过 ${result.skipped.length} 题（已存在）`, 'info')
      } else {
        useAppStore().setStatus(`已添加 ${result.added} 题`, 'ok')
      }
    } catch (e) {
      useAppStore().setStatus(`批量添加失败：${e}`, 'err')
    }
  }

  function toggleAnswers() {
    if (!current.value) return
    updateComposition({ includeAnswers: !current.value.include_answers })
  }

  function setAnswersPlacement(placement: 'end' | 'interleaved') {
    if (!current.value) return
    updateComposition({ answersPlacement: placement })
  }

  function selectItem(itemId: number | null) {
    selectedItemId.value = itemId
  }

  function markDirty() {
    dirty.value = true
  }

  function reset() {
    current.value = null
    items.value = []
    dirty.value = false
    selectedItemId.value = null
  }

  return {
    // state
    compositions,
    current,
    items,
    dirty,
    loading,
    saving,
    selectedItemId,
    previewMode,
    // computed
    itemCount,
    questionItemCount,
    blankPageCount,
    estimatedPages,
    selectedItems,
    groupedItems,
    // actions
    loadCompositions,
    loadComposition,
    createComposition,
    updateComposition,
    deleteComposition,
    duplicateComposition,
    addQuestion,
    removeItem,
    updateItemBlankPages,
    insertBlankPage,
    reorderItems,
    addQuestionsBatch,
    toggleAnswers,
    setAnswersPlacement,
    selectItem,
    markDirty,
    reset,
  }
})
