import { reactive } from 'vue'
import type { Session } from '@supabase/supabase-js'
import { getSupabase, initSupabase } from '@/lib/supabase'

export interface Profile {
  id: string
  email: string
  role: 'admin' | 'teacher'
  can_see_drafts: boolean
  /** 停用标记（管理端「权限管理」；GoTrue ban 已拦登录，这里是旧会话兜底） */
  is_active: boolean
  /** 组卷存量上限（null = 不限；管理端「导出管控」配置） */
  max_compositions: number | null
  /** 导出次数·本周上限（周期制，防批量导出） */
  max_exports_per_week: number | null
  /** 导出次数·本月上限 */
  max_exports_per_month: number | null
  /** 单次导出题目数上限（题库导出与组卷导出同受此限） */
  max_export_items: number | null
}

interface AuthState {
  ready: boolean
  session: Session | null
  profile: Profile | null
}

const state = reactive<AuthState>({
  ready: false,
  session: null,
  profile: null,
})

let initPromise: Promise<void> | null = null

async function loadProfile(userId: string): Promise<void> {
  const { data } = await getSupabase()
    .from('profiles')
    .select(
      'id,email,role,can_see_drafts,is_active,max_compositions,max_exports_per_week,max_exports_per_month,max_export_items',
    )
    .eq('id', userId)
    .maybeSingle()
  state.profile = (data as Profile | null) ?? null
  // 已停用账号：立刻登出（正常情况下 GoTrue ban 已拦住，这里兜底旧会话）
  if (data && (data as Profile).is_active === false) {
    void getSupabase().auth.signOut()
  }
}

export function initAuth(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    await initSupabase()
    const sb = getSupabase()
    const { data } = await sb.auth.getSession()
    state.session = data.session
    if (data.session) await loadProfile(data.session.user.id)
    sb.auth.onAuthStateChange((_event, session) => {
      state.session = session
      if (session) {
        void loadProfile(session.user.id)
      } else {
        state.profile = null
      }
    })
    state.ready = true
  })()
  return initPromise
}

export async function signIn(email: string, password: string): Promise<string | null> {
  const { error } = await getSupabase().auth.signInWithPassword({ email, password })
  return error ? error.message : null
}

export async function signOut(): Promise<void> {
  await getSupabase().auth.signOut()
}

export function useAuth() {
  return state
}
