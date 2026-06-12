import { ref } from 'vue'
import { defineStore } from 'pinia'
import { useAppStore } from './app'
import { useDialogStore } from './dialog'
import { i18n } from '@/i18n'
import { api } from '@/api/client'

export interface SectionDef {
  id: number
  name: string
  content: string | null
  group_id: number | null
  __lastSavedName?: string
  __lastSavedGroupId?: number | null
  __lastSavedContent?: string
}

export interface SectionGroup {
  id: number
  name: string
  show_in_filter: boolean
  __lastSavedName?: string
  __lastSavedShow?: boolean
}

export interface SectionOptionGroup {
  label: string
  options: string[]
}

export const useSectionsStore = defineStore('sections', () => {
  // --- state ---
  const sectionDefs = ref<SectionDef[]>([])
  const sectionNames = ref<string[]>([])
  const sectionNamesFilter = ref<string[]>([])
  const sectionNamesMark = ref<string[]>([])
  const sectionGroups = ref<SectionGroup[]>([])
  const sectionOptionGroupsAll = ref<SectionOptionGroup[]>([])
  const sectionOptionGroupsVisible = ref<SectionOptionGroup[]>([])
  const sectionLabelMap = ref<Record<string, string>>({})
  const sectionMultiSelect = ref(false)
  const selectedSectionDefIds = ref<Set<number>>(new Set())
  const sectionBatchGroupId = ref<number | null>(null)

  // --- editor inputs ---
  const newSectionName = ref('')
  const newSectionGroupName = ref('')
  const newSectionGroupId = ref<number | null>(null)

  // --- actions ---
  async function refreshSectionDefs() {
    try {
      const [d, g] = await Promise.all([
        api('/section_defs'),
        api('/section_groups').catch(() => ({ groups: [] })),
      ])
      const defs: SectionDef[] = (d.sections || [])
        .slice()
        .sort((a: SectionDef, b: SectionDef) => (b?.id || 0) - (a?.id || 0))
        .map((s: SectionDef) => ({
          ...s,
          group_id: s?.group_id != null ? Number(s.group_id) : null,
          __lastSavedName: s?.name ?? '',
          __lastSavedGroupId: s?.group_id != null ? Number(s.group_id) : null,
          __lastSavedContent: s?.content ?? '',
        }))
      sectionDefs.value = defs

      sectionGroups.value = (g.groups || [])
        .slice()
        .sort((a: SectionGroup, b: SectionGroup) => (Number(b?.id) || 0) - (Number(a?.id) || 0))
        .map((gr: SectionGroup) => ({
          ...gr,
          id: gr?.id != null ? Number(gr.id) : gr?.id,
          __lastSavedName: gr?.name ?? '',
          __lastSavedShow: gr?.show_in_filter !== false,
        }))
    } catch {
      sectionDefs.value = []
      sectionGroups.value = []
    }

    let names = sectionDefs.value.map((s) => s.name).filter(Boolean)
    if (!names.length) {
      try {
        const d2 = await api('/sections')
        names = (d2.sections || []).filter(Boolean)
      } catch {
        names = []
      }
    }
    const allNames = Array.from(new Set(names))
    sectionNames.value = allNames

    const groupById = new Map(sectionGroups.value.map((g) => [g.id, g]))
    const groupVisibleById = new Map(
      sectionGroups.value.map((g) => [g.id, g.show_in_filter !== false])
    )

    const visibleNames: string[] = []
    const ungrouped: string[] = []
    const optionsByGroup = new Map<number, string[]>(
      sectionGroups.value.map((g) => [g.id, [] as string[]])
    )
    const labelMap: Record<string, string> = {}

    for (const s of sectionDefs.value) {
      const name = s?.name
      if (!name) continue
      const gid = s.group_id
      const gr = gid ? groupById.get(gid) : null
      if (gr?.name) {
        const prefix = `${gr.name}_`
        labelMap[name] = name.startsWith(prefix) ? name : `${gr.name}_${name}`
      } else {
        labelMap[name] = name
      }
      if (gid && optionsByGroup.has(gid)) {
        optionsByGroup.get(gid)!.push(name)
      } else {
        ungrouped.push(name)
      }
      if (!gid || groupVisibleById.get(gid) !== false) {
        visibleNames.push(name)
      }
    }

    const groupsAll: SectionOptionGroup[] = []
    if (ungrouped.length) groupsAll.push({ label: '(未分类)', options: ungrouped })
    for (const gr of sectionGroups.value) {
      const opts = optionsByGroup.get(gr.id) || []
      if (opts.length) groupsAll.push({ label: gr.name, options: opts })
    }
    const groupsVisible: SectionOptionGroup[] = []
    if (ungrouped.length) groupsVisible.push({ label: '(未分类)', options: ungrouped })
    for (const gr of sectionGroups.value) {
      if (gr.show_in_filter === false) continue
      const opts = optionsByGroup.get(gr.id) || []
      if (opts.length) groupsVisible.push({ label: gr.name, options: opts })
    }

    const visibleFinal = sectionDefs.value.length ? Array.from(new Set(visibleNames)) : allNames
    sectionNamesFilter.value = allNames
    sectionNamesMark.value = visibleFinal
    sectionOptionGroupsAll.value = groupsAll.length
      ? groupsAll
      : (allNames.length ? [{ label: '(全部)', options: allNames }] : [])
    sectionOptionGroupsVisible.value = groupsVisible.length
      ? groupsVisible
      : (visibleFinal.length ? [{ label: '(全部)', options: visibleFinal }] : [])
    if (!Object.keys(labelMap).length && allNames.length) {
      allNames.forEach((n) => { labelMap[n] = n })
    }
    sectionLabelMap.value = labelMap
  }

  async function createSectionDef(name: string, content = '', groupId: number | null = null) {
    const appStore = useAppStore()
    if (!name) return
    try {
      appStore.setStatus('添加模块中...')
      await api('/section_defs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content, group_id: groupId }),
      })
      appStore.setStatus('已添加', 'ok')
      newSectionName.value = ''
      newSectionGroupId.value = null
      await refreshSectionDefs()
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  async function updateSectionDef(s: SectionDef) {
    const appStore = useAppStore()
    try {
      appStore.setStatus(`保存模块 ${s.name} 中...`)
      const gid = s.group_id != null ? Number(s.group_id) : null
      const resp = await api(`/section_defs/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: s.name, content: s.content, group_id: gid }),
      })
      const updatedCount = Number(resp?.updated_questions ?? resp?.renamed_count ?? resp?.renamedCount ?? 0)
      if (Number.isFinite(updatedCount) && updatedCount > 0) {
        appStore.setStatus(`已保存（同步更新 ${updatedCount} 题）`, 'ok')
      } else {
        appStore.setStatus('已保存', 'ok')
      }
      await refreshSectionDefs()
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  async function deleteSectionDef(s: SectionDef) {
    const appStore = useAppStore()
    const t = i18n.global.t
    if (!await useDialogStore().confirm(t('sectionEditor.deleteSectionConfirm', { name: s.name }), {
      title: t('sectionEditor.deleteSectionTitle'),
      confirmText: t('dialog.delete'),
      danger: true,
    })) return
    try {
      appStore.setStatus(`删除模块 ${s.name} 中...`)
      await api(`/section_defs/${s.id}`, { method: 'DELETE' })
      appStore.setStatus('已删除', 'ok')
      await refreshSectionDefs()
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  async function createSectionGroup(name: string) {
    const appStore = useAppStore()
    if (!name) return
    try {
      appStore.setStatus('添加分类中...')
      await api('/section_groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, show_in_filter: true }),
      })
      appStore.setStatus('已添加', 'ok')
      newSectionGroupName.value = ''
      await refreshSectionDefs()
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  async function updateSectionGroup(g: SectionGroup) {
    const appStore = useAppStore()
    try {
      appStore.setStatus(`保存分类 ${g.name} 中...`)
      await api(`/section_groups/${g.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: g.name, show_in_filter: g.show_in_filter }),
      })
      appStore.setStatus('分类已保存', 'ok')
      await refreshSectionDefs()
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  async function deleteSectionGroup(g: SectionGroup) {
    const appStore = useAppStore()
    const t = i18n.global.t
    if (!await useDialogStore().confirm(t('sectionEditor.deleteGroupConfirm', { name: g.name }), {
      title: t('sectionEditor.deleteGroupTitle'),
      confirmText: t('dialog.delete'),
      danger: true,
    })) return
    try {
      appStore.setStatus(`删除分类 ${g.name} 中...`)
      await api(`/section_groups/${g.id}`, { method: 'DELETE' })
      appStore.setStatus('分类已删除', 'ok')
      await refreshSectionDefs()
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  function toggleSectionMultiSelect() {
    sectionMultiSelect.value = !sectionMultiSelect.value
    if (!sectionMultiSelect.value) selectedSectionDefIds.value = new Set()
  }

  function toggleSectionSelection(id: number, checked: boolean) {
    const next = new Set(selectedSectionDefIds.value)
    if (checked) next.add(id)
    else next.delete(id)
    selectedSectionDefIds.value = next
  }

  function selectAllSectionDefs() {
    selectedSectionDefIds.value = new Set(sectionDefs.value.map((s) => s.id))
  }

  function clearSectionSelection() {
    selectedSectionDefIds.value = new Set()
  }

  async function applyBatchSectionGroup() {
    const ids = Array.from(selectedSectionDefIds.value)
    const appStore = useAppStore()
    if (!ids.length) {
      appStore.setStatus('未选择模块', 'err')
      return
    }
    try {
      appStore.setStatus(`批量归类中（${ids.length} 个）`)
      const gid = sectionBatchGroupId.value != null
        ? Number(sectionBatchGroupId.value)
        : null
      for (const id of ids) {
        await api(`/section_defs/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group_id: gid }),
        })
      }
      appStore.setStatus('批量归类完成', 'ok')
      await refreshSectionDefs()
      clearSectionSelection()
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  async function deleteSelectedSectionDefs() {
    const ids = Array.from(selectedSectionDefIds.value)
    const appStore = useAppStore()
    if (!ids.length) {
      appStore.setStatus('未选择模块', 'err')
      return
    }
    const t = i18n.global.t
    if (!await useDialogStore().confirm(t('sectionEditor.deleteSelectedConfirm', { count: ids.length }), {
      title: t('sectionEditor.deleteSelectedTitle'),
      confirmText: t('dialog.delete'),
      danger: true,
    })) return
    try {
      appStore.setStatus(`批量删除模块中（${ids.length} 个）`)
      for (const id of ids) {
        await api(`/section_defs/${id}`, { method: 'DELETE' })
      }
      appStore.setStatus('已删除', 'ok')
      await refreshSectionDefs()
      clearSectionSelection()
    } catch (e) {
      appStore.setStatus(String(e), 'err')
    }
  }

  function sectionDisplayName(name: string): string {
    if (!name) return ''
    return sectionLabelMap.value?.[name] || name
  }

  return {
    // state
    sectionDefs,
    sectionNames,
    sectionNamesFilter,
    sectionNamesMark,
    sectionGroups,
    sectionOptionGroupsAll,
    sectionOptionGroupsVisible,
    sectionLabelMap,
    sectionMultiSelect,
    selectedSectionDefIds,
    sectionBatchGroupId,
    newSectionName,
    newSectionGroupName,
    newSectionGroupId,
    // actions
    refreshSectionDefs,
    createSectionDef,
    updateSectionDef,
    deleteSectionDef,
    createSectionGroup,
    updateSectionGroup,
    deleteSectionGroup,
    toggleSectionMultiSelect,
    toggleSectionSelection,
    selectAllSectionDefs,
    clearSectionSelection,
    applyBatchSectionGroup,
    deleteSelectedSectionDefs,
    sectionDisplayName,
  }
})
