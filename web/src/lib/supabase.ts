import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? ''
const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? ''
const proxyUrl = ((import.meta.env.VITE_SUPABASE_PROXY_URL as string | undefined) ?? '').trim().replace(/\/+$/, '')
const r2Base = ((import.meta.env.VITE_R2_PUBLIC_BASE as string | undefined) ?? '').replace(/\/+$/, '')

/** 固定 storageKey：直连/反代切换时会话不丢（否则 projectRef 变了会掉登录） */
const AUTH_STORAGE_KEY = 'sb-paperlabeler-auth-token'
const LAST_BASE_KEY = 'pl_sb_base_url'

let _client: SupabaseClient | null = null
let _clientBase = ''
let _initPromise: Promise<SupabaseClient> | null = null

function normalizeBase(v: string): string {
  return v.replace(/\/+$/, '')
}

function primaryBase(): string {
  return normalizeBase(url)
}

function candidates(): string[] {
  const list: string[] = []
  const push = (v: string | undefined) => {
    const b = v ? normalizeBase(v) : ''
    if (b && !list.includes(b)) list.push(b)
  }
  try {
    push(localStorage.getItem(LAST_BASE_KEY) || '')
  } catch {
    /* 私隐模式忽略 */
  }
  push(primaryBase())
  push(proxyUrl)
  return list
}

function rememberBase(base: string): void {
  try {
    localStorage.setItem(LAST_BASE_KEY, base)
  } catch {
    /* ignore */
  }
}

/** 探活：GET {base}/auth/v1/health，超时/网络错视为不通 */
export async function probeSupabase(base: string, timeoutMs = 2500): Promise<boolean> {
  const target = `${normalizeBase(base)}/auth/v1/health`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(target, {
      method: 'GET',
      cache: 'no-store',
      signal: ctrl.signal,
      headers: anon ? { apikey: anon } : undefined,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function createClientAt(base: string): SupabaseClient {
  return createClient(base, anon, {
    auth: {
      storageKey: AUTH_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
}

/**
 * 探活并初始化客户端。顺序：上次成功 → 直连主地址 → CF 反代。
 * 需在任何 getSupabase() 业务调用前 await（initAuth 已接）。
 */
export function initSupabase(): Promise<SupabaseClient> {
  if (_client) return Promise.resolve(_client)
  if (_initPromise) return _initPromise
  if (!url || !anon) {
    return Promise.reject(
      new Error('缺少配置：请在 web/.env 填写 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY（参考 web/.env.example）'),
    )
  }
  _initPromise = (async () => {
    const list = candidates()
    let chosen = list[0] || primaryBase()
    for (const base of list) {
      if (await probeSupabase(base)) {
        chosen = base
        break
      }
    }
    if (!_client || _clientBase !== chosen) {
      _client = createClientAt(chosen)
      _clientBase = chosen
    }
    rememberBase(chosen)
    return _client
  })()
  return _initPromise
}

/** 同步取客户端；未 init 时用首选地址兜底创建（路由层已保证先 init） */
export function getSupabase(): SupabaseClient {
  if (!_client) {
    if (!url || !anon) {
      throw new Error('缺少配置：请在 web/.env 填写 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY（参考 web/.env.example）')
    }
    const base = candidates()[0] || primaryBase()
    _client = createClientAt(base)
    _clientBase = base
  }
  return _client
}

/** 当前生效的 Supabase 基址（调试/日志用） */
export function currentSupabaseBase(): string {
  return _clientBase || primaryBase()
}

/** 题图公开读地址（R2 key → URL） */
export function imageUrl(key: string | null | undefined): string {
  if (!key || !r2Base) return ''
  return `${r2Base}/${key}`
}

export function hasImageConfig(): boolean {
  return !!r2Base
}
