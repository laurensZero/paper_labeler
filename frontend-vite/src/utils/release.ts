// R2 公开域（与 web/ 的 VITE_R2_PUBLIC_BASE 一致）；更新清单与安装包都只走这里
const R2_UPDATE_BASE = 'https://img.paperlabeler.de5.net'
const R2_LATEST_MANIFEST = `${R2_UPDATE_BASE}/app-update/latest.json`
const TIMEOUT = 15000

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
  sha256?: string
}

export interface Release {
  tag_name: string
  body: string
  html_url: string
  assets: ReleaseAsset[]
  source: 'r2'
}

// ── Version comparison ──

function parseVersion(v: string) {
  const norm = v.trim().replace(/^refs\/tags\//i, '').replace(/^[vV]/, '')
  const [base = '', pre = ''] = norm.split('-', 2)
  const parts = base.split('.').filter(Boolean).map(s => parseInt(s, 10)).filter(n => isFinite(n))
  return { raw: norm, parts, prerelease: pre.trim().toLowerCase() }
}

export function compareVersions(a: string, b: string): number {
  const la = parseVersion(a), ra = parseVersion(b)
  const len = Math.max(la.parts.length, ra.parts.length)
  for (let i = 0; i < len; i++) {
    const lv = la.parts[i] ?? 0, rv = ra.parts[i] ?? 0
    if (lv > rv) return 1
    if (lv < rv) return -1
  }
  if (!la.prerelease && ra.prerelease) return 1
  if (la.prerelease && !ra.prerelease) return -1
  if (la.prerelease || ra.prerelease) return la.prerelease.localeCompare(ra.prerelease, undefined, { numeric: true, sensitivity: 'base' })
  return 0
}

// ── Fetch release (R2 only) ──

async function requestText(url: string, headers: Record<string, string>, signal?: AbortSignal) {
  if (typeof window !== 'undefined' && window.electronAPI?.updaterFetchRelease) {
    return window.electronAPI.updaterFetchRelease(url, headers)
  }
  const res = await fetch(url, { headers, signal, redirect: 'follow' })
  return { status: res.status, url: res.url, body: await res.text() }
}

export async function getLatestRelease(): Promise<Release> {
  return getLatestReleaseFromR2()
}

async function getLatestReleaseFromR2(): Promise<Release> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const result = await requestText(R2_LATEST_MANIFEST, {
      Accept: 'application/json',
      'User-Agent': 'Paper-Labeler-Updater',
    }, ctrl.signal)
    if (result.status < 200 || result.status >= 300) throw new Error(`Update manifest error ${result.status}`)

    let data: {
      tag_name?: string
      body?: string
      html_url?: string
      assets?: Array<{ name?: string; browser_download_url?: string; size?: number; sha256?: string }>
    }
    try {
      data = JSON.parse(result.body)
    } catch {
      throw new Error('Update manifest is not valid JSON')
    }

    const tagName = String(data.tag_name || '').trim()
    if (!tagName) throw new Error('Update manifest missing tag_name')

    return {
      tag_name: tagName,
      body: String(data.body || ''),
      html_url: String(data.html_url || ''),
      assets: (data.assets || []).map((a) => ({
        name: String(a.name || ''),
        browser_download_url: String(a.browser_download_url || ''),
        size: Number(a.size || 0),
        sha256: a.sha256 ? String(a.sha256).toLowerCase().replace(/^sha256:/, '') : undefined,
      })),
      source: 'r2',
    }
  } finally {
    clearTimeout(timer)
  }
}

// ── Resolve portable EXE asset ──

export function resolvePortableAsset(release: Release): ReleaseAsset | null {
  const portable = release.assets.find(a => /-portable\.exe$/i.test(a.name))
  if (portable) return portable
  const exe = release.assets.find(a => /\.exe$/i.test(a.name))
  if (exe) return exe
  const msi = release.assets.find(a => /\.msi$/i.test(a.name))
  return msi || null
}

// ── Update level from release body ──

export type UpdateLevel = 'force' | 'prompt' | 'silent'

export function parseUpdateLevel(body: string): UpdateLevel {
  const m = body.match(/update_level:\s*(force|prompt|silent)/i)
  if (m && ['force', 'prompt', 'silent'].includes(m[1].toLowerCase())) return m[1].toLowerCase() as UpdateLevel
  return 'prompt'
}
