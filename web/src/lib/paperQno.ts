// 卷内题号（「该试卷的第几题」）：库端 RPC 计算，见 supabase/migrations/0010_paper_qno_map.sql
// 不能只按可见的题目自己排序——未校对题 / 按试卷、模块、单题授权的题目会被 RLS 挡掉，
// 那样算出来的序号会随账号变化。RPC 缺失或出错时返回空 Map，调用方回退到全局 question_no。
import { getSupabase } from '@/lib/supabase'

let warnedMissingMigration = false

export async function fetchPaperQnoMap(questionIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>()
  const ids = [...new Set(questionIds.filter((id) => Number.isFinite(id)))]
  if (!ids.length) return map
  try {
    const { data, error } = await getSupabase().rpc('paper_qno_map', { p_question_ids: ids })
    if (error) throw error
    for (const row of (data ?? []) as { question_id: number; paper_qno: number }[]) {
      const no = Number(row.paper_qno)
      if (Number.isFinite(no) && no > 0) map.set(Number(row.question_id), no)
    }
  } catch (e) {
    const code = (e as { code?: string })?.code
    if (code === 'PGRST202' || code === '42883') {
      if (!warnedMissingMigration) {
        warnedMissingMigration = true
        console.warn('[paper_qno] 迁移 0010 未执行，卷内题号回退为题库全局题号')
      }
    } else {
      console.warn('[paper_qno] 卷内题号查询失败，回退题库全局题号', e)
    }
  }
  return map
}
