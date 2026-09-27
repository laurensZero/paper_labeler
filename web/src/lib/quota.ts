// 组卷/导出限额（上限存 profiles，管理端「导出管控」配置；null = 不限）。
// - 组卷：存量上限，创建/复制时检查（数据库触发器兜底）
// - 导出：按本周/本月窗口计数（防批量偷题库），失败的导出不计
// - 单次导出题数：题库导出与组卷导出同受此限（纯前端生成，只能在导出前检查）
import { getSupabase } from '@/lib/supabase'
import { useAuth } from '@/composables/auth'

function uid(): string | null {
  return useAuth().session?.user.id ?? null
}

/** UTC 周一 00:00 与本月1日（与后端/PG date_trunc('week'/'month') 对齐） */
function periodStarts(): { week: Date; month: Date } {
  const now = new Date()
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const week = new Date(dayStart)
  week.setUTCDate(dayStart.getUTCDate() - ((dayStart.getUTCDay() + 6) % 7))
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  return { week, month }
}

/** 剩余组卷名额用尽时返回 'comp'；查不到计数时放行（数据库触发器兜底） */
export async function checkCompositionQuota(): Promise<'comp' | null> {
  const auth = useAuth()
  const max = auth.profile?.max_compositions
  const user = uid()
  if (max == null || !user) return null
  const { count, error } = await getSupabase()
    .from('compositions')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', user)
  if (error) return null
  return (count ?? 0) >= max ? 'comp' : null
}

/** 本周/本月导出名额用尽时返回 'export_week' | 'export_month'，否则 null */
export async function checkExportQuota(): Promise<'export_week' | 'export_month' | null> {
  const auth = useAuth()
  const user = uid()
  if (!user) return null
  const maxWeek = auth.profile?.max_exports_per_week
  const maxMonth = auth.profile?.max_exports_per_month
  if (maxWeek == null && maxMonth == null) return null

  const { week, month } = periodStarts()
  const base = () =>
    getSupabase()
      .from('export_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('requested_by', user)
      .neq('status', 'failed')

  if (maxWeek != null) {
    const { count, error } = await base().gte('created_at', week.toISOString())
    if (!error && (count ?? 0) >= maxWeek) return 'export_week'
  }
  if (maxMonth != null) {
    const { count, error } = await base().gte('created_at', month.toISOString())
    if (!error && (count ?? 0) >= maxMonth) return 'export_month'
  }
  return null
}

/** 超出单次导出题数上限时返回上限值，否则 null（n = 本次导出的题目数，不含空白页） */
export function checkExportItemCount(n: number): { max: number } | null {
  const max = useAuth().profile?.max_export_items
  if (max == null) return null
  return n > max ? { max } : null
}

/** 导出成功后记一次（周期计数与数据库兜底）；失败静默，不影响已下载的 PDF */
export async function recordExport(opts: {
  compositionId?: string | null
  includeAnswers: boolean
  source: 'compose' | 'bank' | 'random'
}): Promise<void> {
  const user = uid()
  if (!user) return
  // PostgREST 错误走返回值不抛异常；计数失败不阻断已下载的导出
  await getSupabase().from('export_jobs').insert({
    composition_id: opts.compositionId ?? null,
    requested_by: user,
    include_answers: opts.includeAnswers,
    status: 'done',
    options: { source: opts.source },
  })
}

/** 数据库触发器报错（quota_exceeded:*）→ i18n key；非限额错误返回 null */
export function quotaErrorKey(e: unknown): string | null {
  let msg: string
  if (e instanceof Error) msg = e.message
  else if (e && typeof e === 'object' && 'message' in e) msg = String((e as { message: unknown }).message)
  else msg = String(e ?? '')
  if (msg.includes('quota_exceeded:compositions')) return 'quota.compReached'
  if (msg.includes('quota_exceeded:exports_week')) return 'quota.exportWeekReached'
  if (msg.includes('quota_exceeded:exports_month')) return 'quota.exportMonthReached'
  if (msg.includes('quota_exceeded:exports')) return 'quota.exportWeekReached'
  return null
}
