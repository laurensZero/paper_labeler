const GITHUB_API = 'https://api.github.com'
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
  source: 'github'
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
    const result = await requestText(url, headers, ctrl.signal)
    if (result.status < 200 || result.status >= 300) throw new Error(`API error ${result.status}`)
    return JSON.parse(result.body)
  } finally {
    clearTimeout(timer)
  }
}

async function requestText(url: string, headers: Record<string, string>, signal?: AbortSignal) {
  if (typeof window !== 'undefined' && window.electronAPI?.updaterFetchRelease) {
    return window.electronAPI.updaterFetchRelease(url, headers)
  }
  const res = await fetch(url, { headers, signal, redirect: 'follow' })
  return { status: res.status, url: res.url, body: await res.text() }
}

/**
 * Prefer the public release page first: unauthenticated api.github.com is
 * rate-limited (403) and not suitable for desktop update checks.
 */
export async function getLatestRelease(owner: string, repo: string): Promise<Release> {
  try {
    return await getLatestReleaseFromPage(owner, repo)
  } catch (pageError) {
    try {
      return await getLatestReleaseFromApi(owner, repo)
    } catch {
      throw pageError
    }
  }
}

async function getLatestReleaseFromApi(owner: string, repo: string): Promise<Release> {
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

async function getLatestReleaseFromPage(owner: string, repo: string): Promise<Release> {
  const latestUrl = `https://github.com/${owner}/${repo}/releases/latest`
  const result = await requestText(latestUrl, { Accept: 'text/html', 'User-Agent': 'Paper-Labeler-Updater' })
  if (result.status < 200 || result.status >= 300) throw new Error(`GitHub release page error ${result.status}`)

  const html = result.body
  const releaseUrl = result.url || latestUrl
  const tagMatch = releaseUrl.match(/\/releases\/tag\/([^/?#]+)/i)
  const tagName = tagMatch ? decodeURIComponent(tagMatch[1]) : ''
  if (!tagName) throw new Error('GitHub latest release tag not found')

  const assetLinks = [...html.matchAll(/href=["']([^"']+\/releases\/download\/[^"']+\.exe(?:\?[^"']*)?)["']/gi)]
    .map((match) => new URL(match[1].replace(/&amp;/g, '&'), releaseUrl))
    .filter((url, index, all) => all.findIndex((item) => item.href === url.href) === index)
  const assetUrl = assetLinks.find((url) => /-portable\.exe$/i.test(decodeURIComponent(url.pathname)))
    || assetLinks[0]

  const version = tagName.replace(/^v/i, '')
  // electron-builder sanitizes productName spaces to dots: "Paper.Labeler-{version}-portable.exe"
  const fallbackNames = [
    `Paper.Labeler-${version}-portable.exe`,
    `Paper-Labeler-${version}-portable.exe`,
    `Paper Labeler-${version}-portable.exe`,
  ]
  const finalAssetUrl = assetUrl || new URL(
    `/${owner}/${repo}/releases/download/${encodeURIComponent(tagName)}/${encodeURIComponent(fallbackNames[0])}`,
    releaseUrl,
  )
  const assetName = decodeURIComponent(finalAssetUrl.pathname.split('/').pop() || fallbackNames[0])

  return {
    tag_name: tagName,
    body: '',
    html_url: releaseUrl,
    assets: [{ name: assetName, browser_download_url: finalAssetUrl.toString(), size: 0 }],
    source: 'github',
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
