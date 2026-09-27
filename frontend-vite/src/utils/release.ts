const GITHUB_API = 'https://api.github.com'
const GITEE_API = 'https://gitee.com/api/v5'
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
  source: 'github' | 'gitee'
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

// ── Fetch releases ──

async function apiFetch(url: string, headers: Record<string, string>) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal })
    if (!res.ok) throw new Error(`API error ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function getLatestRelease(owner: string, repo: string): Promise<Release> {
  const data = await apiFetch(`${GITHUB_API}/repos/${owner}/${repo}/releases/latest`, {
    Accept: 'application/vnd.github+json',
  })
  return {
    tag_name: String(data.tag_name || ''),
    body: String(data.body || ''),
    html_url: String(data.html_url || ''),
    assets: ((data.assets || []) as Array<{ name?: string; browser_download_url?: string; size?: number; digest?: string }>).map((a) => ({
      name: String(a.name || ''),
      browser_download_url: String(a.browser_download_url || ''),
      size: Number(a.size || 0),
      sha256: parseAssetSha256(a.digest, String(a.name || ''), String(data.body || '')),
    })),
    source: 'github',
  }
}

export async function getLatestReleaseFromGitee(owner: string, repo: string): Promise<Release> {
  const data = await apiFetch(`${GITEE_API}/repos/${owner}/${repo}/releases/latest`, {
    Accept: 'application/json',
  })
  const body = String(data.body || data.description || '')
  return {
    tag_name: String(data.tag_name || data.tag || ''),
    body,
    html_url: String(data.html_url || `https://gitee.com/${owner}/${repo}/releases`),
    assets: ((data.assets || []) as Array<{ name?: string; file_name?: string; browser_download_url?: string; download_url?: string; size?: number }>).map((a) => ({
      name: String(a.name || a.file_name || ''),
      browser_download_url: String(a.browser_download_url || a.download_url || ''),
      size: Number(a.size || 0),
      sha256: parseAssetSha256(undefined, String(a.name || a.file_name || ''), body),
    })),
    source: 'gitee',
  }
}

/** Prefer GitHub `digest` (sha256:...), else look for `sha256:` lines in the release body. */
function parseAssetSha256(digest: string | undefined, assetName: string, body: string): string | undefined {
  if (digest) {
    const m = digest.match(/sha256:([a-f0-9]{64})/i)
    if (m) return m[1].toLowerCase()
  }
  if (!assetName) return undefined
  const re = new RegExp(`(?:^|\\n)\\s*${assetName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*[:\\-]?\\s*(?:sha256:)?([a-f0-9]{64})`, 'i')
  const m = body.match(re)
  return m ? m[1].toLowerCase() : undefined
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
