import { reactive } from 'vue'
import type { Session } from '@supabase/supabase-js'
import { getSupabase } from '@/lib/supabase'

export interface Profile {
  id: string
  email: string
  role: 'admin' | 'teacher'
  can_see_drafts: boolean
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
    .select('id,email,role,can_see_drafts')
    .eq('id', userId)
    .maybeSingle()
  state.profile = (data as Profile | null) ?? null
}

export function initAuth(): Promise<void> {
  if (initPromise) return initPromise
  const sb = getSupabase()
  initPromise = (async () => {
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
