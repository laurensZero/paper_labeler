<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import { useSectionsStore } from '@/stores/sections'
import { usePapersStore } from '@/stores/papers'

defineOptions({ name: 'CloudAdminView' })

const { t } = useI18n()
const sectionsStore = useSectionsStore()
const papersStore = usePapersStore()

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
  questions: { question_no: string | null; papers: { exam_code: string | null } | { exam_code: string | null }[] | null } | null
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    row.status = status
  } catch (e) {
    error.value = errText(e)
  } finally {
    fbBusyId.value = null
  }
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
  scope: 'section' | 'paper' | 'question'
  scope_value: string
}

const profiles = ref<ProfileRow[]>([])
const permLoading = ref(false)
const selectedUserId = ref<string | null>(null)
const grants = ref<GrantRow[]>([])
const grantsLoading = ref(false)
const grantScope = ref<'section' | 'paper'>('section')
const grantValue = ref('')
const busyUserId = ref<string | null>(null)

const sectionOptions = computed(() => sectionsStore.sectionDefs.map((s) => s.name))
const paperOptions = computed(() =>
  papersStore.papers.map((p) => ({
    value: String(p.id),
    label: papersStore.formatPaperName(p) || `#${p.id}`,
  })),
)
const grantValueOptions = computed(() => (grantScope.value === 'section' ? sectionOptions.value : paperOptions.value.map((o) => o.label)))
const selectedProfile = computed(() => profiles.value.find((p) => p.id === selectedUserId.value) ?? null)

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

async function selectUser(id: string) {
  selectedUserId.value = id
  grantValue.value = ''
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
      headers: { 'Content-Type': 'application/json' },
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
  if (scope === 'paper') return t('cloud.permScopePaper')
  return 'question'
}

async function addGrant() {
  if (!selectedUserId.value || !grantValue.value) return
  // 试卷 scope 存 id，模块 scope 存名字
  let value = grantValue.value
  if (grantScope.value === 'paper') {
    const opt = paperOptions.value.find((o) => o.label === value)
    if (opt) value = opt.value
  }
  error.value = ''
  try {
    await api('/cloud/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: selectedUserId.value, scope: grantScope.value, scope_value: value }),
    })
    grantValue.value = ''
    await selectUser(selectedUserId.value)
  } catch (e) {
    error.value = errText(e)
  }
}

async function removeGrant(id: number) {
  error.value = ''
  try {
    await api(`/cloud/grants/${id}`, { method: 'DELETE' })
    grants.value = grants.value.filter((g) => g.id !== id)
  } catch (e) {
    error.value = errText(e)
  }
}

function displayGrantValue(g: GrantRow): string {
  if (g.scope === 'paper') {
    const opt = paperOptions.value.find((o) => o.value === g.scope_value)
    return opt ? opt.label : g.scope_value
  }
  return g.scope_value
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
            <select v-model="grantScope" class="cl-select">
              <option value="section">{{ t('cloud.permScopeSection') }}</option>
              <option value="paper">{{ t('cloud.permScopePaper') }}</option>
            </select>
            <select v-model="grantValue" class="cl-select cl-select--wide">
              <option value="" disabled>{{ t('cloud.permValue') }}</option>
              <option v-for="v in grantValueOptions" :key="v" :value="v">{{ v }}</option>
            </select>
            <button class="cl-btn cl-btn--primary" :disabled="!grantValue" @click="addGrant">
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
