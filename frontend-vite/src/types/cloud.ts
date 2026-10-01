/** 云端同步（标注端 → Supabase/R2） */

export interface CloudConfigInfo {
  enabled: boolean
  missing: string[]
  supabase_url: string
  r2_bucket: string
  token_configured: boolean
  management_disabled: boolean
  /** 图形化配置表单回显（.env 键 → 当前值） */
  form: Record<string, string>
}

export interface CloudSyncSummary {
  ok: boolean
  phase: string
  started_at: string
  finished_at: string
  duration_s: number
  counts: Record<string, number>
  errors: string[]
  error_count: number
  resurrected: number[]
  progress_current?: number
  progress_total?: number
}

export interface CloudSyncStatus {
  running: boolean
  current: CloudSyncSummary | null
  last: CloudSyncSummary | null
  /** 磁盘落盘的上次结果（重启后回显用；后端已归一化 ok 字段） */
  disk_state: CloudSyncSummary | null
}
