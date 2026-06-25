/** Section definition (GET /section_defs) */
export interface SectionDef {
  id: number
  name: string
  content: string | null
  color: string | null
  group_id: number | null
  group_name: string | null
  updated_at: string
}

/** Section definition create payload */
export interface SectionDefCreateParams {
  name: string
  content?: string | null
  groupId?: number | null
}

/** Section definition update payload */
export interface SectionDefUpdateParams {
  name?: string
  content?: string | null
  groupId?: number | null
}

/** Section group (GET /section_groups) */
export interface SectionGroup {
  id: number
  name: string
  show_in_filter: boolean
  updated_at: string
}

/** Section group create payload */
export interface SectionGroupCreateParams {
  name: string
  showInFilter?: boolean
}

/** Section group update payload */
export interface SectionGroupUpdateParams {
  name?: string
  showInFilter?: boolean
}
