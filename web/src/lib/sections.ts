// 大分类(section_groups) → 小分类(section_defs) 关系构建，逻辑与管理端 sections.ts 对齐。
import { getSupabase } from '@/lib/supabase'

export interface CascadeGroup {
  label: string
  options: { value: string; label: string }[]
}

export interface CascadeLabels {
  /** 第一个特殊分组的标题，如「模块」 */
  moduleGroup: string
  /** 全部模块选项 */
  allModules: string
  /** 未分类筛选值（__UNSET__） */
  unsectioned: string
  /** 未分组小分类的分组标题，如「(未分类)」 */
  ungrouped: string
}

export interface SectionsGraph {
  sectionNames: string[]
  groups: { id: number; name: string }[]
  members: { group_id: number; section_name: string }[]
}

export const UNSET_SECTION = '__UNSET__'

export async function fetchSectionsGraph(): Promise<SectionsGraph> {
  const sb = getSupabase()
  const [defs, groups, members] = await Promise.all([
    sb.from('section_defs').select('name').order('name'),
    sb.from('section_groups').select('id,name').order('id'),
    sb.from('section_group_members').select('group_id,section_name'),
  ])
  if (defs.error) throw new Error(defs.error.message)
  if (groups.error) throw new Error(groups.error.message)
  if (members.error) throw new Error(members.error.message)
  return {
    sectionNames: (defs.data ?? []).map((d) => d.name as string),
    groups: (groups.data ?? []) as { id: number; name: string }[],
    members: (members.data ?? []) as { group_id: number; section_name: string }[],
  }
}

/**
 * 构建级联选项：[模块(全部/未分类)] + [(未分类)分组] + 各大类分组。
 * 小分类显示名带大类前缀（与管理端 labelMap 规则一致）。
 */
export function buildCascadeOptions(
  graph: SectionsGraph,
  labels: CascadeLabels,
): { options: CascadeGroup[]; labelMap: Record<string, string> } {
  const labelMap: Record<string, string> = {}
  const groupById = new Map(graph.groups.map((g) => [g.id, g]))
  const memberGroupOf = new Map(graph.members.map((m) => [m.section_name, m.group_id]))

  const ungrouped: string[] = []
  const byGroup = new Map<number, string[]>()
  for (const g of graph.groups) byGroup.set(g.id, [])

  for (const name of graph.sectionNames) {
    const gid = memberGroupOf.get(name)
    const g = gid != null ? groupById.get(gid) : null
    if (g) {
      labelMap[name] = name.startsWith(`${g.name}_`) ? name : `${g.name}_${name}`
      byGroup.get(g.id)?.push(name)
    } else {
      labelMap[name] = name
      ungrouped.push(name)
    }
  }

  const options: CascadeGroup[] = [
    {
      label: labels.moduleGroup,
      options: [
        { value: '', label: labels.allModules },
        { value: UNSET_SECTION, label: labels.unsectioned },
      ],
    },
  ]
  if (ungrouped.length) {
    options.push({
      label: labels.ungrouped,
      options: ungrouped.map((n) => ({ value: n, label: labelMap[n] || n })),
    })
  }
  for (const g of graph.groups) {
    const names = byGroup.get(g.id) ?? []
    if (!names.length) continue
    options.push({
      label: g.name,
      options: names.map((n) => ({ value: n, label: labelMap[n] || n })),
    })
  }

  return { options, labelMap }
}
