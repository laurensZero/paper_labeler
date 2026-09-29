<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getSupabase } from '@/lib/supabase'
import { useAuth } from '@/composables/auth'

// 题库防盗：按管理端「导出管控 → 网页浏览水印」配置，登录后平铺每人专属水印
interface WmConfig {
  enabled: boolean
  mode: 'preset' | 'custom'
  text: string
}

const auth = useAuth()
const cfg = ref<WmConfig | null>(null)

onMounted(async () => {
  const { data } = await getSupabase()
    .from('app_config')
    .select('value')
    .eq('key', 'export')
    .maybeSingle()
  cfg.value = (data?.value?.browse_watermark as WmConfig | undefined) ?? null
})

function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c,
  )
}

const bg = computed(() => {
  // 管理员不铺水印
  if (auth.profile?.role === 'admin') return ''
  const c = cfg.value
  if (!c?.enabled) return ''
  const email = auth.profile?.email || auth.session?.user.email || ''
  if (!email) return ''
  const date = new Date().toISOString().slice(0, 10)
  const base = c.mode === 'custom' && c.text ? c.text : '{email}'
  const text = base.replaceAll('{email}', email).replaceAll('{date}', date)
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="460" height="300">' +
    `<text x="230" y="150" transform="rotate(-24 230 150)" text-anchor="middle" ` +
    'font-family="Arial, Helvetica, sans-serif" font-size="15" ' +
    `fill="rgba(0,0,0,0.055)">${escapeXml(text)}</text></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
})
</script>

<template>
  <div v-if="bg" class="browse-wm" aria-hidden="true" :style="{ backgroundImage: bg }"></div>
</template>
