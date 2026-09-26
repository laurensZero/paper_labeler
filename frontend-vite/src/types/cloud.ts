/** 云端同步（标注端 → Supabase/R2） */

export interface CloudConfigInfo {
  enabled: boolean
  missing: string[]
  supabase_url: string
  r2_bucket: string
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
}

export interface CloudSyncStatus {
  running: boolean
  current: CloudSyncSummary | null
  last: CloudSyncSummary | null
}
