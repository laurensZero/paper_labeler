import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? ''
const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? ''
const r2Base = ((import.meta.env.VITE_R2_PUBLIC_BASE as string | undefined) ?? '').replace(/\/+$/, '')

let _client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!_client) {
    if (!url || !anon) {
      throw new Error('缺少配置：请在 web/.env 填写 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY（参考 web/.env.example）')
    }
    _client = createClient(url, anon)
  }
  return _client
}

/** 题图公开读地址（R2 key → URL） */
export function imageUrl(key: string | null | undefined): string {
  if (!key || !r2Base) return ''
  return `${r2Base}/${key}`
}

export function hasImageConfig(): boolean {
  return !!r2Base
}
