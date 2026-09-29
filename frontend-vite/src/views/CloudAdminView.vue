<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import { cloudAuthHeaders } from '@/api/endpoints'
import { useSectionsStore } from '@/stores/sections'
import { usePapersStore } from '@/stores/papers'
import { useFilterStore } from '@/stores/filter'
import SectionCascadeSelect from '@/components/ui/SectionCascadeSelect.vue'

defineOptions({ name: 'CloudAdminView' })

const { t } = useI18n()
const router = useRouter()
const sectionsStore = useSectionsStore()
const papersStore = usePapersStore()
const filterStore = useFilterStore()

const tab = ref<'feedback' | 'perm' | 'comps' | 'guard'>('feedback')
const error = ref('')

function errText(e: unknown): string {
  if (e && typeof e === 'object' && 'body' in e) {
    try {
      const body = JSON.parse(String((e as { body: string }).body))
      if (body?.detail) return String(body.detail)
    } catch {
      /* fallthrough */
    }
    return String((e as { body?: string }).body || e)
  }
  return e instanceof Error ? e.message : String(e)
}

function one<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null
  return Array.isArray(x) ? (x[0] ?? null) : x
}

// ---------------------------------------------------------------------------
// 反馈处理
// ---------------------------------------------------------------------------
interface FeedbackRow {
  id: number
  body: string
  status: string
  created_at: string
  question_id: number
  user_id: string | null
  profiles: { email: string } | { email: string }[] | null
  questions: {
    question_no: string | null
    paper_id: number | null
    papers: { exam_code: string | null } | { exam_code: string | null }[] | null
  } | null
}

const fbRows = ref<FeedbackRow[]>([])
const fbLoading = ref(false)
const fbBusyId = ref<number | null>(null)

async function loadFeedback() {
  fbLoading.value = true
  error.value = ''
  try {
    fbRows.value = (await api('/cloud/suggestions')) as FeedbackRow[]
  } catch (e) {
    error.value = errText(e)
    fbRows.value = []
  } finally {
    fbLoading.value = false
  }
}

async function setSuggestionStatus(row: FeedbackRow, status: string) {
  fbBusyId.value = row.id
  error.value = ''
  try {
    await api(`/cloud/suggestions/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...cloudAuthHeaders() },
      body: JSON.stringify({ status }),
    })
    row.status = status
  } catch (e) {
    error.value = errText(e)
  } finally {
    fbBusyId.value = null
  }
}

async function deleteSuggestion(row: FeedbackRow) {
  if (!window.confirm(t('cloud.fbDeleteConfirm'))) return
  fbBusyId.value = row.id
  error.value = ''
  try {
    await api(`/cloud/suggestions/${row.id}`, {
      method: 'DELETE',
      headers: cloudAuthHeaders(),
    })
    fbRows.value = fbRows.value.filter((r) => r.id !== row.id)
  } catch (e: any) {
    if (e?.status === 405) {
      error.value = t('cloud.fbDeleteNeedRestart')
    } else {
      error.value = errText(e)
    }
  } finally {
    fbBusyId.value = null
  }
}

async function resolvePaperId(row: FeedbackRow): Promise<number | null> {
  const q = one(row.questions)
  const fromJoin = Number(q?.paper_id)
  if (Number.isFinite(fromJoin) && fromJoin > 0) return fromJoin
  // Cloud embed may omit paper_id — ask the local labeling API.
  if (row.question_id) {
    try {
      const detail = (await api(`/questions/${row.question_id}`)) as {
        question?: { paper_id?: number }
        paper_id?: number
      }
      const pid = Number(detail?.question?.paper_id ?? detail?.paper_id)
      if (Number.isFinite(pid) && pid > 0) return pid
    } catch {
      /* fall through */
    }
  }
  // Last resort: match local paper by exam_code shown in the label.
  try {
    const code = String(fbQLabel(row).split('·').pop() || '').trim()
    if (code) {
      await papersStore.refreshPapers({ silent: true })
      const hit = papersStore.papers.find(
        (p) => (papersStore.formatPaperName(p) || p.filename || '').includes(code) || p.exam_code === code,
      )
      if (hit?.id) return Number(hit.id)
    }
  } catch {
    /* ignore */
  }
  return null
}

async function locateQuestion(row: FeedbackRow) {
  error.value = ''
  const paperId = await resolvePaperId(row)
  if (!paperId) {
    error.value = t('cloud.fbLocateMissing')
    return
  }
  filterStore.filterSearchKeyword = String(one(row.questions)?.question_no ?? row.question_id)
  filterStore.filterReturnQid = row.question_id
  await router.push({ name: 'mark', params: { paperId: String(paperId) } })
}

function fbQLabel(row: FeedbackRow): string {
  const q = one(row.questions)
  const paper = q ? one(q.papers) : null
  const no = q?.question_no ?? row.question_id
  return paper?.exam_code ? `#${no} · ${paper.exam_code}` : `#${no}`
}

function fbUser(row: FeedbackRow): string {
  return one(row.profiles)?.email ?? '—'
}

function fmtTime(ts: string): string {
  return ts ? ts.replace('T', ' ').slice(0, 16) : ''
}

function statusTag(status: string): string {
  if (status === 'accepted') return 'tag-ok'
  if (status === 'rejected') return 'tag-plain'
  return 'tag-warn'
}

// ---------------------------------------------------------------------------
// 权限管理（停用 = profiles.is_active 打标 + 后端 GoTrue ban 禁止登录）
// ---------------------------------------------------------------------------
interface ProfileRow {
  id: string
  email: string
  role: 'admin' | 'teacher'
  can_see_drafts: boolean
  is_active: boolean
  created_at: string
  max_compositions: number | null
  max_exports_per_week: number | null
  max_exports_per_month: number | null
  max_export_items: number | null
  composition_count: number
  export_count_week: number
  export_count_month: number
}

interface GrantRow {
  id: number
  user_id: string
  scope: 'section' | 'section_group' | 'paper' | 'question'
  scope_value: string
}

const profiles = ref<ProfileRow[]>([])
const permLoading = ref(false)
const selectedUserId = ref<string | null>(null)
const grants = ref<GrantRow[]>([])
const grantsLoading = ref(false)
const grantValue = ref('')
const grantPaperValue = ref('')
const busyUserId = ref<string | null>(null)

const newEmail = ref('')
const newRole = ref<'teacher' | 'admin'>('teacher')
const newSeeDrafts = ref(false)
const creatingUser = ref(false)
const inviteResult = ref('')

function onEmailInput(e: Event) {
  newEmail.value = (e.target as HTMLInputElement)?.value ?? ''
}

// 与筛选页同构：大类可整组授权，小类单独授权
const grantCascadeOptions = computed(() => {
  const groups: { label: string; options: { value: string; label: string }[] }[] = []
  for (const group of sectionsStore.sectionOptionGroupsAll) {
    const options: { value: string; label: string }[] = [
      { value: `group:${group.label}`, label: `【大类】${group.label}` },
    ]
    for (const name of group.options) {
      options.push({
        value: `section:${name}`,
        label: sectionsStore.sectionLabelMap[name] || name,
      })
    }
    groups.push({ label: group.label, options })
  }
  return groups
})

const paperCascadeOptions = computed(() => [
  {
    label: t('cloud.permScopePaper'),
    options: papersStore.papers.map((p) => ({
      value: `paper:${p.id}`,
      label: papersStore.formatPaperName(p) || `#${p.id}`,
    })),
  },
])

const selectedProfile = computed(() => profiles.value.find((p) => p.id === selectedUserId.value) ?? null)

function decodeGrantValue(raw: string): { scope: 'section' | 'section_group' | 'paper'; value: string } | null {
  if (raw.startsWith('group:')) return { scope: 'section_group', value: raw.slice(6) }
  if (raw.startsWith('section:')) return { scope: 'section', value: raw.slice(8) }
  if (raw.startsWith('paper:')) return { scope: 'paper', value: raw.slice(6) }
  return null
}

async function loadProfiles() {
  permLoading.value = true
  error.value = ''
  try {
    profiles.value = (await api('/cloud/profiles')) as ProfileRow[]
  } catch (e) {
    error.value = errText(e)
    profiles.value = []
  } finally {
    permLoading.value = false
  }
}

async function createUser() {
  const email = newEmail.value.trim()
  if (!email || !email.includes('@')) {
    error.value = t('cloud.userInvalid')
    return
  }
  creatingUser.value = true
  error.value = ''
  inviteResult.value = ''
  try {
    const res = (await api('/cloud/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cloudAuthHeaders() },
      body: JSON.stringify({
        email,
        role: newRole.value,
        can_see_drafts: newSeeDrafts.value,
      }),
    })) as { invited?: boolean; invite_url?: string | null }
    newEmail.value = ''
    newRole.value = 'teacher'
    newSeeDrafts.value = false
    if (res?.invite_url) {
      inviteResult.value = t('cloud.userInviteLink', { url: res.invite_url })
    } else {
      inviteResult.value = t('cloud.userInviteSent', { email })
    }
    await loadProfiles()
  } catch (e) {
    error.value = errText(e)
  } finally {
    creatingUser.value = false
  }
}

async function selectUser(id: string) {
  selectedUserId.value = id
  grantValue.value = ''
  grantPaperValue.value = ''
  grantsLoading.value = true
  error.value = ''
  try {
    grants.value = (await api(`/cloud/grants?user_id=${encodeURIComponent(id)}`)) as GrantRow[]
  } catch (e) {
    error.value = errText(e)
    grants.value = []
  } finally {
    grantsLoading.value = false
  }
}

async function patchProfile(p: ProfileRow, body: Record<string, unknown>) {
  busyUserId.value = p.id
  error.value = ''
  try {
    await api(`/cloud/profiles/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...cloudAuthHeaders() },
      body: JSON.stringify(body),
    })
    Object.assign(p, body)
  } catch (e) {
    error.value = errText(e)
  } finally {
    busyUserId.value = null
  }
}

function scopeLabel(scope: string): string {
  if (scope === 'section') return t('cloud.permScopeSection')
  if (scope === 'section_group') return t('cloud.permScopeGroup')
  if (scope === 'paper') return t('cloud.permScopePaper')
  return 'question'
}

async function toggleActive(p: ProfileRow) {
  const next = !p.is_active
  if (!next && !window.confirm(t('cloud.permDisableConfirm', { email: p.email }))) return
  await patchProfile(p, { is_active: next })
}

async function addGrant() {
  if (!selectedUserId.value) return
  const raw = grantValue.value || grantPaperValue.value
  if (!raw) return
  const decoded = decodeGrantValue(raw)
  if (!decoded) {
    error.value = t('cloud.permValue')
    return
  }
  error.value = ''
  try {
    await api('/cloud/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cloudAuthHeaders() },
      body: JSON.stringify({
        user_id: selectedUserId.value,
        scope: decoded.scope,
        scope_value: decoded.value,
      }),
    })
    grantValue.value = ''
    grantPaperValue.value = ''
    await selectUser(selectedUserId.value)
  } catch (e) {
    error.value = errText(e)
  }
}

async function removeGrant(id: number) {
  error.value = ''
  try {
    await api(`/cloud/grants/${id}`, { method: 'DELETE', headers: cloudAuthHeaders() })
    grants.value = grants.value.filter((g) => g.id !== id)
  } catch (e) {
    error.value = errText(e)
  }
}

function displayGrantValue(g: GrantRow): string {
  if (g.scope === 'paper') {
    const hit = papersStore.papers.find((p) => String(p.id) === String(g.scope_value))
    return hit ? papersStore.formatPaperName(hit) || `#${hit.id}` : g.scope_value
  }
  return sectionsStore.sectionLabelMap[g.scope_value] || g.scope_value
}

// ---------------------------------------------------------------------------
// 组卷查看（全部用户的组卷 + 题目明细）
// ---------------------------------------------------------------------------
interface CompRow {
  id: string
  name: string
  title: string | null
  visibility: string
  created_at: string
  updated_at: string
  owner_id: string
  owner_email: string
  item_count: number
}

interface CompItem {
  id: number
  question_id: number | null
  sort_order: number
  item_type: string
  blank_pages: number
  score: number | null
  question_no: string | null
  section: string | null
  exam_code: string | null
}

const compRows = ref<CompRow[]>([])
const compLoading = ref(false)
const compFilter = ref('')
const compsLoaded = ref(false)
const expandedComp = ref<string | null>(null)
const compDetail = ref<CompItem[]>([])
const compDetailLoading = ref(false)

async function loadCompositions() {
  compLoading.value = true
  error.value = ''
  try {
    compRows.value = (await api('/cloud/compositions')) as CompRow[]
  } catch (e) {
    error.value = errText(e)
    compRows.value = []
  } finally {
    compLoading.value = false
  }
}

const filteredComps = computed(() =>
  compFilter.value ? compRows.value.filter((r) => r.owner_id === compFilter.value) : compRows.value,
)

async function toggleComp(id: string) {
  if (expandedComp.value === id) {
    expandedComp.value = null
    return
  }
  expandedComp.value = id
  compDetail.value = []
  compDetailLoading.value = true
  error.value = ''
  try {
    compDetail.value = (await api(`/cloud/compositions/${id}`)) as CompItem[]
  } catch (e) {
    error.value = errText(e)
    compDetail.value = []
  } finally {
    compDetailLoading.value = false
  }
}

function compItemLabel(it: CompItem): string {
  if (it.item_type === 'blank_page') return t('cloud.compBlank', { n: it.blank_pages || 1 })
  const parts = [`#${it.question_no || t('cloud.compNoQno')}`]
  if (it.exam_code) parts.push(it.exam_code)
  if (it.section) parts.push(it.section)
  const label = parts.join(' · ')
  return it.score != null ? `${label}（${it.score} 分）` : label
}

function compItemMeta(it: CompItem): string {
  const parts: string[] = []
  if (it.exam_code) parts.push(it.exam_code)
  if (it.section) parts.push(it.section)
  const label = parts.join(' · ') || t('cloud.compNoQno')
  return it.score != null ? `${label} · ${it.score}` : label
}

// ---- 云卷下载：后端本地渲染带水印 PDF（需管理 token）----
const compExporting = ref<string | null>(null)

async function exportCompPdf(row: CompRow) {
  compExporting.value = row.id
  error.value = ''
  try {
    const res = await fetch(`/cloud/compositions/${row.id}/pdf`, {
      headers: cloudAuthHeaders(),
    })
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const body = (await res.json()) as { detail?: string }
        if (body?.detail) detail = body.detail
      } catch {
        /* 非 JSON 错误体 */
      }
      throw new Error(detail)
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(row.name || 'composition').replace(/[\\/:*?"<>|]/g, '_')}.pdf`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch (e) {
    error.value = t('cloud.compsExportFailed') + ': ' + errText(e)
  } finally {
    compExporting.value = null
  }
}

// ---------------------------------------------------------------------------
// 导出管控（双水印：预设/自定义 + 预览；每人组卷/周月导出/单次题数限额）
// ---------------------------------------------------------------------------
interface WmConfig {
  enabled: boolean
  mode: 'preset' | 'custom'
  text: string
}
type WmKey = 'export_watermark' | 'browse_watermark'

const wmSettings = ref<{ export_watermark: WmConfig; browse_watermark: WmConfig } | null>(null)
const wmBusy = ref(false)
const guardLoaded = ref(false)

function wm(key: WmKey): WmConfig {
  return wmSettings.value?.[key] ?? { enabled: false, mode: 'preset', text: '' }
}

async function loadSettings() {
  error.value = ''
  try {
    wmSettings.value = (await api('/cloud/settings')) as typeof wmSettings.value
  } catch (e) {
    error.value = t('cloud.guardWatermarkFailed') + ': ' + errText(e)
  }
}

async function patchWm(key: WmKey, patch: Partial<WmConfig>) {
  wmBusy.value = true
  error.value = ''
  try {
    const res = (await api('/cloud/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...cloudAuthHeaders() },
      body: JSON.stringify({ [key]: patch }),
    })) as Record<string, WmConfig>
    if (wmSettings.value && res[key]) wmSettings.value[key] = res[key]
  } catch (e) {
    error.value = errText(e)
    await loadSettings() // 失败回读，界面回到服务端真实状态
  } finally {
    wmBusy.value = false
  }
}

function onWmEnabled(key: WmKey, e: Event) {
  void patchWm(key, { enabled: (e.target as HTMLInputElement).checked })
}

function onWmMode(key: WmKey, e: Event) {
  const mode = (e.target as HTMLSelectElement).value as WmConfig['mode']
  void patchWm(key, { mode })
}

function onWmText(key: WmKey, e: Event) {
  void patchWm(key, { text: (e.target as HTMLInputElement).value })
}

// ---- 水印预览（示例邮箱/日期代入占位符；与网页端展开规则一致）----
const wmExampleEmail = 'user@example.com'
const wmExampleDate = computed(() => new Date().toISOString().slice(0, 10))
const wmExampleTextPh = '{email} {date}'

function wmResolveText(key: WmKey): string {
  const cfg = wm(key)
  const base =
    cfg.mode === 'preset'
      ? key === 'export_watermark'
        ? '{email} {date}'
        : '{email}'
      : cfg.text || (key === 'export_watermark' ? '{email} {date}' : '{email}')
  return base.replaceAll('{email}', wmExampleEmail).replaceAll('{date}', wmExampleDate.value)
}

function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c,
  )
}

/** 浏览水印平铺预览背景（SVG data-URI，与 web 端 BrowseWatermark 同构） */
function wmTiledBg(text: string): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="460" height="300">' +
    `<text x="230" y="150" transform="rotate(-24 230 150)" text-anchor="middle" ` +
    'font-family="Arial, Helvetica, sans-serif" font-size="15" ' +
    `fill="rgba(0,0,0,0.08)">${escapeXml(text)}</text></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

type QuotaField =
  | 'max_compositions'
  | 'max_exports_per_week'
  | 'max_exports_per_month'
  | 'max_export_items'

function onQuotaChange(p: ProfileRow, field: QuotaField, e: Event) {
  const input = e.target as HTMLInputElement
  const raw = input.value.trim()
  let value: number | null = null
  if (raw !== '') {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0) {
      error.value = t('cloud.guardQuotaInvalid')
      input.value = p[field] == null ? '' : String(p[field])
      return
    }
    value = n
  }
  void patchProfile(p, { [field]: value })
}

function setTab(next: 'feedback' | 'perm' | 'comps' | 'guard') {
  tab.value = next
  if (next === 'comps' && !compsLoaded.value) {
    compsLoaded.value = true
    void loadCompositions()
  }
  if (next === 'guard' && !guardLoaded.value) {
    guardLoaded.value = true
    void loadSettings()
  }
}

onMounted(() => {
  void loadFeedback()
  void loadProfiles()
})
</script>

<template>
  <div style="max-width: 1040px">
    <h2 style="font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 16px">
      {{ t('cloud.title') }}
    </h2>

    <div class="cl-tabs">
      <button :class="{ active: tab === 'feedback' }" @click="setTab('feedback')">
        {{ t('cloud.tabFeedback') }}
      </button>
      <button :class="{ active: tab === 'perm' }" @click="setTab('perm')">
        {{ t('cloud.tabPerm') }}
      </button>
      <button :class="{ active: tab === 'comps' }" @click="setTab('comps')">
        {{ t('cloud.tabComps') }}
      </button>
      <button :class="{ active: tab === 'guard' }" @click="setTab('guard')">
        {{ t('cloud.tabGuard') }}
      </button>
    </div>

    <p v-if="error" class="cl-error">{{ error }}</p>

    <!-- 反馈处理 -->
    <div v-if="tab === 'feedback'" class="cl-card">
      <div v-if="fbLoading" class="cl-empty">…</div>
      <table v-else class="cl-table">
        <thead>
          <tr>
            <th style="width: 150px">{{ t('cloud.fbQuestion') }}</th>
            <th>{{ t('cloud.fbBody') }}</th>
            <th style="width: 170px">{{ t('cloud.fbUser') }}</th>
            <th style="width: 88px">{{ t('cloud.fbStatus') }}</th>
            <th style="width: 130px">{{ t('cloud.fbTime') }}</th>
            <th style="width: 170px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in fbRows" :key="row.id">
            <td style="font-weight: 600">{{ fbQLabel(row) }}</td>
            <td class="cl-body">{{ row.body }}</td>
            <td class="cl-muted">{{ fbUser(row) }}</td>
            <td>
              <span class="cl-tag" :class="statusTag(row.status)">
                {{ row.status === 'accepted' ? t('cloud.sugAccepted') : row.status === 'rejected' ? t('cloud.sugRejected') : t('cloud.sugOpen') }}
              </span>
            </td>
            <td class="cl-muted">{{ fmtTime(row.created_at) }}</td>
            <td>
              <div class="cl-actions">
                <button
                  class="cl-btn cl-btn--ghost"
                  :disabled="fbBusyId === row.id"
                  @click="locateQuestion(row)"
                >{{ t('cloud.fbLocate') }}</button>
                <button
                  v-if="row.status !== 'accepted'"
                  class="cl-btn"
                  :disabled="fbBusyId === row.id"
                  @click="setSuggestionStatus(row, 'accepted')"
                >{{ t('cloud.fbAccept') }}</button>
                <button
                  v-if="row.status !== 'rejected'"
                  class="cl-btn"
                  :disabled="fbBusyId === row.id"
                  @click="setSuggestionStatus(row, 'rejected')"
                >{{ t('cloud.fbReject') }}</button>
                <button
                  v-if="row.status !== 'open'"
                  class="cl-btn cl-btn--ghost"
                  :disabled="fbBusyId === row.id"
                  @click="setSuggestionStatus(row, 'open')"
                >{{ t('cloud.fbReopen') }}</button>
                <button
                  class="cl-btn cl-btn--danger"
                  :disabled="fbBusyId === row.id"
                  @click="deleteSuggestion(row)"
                >{{ t('cloud.fbDelete') }}</button>
              </div>
            </td>
          </tr>
          <tr v-if="!fbRows.length">
            <td colspan="6" class="cl-empty">{{ t('cloud.fbEmpty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 权限管理 -->
    <div v-else-if="tab === 'perm'" class="cl-perm">
      <div class="cl-card cl-card--left">
        <div class="cl-user-create" style="position: relative; z-index: 5">
          <div class="cl-user-create-title">{{ t('cloud.userCreate') }}</div>
          <form class="cl-user-create-row" style="position: relative; z-index: 6" @submit.prevent="createUser">
            <input
              class="cl-email-input"
              type="text"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              placeholder="admin@example.com"
              :disabled="creatingUser"
              :value="newEmail"
              style="width: 240px; max-width: 100%; min-height: 36px; padding: 6px 12px; font-size: 14px; border: 1px solid var(--border); border-radius: 8px; background: #fff; color: #111; outline: none; pointer-events: auto; user-select: text; -webkit-user-select: text; display: block"
              @input="onEmailInput"
              @keydown.stop
              @keyup.stop
              @click.stop
            />
            <select v-model="newRole" class="cl-select" :disabled="creatingUser" style="min-height: 36px">
              <option value="teacher">{{ t('cloud.permRoleTeacher') }}</option>
              <option value="admin">{{ t('cloud.permRoleAdmin') }}</option>
            </select>
            <label class="cl-check">
              <input v-model="newSeeDrafts" type="checkbox" :disabled="creatingUser" />
              {{ t('cloud.permDrafts') }}
            </label>
            <button
              type="submit"
              class="cl-btn cl-btn--primary"
              :disabled="creatingUser || !newEmail.trim()"
            >{{ t('cloud.userSubmit') }}</button>
          </form>
          <div class="cl-hint">{{ t('cloud.userInviteHint') }}</div>
          <div v-if="inviteResult" class="cl-invite-result">{{ inviteResult }}</div>
        </div>

        <div v-if="permLoading" class="cl-empty">…</div>
        <table v-else class="cl-table">
          <thead>
            <tr>
              <th>{{ t('cloud.permEmail') }}</th>
              <th style="width: 96px">{{ t('cloud.permRole') }}</th>
              <th style="width: 76px">{{ t('cloud.permDrafts') }}</th>
              <th style="width: 76px">{{ t('cloud.permStatus') }}</th>
              <th style="width: 70px"></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in profiles"
              :key="p.id"
              class="cl-row-click"
              :class="{ 'cl-row--active': p.id === selectedUserId }"
              @click="selectUser(p.id)"
            >
              <td>{{ p.email }}</td>
              <td @click.stop>
                <select
                  class="cl-select"
                  :value="p.role"
                  :disabled="busyUserId === p.id"
                  @change="patchProfile(p, { role: ($event.target as HTMLSelectElement).value })"
                >
                  <option value="admin">{{ t('cloud.permRoleAdmin') }}</option>
                  <option value="teacher">{{ t('cloud.permRoleTeacher') }}</option>
                </select>
              </td>
              <td @click.stop>
                <input
                  type="checkbox"
                  :checked="p.can_see_drafts"
                  :disabled="busyUserId === p.id"
                  @change="patchProfile(p, { can_see_drafts: ($event.target as HTMLInputElement).checked })"
                />
              </td>
              <td @click.stop>
                <span class="cl-tag" :class="p.is_active ? 'tag-ok' : 'tag-warn'">
                  {{ p.is_active ? t('cloud.permActive') : t('cloud.permInactive') }}
                </span>
              </td>
              <td @click.stop>
                <button
                  class="cl-btn"
                  :class="p.is_active ? 'cl-btn--danger' : ''"
                  :disabled="busyUserId === p.id"
                  @click="toggleActive(p)"
                >
                  {{ p.is_active ? t('cloud.permDisable') : t('cloud.permEnable') }}
                </button>
              </td>
            </tr>
            <tr v-if="!profiles.length">
              <td colspan="5" class="cl-empty">—</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="cl-card cl-card--right">
        <template v-if="selectedProfile">
          <div class="cl-grant-head">
            <b>{{ selectedProfile.email }}</b>
            <span class="cl-muted">{{ t('cloud.permGrants') }}</span>
          </div>
          <p class="cl-hint">{{ t('cloud.permHint') }}</p>

          <div class="cl-grant-add">
            <SectionCascadeSelect
              v-model="grantValue"
              :options="grantCascadeOptions"
              :placeholder="t('cloud.permValue')"
              style="min-width: 220px"
            />
            <SectionCascadeSelect
              v-model="grantPaperValue"
              :options="paperCascadeOptions"
              :placeholder="t('cloud.permScopePaper')"
              style="min-width: 180px"
            />
            <button class="cl-btn cl-btn--primary" :disabled="!grantValue && !grantPaperValue" @click="addGrant">
              {{ t('cloud.permAdd') }}
            </button>
          </div>

          <div v-if="grantsLoading" class="cl-empty">…</div>
          <ul v-else class="cl-grant-list">
            <li v-for="g in grants" :key="g.id">
              <span class="cl-tag">{{ scopeLabel(g.scope) }}</span>
              <span class="cl-grant-value">{{ displayGrantValue(g) }}</span>
              <button class="cl-btn cl-btn--danger" @click="removeGrant(g.id)">{{ t('cloud.permDel') }}</button>
            </li>
            <li v-if="!grants.length" class="cl-muted" style="list-style: none">{{ t('cloud.permEmpty') }}</li>
          </ul>
        </template>
        <div v-else class="cl-empty">{{ t('cloud.permSelect') }}</div>
      </div>
    </div>

    <!-- 组卷查看 -->
    <div v-else-if="tab === 'comps'">
      <div class="cl-toolbar">
        <select v-model="compFilter" class="cl-select" style="min-width: 180px" @change="expandedComp = null">
          <option value="">{{ t('cloud.compsFilterAll') }}</option>
          <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.email }}</option>
        </select>
        <button class="cl-btn cl-btn--ghost" :disabled="compLoading" @click="loadCompositions">↻</button>
      </div>
      <div class="cl-card">
        <div v-if="compLoading" class="cl-empty">…</div>
        <table v-else class="cl-table">
          <thead>
            <tr>
              <th>{{ t('cloud.compsOwner') }}</th>
              <th>{{ t('cloud.compsName') }}</th>
              <th style="width: 64px">{{ t('cloud.compsItems') }}</th>
              <th style="width: 76px">{{ t('cloud.compsVis') }}</th>
              <th style="width: 120px">{{ t('cloud.compsTime') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in filteredComps" :key="row.id">
              <tr
                class="cl-row-click"
                :class="{ 'cl-row--active': expandedComp === row.id }"
                @click="toggleComp(row.id)"
              >
                <td>{{ row.owner_email || '—' }}</td>
                <td style="font-weight: 600">
                  {{ row.name }}<span v-if="row.title" class="cl-muted"> · {{ row.title }}</span>
                </td>
                <td>{{ row.item_count }}</td>
                <td>
                  <span class="cl-tag" :class="row.visibility === 'shared' ? 'tag-ok' : ''">
                    {{ row.visibility === 'shared' ? t('cloud.compsShared') : t('cloud.compsPrivate') }}
                  </span>
                </td>
                <td class="cl-muted">{{ fmtTime(row.updated_at) }}</td>
              </tr>
              <tr v-if="expandedComp === row.id" class="cl-detail-row">
                <td colspan="5">
                  <div class="cl-comp-detail-head">
                    <button
                      class="cl-btn cl-btn--primary"
                      :disabled="compExporting === row.id"
                      @click.stop="exportCompPdf(row)"
                    >
                      {{
                        compExporting === row.id
                          ? t('cloud.compsExporting')
                          : t('cloud.compsExport')
                      }}
                    </button>
                    <span class="cl-muted">{{ t('cloud.compsExportHint') }}</span>
                    <span v-if="compDetail.length" class="cl-comp-count">{{ compDetail.length }}</span>
                  </div>
                  <div v-if="compDetailLoading" class="cl-empty">…</div>
                  <ul v-else class="cl-comp-detail">
                    <li
                      v-for="it in compDetail"
                      :key="it.id"
                      class="cl-comp-item"
                      :class="{ 'cl-comp-item--blank': it.item_type === 'blank_page' }"
                    >
                      <template v-if="it.item_type === 'blank_page'">
                        <div class="cl-comp-blank">
                          <span class="cl-comp-blank-icon">◻</span>
                          <span>{{ compItemLabel(it) }}</span>
                        </div>
                      </template>
                      <template v-else>
                        <div class="cl-comp-meta">
                          <div class="cl-comp-qno">#{{ it.question_no || t('cloud.compNoQno') }}</div>
                          <div class="cl-comp-label">{{ compItemMeta(it) }}</div>
                        </div>
                        <img
                          v-if="it.question_id"
                          class="cl-comp-thumb"
                          :src="`/questions/${it.question_id}/preview.png?w=1280`"
                          loading="lazy"
                          alt=""
                          @error="($event.target as HTMLImageElement).style.display = 'none'"
                        />
                      </template>
                    </li>
                    <li v-if="!compDetail.length" class="cl-muted" style="list-style: none">
                      {{ t('cloud.compsDetailEmpty') }}
                    </li>
                  </ul>
                </td>
              </tr>
            </template>
            <tr v-if="!filteredComps.length">
              <td colspan="5" class="cl-empty">{{ t('cloud.compsEmpty') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 导出管控：双水印配置 + 用户限额 -->
    <div v-else class="cl-guard">
      <div class="cl-wm-grid">
        <!-- 网页浏览水印 -->
        <div class="cl-card cl-wm-card">
          <div class="cl-user-create-title" style="padding: 8px 8px 0">{{ t('cloud.guardWmBrowse') }}</div>
          <p class="cl-hint">{{ t('cloud.guardWmBrowseHint') }}</p>
          <div class="cl-wm-controls">
            <label class="cl-check" style="font-size: 13px">
              <input
                type="checkbox"
                :checked="wm('browse_watermark').enabled"
                :disabled="wmBusy"
                @change="onWmEnabled('browse_watermark', $event)"
              />
              {{ wm('browse_watermark').enabled ? t('cloud.guardWatermarkOn') : t('cloud.guardWatermarkOff') }}
            </label>
            <select
              class="cl-select"
              :value="wm('browse_watermark').mode"
              :disabled="wmBusy"
              @change="onWmMode('browse_watermark', $event)"
            >
              <option value="preset">{{ t('cloud.guardWmPreset') }}</option>
              <option value="custom">{{ t('cloud.guardWmCustom') }}</option>
            </select>
          </div>
          <input
            v-if="wm('browse_watermark').mode === 'custom'"
            class="cl-input"
            style="width: calc(100% - 16px); margin: 0 8px; box-sizing: border-box"
            type="text"
            :value="wm('browse_watermark').text"
            :placeholder="wmExampleEmail"
            :disabled="wmBusy"
            maxlength="200"
            @change="onWmText('browse_watermark', $event)"
          />
          <div class="cl-wm-preview-label">{{ t('cloud.guardWmPreview') }}</div>
          <div
            class="cl-wm-preview-browse"
            :style="{ backgroundImage: wmTiledBg(wmResolveText('browse_watermark')) }"
          ></div>
        </div>

        <!-- 导出 PDF 水印 -->
        <div class="cl-card cl-wm-card">
          <div class="cl-user-create-title" style="padding: 8px 8px 0">{{ t('cloud.guardWmExport') }}</div>
          <p class="cl-hint">{{ t('cloud.guardWmExportHint') }}</p>
          <div class="cl-wm-controls">
            <label class="cl-check" style="font-size: 13px">
              <input
                type="checkbox"
                :checked="wm('export_watermark').enabled"
                :disabled="wmBusy"
                @change="onWmEnabled('export_watermark', $event)"
              />
              {{ wm('export_watermark').enabled ? t('cloud.guardWatermarkOn') : t('cloud.guardWatermarkOff') }}
            </label>
            <select
              class="cl-select"
              :value="wm('export_watermark').mode"
              :disabled="wmBusy"
              @change="onWmMode('export_watermark', $event)"
            >
              <option value="preset">{{ t('cloud.guardWmPreset') }}</option>
              <option value="custom">{{ t('cloud.guardWmCustom') }}</option>
            </select>
          </div>
          <input
            v-if="wm('export_watermark').mode === 'custom'"
            class="cl-input"
            style="width: calc(100% - 16px); margin: 0 8px; box-sizing: border-box"
            type="text"
            :value="wm('export_watermark').text"
            :placeholder="wmExampleTextPh"
            :disabled="wmBusy"
            maxlength="200"
            @change="onWmText('export_watermark', $event)"
          />
          <div class="cl-wm-preview-label">{{ t('cloud.guardWmPreview') }}</div>
          <div class="cl-wm-preview-export">
            <span class="cl-wm-preview-rot">{{ wmResolveText('export_watermark') }}</span>
          </div>
        </div>
      </div>
      <p class="cl-hint" style="margin: -4px 2px 0">{{ t('cloud.guardWmHint') }}</p>

      <div class="cl-card">
        <div class="cl-user-create-title" style="padding: 8px 8px 0">{{ t('cloud.guardQuotaTitle') }}</div>
        <p class="cl-hint">{{ t('cloud.guardQuotaHint') }}</p>
        <div v-if="permLoading" class="cl-empty">…</div>
        <table v-else class="cl-table">
          <thead>
            <tr>
              <th>{{ t('cloud.permEmail') }}</th>
              <th style="width: 22%">{{ t('cloud.guardQuotaComp') }}</th>
              <th style="width: 34%">{{ t('cloud.guardQuotaExport') }}</th>
              <th style="width: 22%">{{ t('cloud.guardQuotaExportItems') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in profiles" :key="p.id">
              <td>{{ p.email }}</td>
              <td>
                <div class="cl-quota-cell">
                  <span class="cl-muted">{{ t('cloud.guardQuotaUsage', { used: p.composition_count }) }}</span>
                  <input
                    class="cl-quota-input"
                    type="number"
                    min="0"
                    step="1"
                    :value="p.max_compositions ?? ''"
                    :placeholder="t('cloud.guardQuotaUnlimited')"
                    :disabled="busyUserId === p.id"
                    @change="onQuotaChange(p, 'max_compositions', $event)"
                  />
                </div>
              </td>
              <td>
                <div class="cl-quota-cell">
                  <span class="cl-muted">{{ t('cloud.guardQuotaUsageWeek', { used: p.export_count_week }) }}</span>
                  <input
                    class="cl-quota-input"
                    type="number"
                    min="0"
                    step="1"
                    :value="p.max_exports_per_week ?? ''"
                    :placeholder="t('cloud.guardQuotaUnlimited')"
                    :disabled="busyUserId === p.id"
                    @change="onQuotaChange(p, 'max_exports_per_week', $event)"
                  />
                </div>
                <div class="cl-quota-cell" style="margin-top: 6px">
                  <span class="cl-muted">{{ t('cloud.guardQuotaUsageMonth', { used: p.export_count_month }) }}</span>
                  <input
                    class="cl-quota-input"
                    type="number"
                    min="0"
                    step="1"
                    :value="p.max_exports_per_month ?? ''"
                    :placeholder="t('cloud.guardQuotaUnlimited')"
                    :disabled="busyUserId === p.id"
                    @change="onQuotaChange(p, 'max_exports_per_month', $event)"
                  />
                </div>
              </td>
              <td>
                <input
                  class="cl-quota-input"
                  style="width: 100%; box-sizing: border-box"
                  type="number"
                  min="0"
                  step="1"
                  :value="p.max_export_items ?? ''"
                  :placeholder="t('cloud.guardQuotaUnlimited')"
                  :disabled="busyUserId === p.id"
                  @change="onQuotaChange(p, 'max_export_items', $event)"
                />
              </td>
            </tr>
            <tr v-if="!profiles.length">
              <td colspan="4" class="cl-empty">{{ t('cloud.guardEmpty') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cl-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 14px;
  padding: 3px;
  background: var(--bg-pressed);
  border-radius: 10px;
  width: fit-content;
}

.cl-tabs button {
  padding: 6px 18px;
  border: none;
  background: none;
  font-size: 13px;
  font-family: inherit;
  color: var(--text-secondary);
  border-radius: 8px;
  cursor: pointer;
}

.cl-tabs button.active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.cl-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 8px;
  overflow: auto;
}

.cl-error {
  color: var(--danger);
  font-size: 13px;
  margin: 0 0 10px;
}

.cl-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.cl-table th {
  text-align: left;
  font-size: 12px;
  color: var(--text-tertiary);
  font-weight: 500;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.cl-table td {
  padding: 9px 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.cl-table tr:last-child td {
  border-bottom: none;
}

.cl-body {
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

.cl-muted {
  color: var(--text-tertiary);
  font-size: 12px;
}

.cl-empty {
  padding: 26px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

.cl-tag {
  display: inline-flex;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  white-space: nowrap;
}

.cl-tag.tag-ok {
  background: rgba(34, 197, 94, 0.12);
  border-color: transparent;
  color: #16a34a;
}

.cl-tag.tag-warn {
  background: rgba(245, 158, 11, 0.14);
  border-color: transparent;
  color: #b45309;
}

.cl-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.cl-user-create {
  padding: 12px;
  margin-bottom: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-pressed);
}

.cl-user-create-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}

.cl-user-create-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.cl-user-create-row:last-child {
  margin-bottom: 0;
}

.cl-input {
  flex: 1 1 180px;
  width: 180px;
  min-width: 160px;
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated, var(--bg-input));
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  pointer-events: auto;
  user-select: text;
  -webkit-user-select: text;
}

.cl-input:focus {
  border-color: var(--accent);
}

.cl-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.cl-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.cl-invite-result {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.5;
  word-break: break-all;
}

.cl-btn {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.cl-btn:hover:not(:disabled) {
  border-color: var(--border-strong);
}

.cl-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cl-btn--primary {
  height: 34px;
  padding: 0 16px;
  background: #141416;
  border-color: #141416;
  color: #fff;
  font-weight: 600;
  border-radius: 10px;
  box-shadow: var(--shadow-xs);
}

.cl-btn--primary:hover:not(:disabled) {
  background: #24262d;
  border-color: #24262d;
}

.dark .cl-btn--primary {
  background: #f5f5f7;
  border-color: #f5f5f7;
  color: #141416;
}

.cl-btn--ghost {
  background: transparent;
}

.cl-btn--danger {
  color: var(--danger);
  border-color: rgba(239, 68, 68, 0.4);
}

.cl-perm {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);
  gap: 12px;
  align-items: start;
}

.cl-row-click {
  cursor: pointer;
}

.cl-row-click:hover {
  background: var(--bg-hover);
}

.cl-row--active {
  background: var(--accent-soft);
}

.cl-select {
  min-height: 28px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
}

.cl-select--wide {
  flex: 1;
  min-width: 140px;
}

.cl-grant-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 8px 0;
  font-size: 13px;
}

.cl-hint {
  margin: 6px 8px 10px;
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.5;
}

.cl-grant-add {
  display: flex;
  gap: 8px;
  padding: 0 8px 10px;
}

.cl-grant-list {
  list-style: none;
  margin: 0;
  padding: 0 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cl-grant-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
}

.cl-grant-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cl-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}

.cl-detail-row td {
  background: transparent;
  padding: 4px 10px 14px;
}

.cl-comp-detail-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 4px 12px;
}

.cl-comp-count {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.cl-comp-detail {
  list-style: none;
  margin: 0;
  padding: 0 2px 4px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 960px;
}

.cl-comp-item {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: var(--bg-elevated);
  border: 1px solid rgba(17, 20, 22, 0.05);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xs);
  font-size: 13px;
  overflow: hidden;
}

.cl-comp-item--blank {
  flex-direction: row;
  align-items: center;
  padding: 10px 14px;
  background: var(--bg-input);
  border-style: dashed;
  border-color: rgba(217, 137, 15, 0.35);
  box-shadow: none;
}

.cl-comp-blank {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--warning);
  font-weight: 600;
  font-size: 13px;
}

.cl-comp-blank-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: var(--warning-soft);
  color: var(--warning);
  font-size: 12px;
}

.cl-comp-meta {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  padding: 0 2px;
}

.cl-comp-thumb {
  display: block;
  width: 100%;
  height: auto;
  border: none;
  border-radius: 10px;
  background: var(--bg-input);
}

.cl-comp-qno {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.2px;
  color: var(--text-primary);
  line-height: 1.2;
  flex-shrink: 0;
}

.cl-comp-label {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cl-guard {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cl-quota-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}

.cl-wm-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-items: start;
}

.cl-wm-card {
  overflow: visible;
}

.cl-wm-controls {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 4px 8px 10px;
}

.cl-wm-preview-label {
  padding: 0 8px 4px;
  font-size: 11px;
  color: var(--text-tertiary);
}

.cl-wm-preview-browse {
  height: 110px;
  margin: 0 8px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background-repeat: repeat;
  background-color: #fff;
}

.cl-wm-preview-export {
  position: relative;
  height: 140px;
  margin: 0 8px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
}

.cl-wm-preview-rot {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%) rotate(-30deg);
  white-space: nowrap;
  font-size: 14px;
  color: #888;
  opacity: 0.35;
  pointer-events: none;
}

.cl-quota-input {
  width: 88px;
  min-height: 28px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  outline: none;
}

.cl-quota-input:focus {
  border-color: var(--accent);
}

.cl-quota-input:disabled {
  opacity: 0.6;
}

@media (max-width: 900px) {
  .cl-perm {
    grid-template-columns: 1fr;
  }

  .cl-wm-grid {
    grid-template-columns: 1fr;
  }
}
</style>
