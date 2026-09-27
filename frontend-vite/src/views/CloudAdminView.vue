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

const tab = ref<'feedback' | 'perm'>('feedback')
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
// 权限管理
// ---------------------------------------------------------------------------
interface ProfileRow {
  id: string
  email: string
  role: 'admin' | 'teacher'
  can_see_drafts: boolean
  created_at: string
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
      <button :class="{ active: tab === 'feedback' }" @click="tab = 'feedback'">
        {{ t('cloud.tabFeedback') }}
      </button>
      <button :class="{ active: tab === 'perm' }" @click="tab = 'perm'">
        {{ t('cloud.tabPerm') }}
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
    <div v-else class="cl-perm">
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
              <th style="width: 110px">{{ t('cloud.permRole') }}</th>
              <th style="width: 90px">{{ t('cloud.permDrafts') }}</th>
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
            </tr>
            <tr v-if="!profiles.length">
              <td colspan="3" class="cl-empty">—</td>
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
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
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

@media (max-width: 900px) {
  .cl-perm {
    grid-template-columns: 1fr;
  }
}
</style>
