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
  const date = new Date().toISOString().slice(0, 10)
  // 自定义文字：支持任意文案（含中文）；{email}/{date} 按当前用户展开
  const custom = (c.text || '').trim()
  const base = c.mode === 'custom' && custom ? custom : '{email}'
  // 预设模式依赖邮箱；纯自定义文案（不含 {email}）无邮箱也可铺
  if (base === '{email}' && !email) return ''
  if (base.includes('{email}') && !email) return ''
  const text = base.replaceAll('{email}', email).replaceAll('{date}', date)
  if (!text.trim()) return ''
  // SVG 背景需系统 CJK 字体栈，否则中文自定义文字会缺字
  const font =
    "'PingFang SC','Microsoft YaHei','Noto Sans SC','SimHei',Arial,Helvetica,sans-serif"
  const size = text.length > 36 ? 11 : text.length > 22 ? 13 : 15
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="460" height="300">' +
    `<text x="230" y="150" transform="rotate(-24 230 150)" text-anchor="middle" ` +
    `font-family="${font}" font-size="${size}" ` +
    `fill="rgba(0,0,0,0.055)">${escapeXml(text)}</text></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
})
</script>

<template>
  <div v-if="bg" class="browse-wm" aria-hidden="true" :style="{ backgroundImage: bg }"></div>
</template>
