export type PaperType = 'qp' | 'ms' | 'er' | 'gt' | 'other'

export interface SubjectOption {
  value: string
  /** 完整展示文案（已去广告） */
  label: string
  /** 仅名称（无科目代码前缀），必有值 */
  title: string
}

/** 去掉上游广告后缀："- 🔥视频课速通🔥" 等 */
function cleanSubjectText(raw: string, value: string): string {
  let s = String(raw || '').trim()
  // 从 " - 🔥…" 截断
  const fireAt = s.search(/\s[-–—]\s*\u{1F525}/u)
  if (fireAt > 0) s = s.slice(0, fireAt).trim()
  // 兜底：广告关键词段
  s = s.replace(/\s*[-–—]\s*[^-]*\b(视频课|速通|推广|广告|课程包)\b.*$/u, '').trim()
  // 仍带火焰尾巴则再截
  const again = s.search(/\s[-–—]\s*\u{1F525}/u)
  if (again > 0) s = s.slice(0, again).trim()
  if (!s) return value
  return s
}

/** "9709 - 数学 (AS/A2)" → "数学 (AS/A2)" */
function subjectName(text: string, value: string): string {
  let s = String(text || '').trim()
  if (value && s.toLowerCase().startsWith(value.toLowerCase())) {
    s = s.slice(value.length).replace(/^[\s\-–—:·]+/, '').trim()
  }
  if (/^\d{3,4}\s*[-–—:·]/.test(s)) {
    s = s.replace(/^\d{3,4}\s*[-–—:·]+/, '').trim()
  }
  return s || value
}

export async function fetchSubjects(): Promise<SubjectOption[]> {
  const res = await postForm('/obj/Common/Subject/combo', {})
  if (!res.ok) throw new Error(`subjects HTTP ${res.status}`)
  const data = await res.json()
  if (!Array.isArray(data)) throw new Error('subject combo unexpected payload')
  return data
    .filter((x: { value?: unknown }) => x && typeof x.value === 'string')
    .map((x: { value: string; text?: string }) => {
      const value = String(x.value).trim()
      const raw = String(x.text || x.value || '')
      const cleaned = cleanSubjectText(raw, value)
      const title = subjectName(cleaned, value) || cleaned || value
      return {
        value,
        title,
        label: `${value} · ${title}`,
      }
    })
}

export interface PaperFile {
  filename: string
  type: PaperType
  paper: number | null
  variant: number | null
  label: string
}

export interface PaperGroup {
  key: string
  paper: number | null
  title: string
  files: PaperFile[]
}

/** 同源反代前缀：dev 见 vite proxy，生产见 _redirects */
const CIE = '/cie'

const FILENAME_RE = /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*\.pdf$/i

export function isSafeFilename(name: string): boolean {
  return FILENAME_RE.test(name) && !name.includes('..') && name.length <= 128
}

export function paperDownloadUrl(filename: string): string {
  return `${CIE}/obj/Common/Fetch/redir/${encodeURIComponent(filename)}`
}

/** 9709_s23_qp_11.pdf → structured meta */
export function parseFilename(filename: string): Omit<PaperFile, 'filename'> {
  const base = filename.replace(/\.pdf$/i, '')
  const parts = base.split('_')
  let type: PaperType = 'other'
  let paper: number | null = null
  let variant: number | null = null

  const typeToken = parts.find((p) => ['qp', 'ms', 'er', 'gt'].includes(p.toLowerCase()))
  if (typeToken) type = typeToken.toLowerCase() as PaperType

  const tail = parts[parts.length - 1]
  if (type === 'qp' || type === 'ms') {
    const m = /^(\d)(\d)$/.exec(tail)
    if (m) {
      paper = Number(m[1])
      variant = Number(m[2])
    }
  }

  return { type, paper, variant, label: labelOf(type, paper, variant) }
}

function labelOf(type: PaperType, paper: number | null, variant: number | null): string {
  if (type === 'er') return 'Examiner Report'
  if (type === 'gt') return 'Grade Thresholds'
  if (type === 'qp') {
    return paper != null ? `Q${paper}${variant != null ? `·V${variant}` : ''}` : 'Question Paper'
  }
  if (type === 'ms') {
    return paper != null ? `MS ${paper}${variant != null ? `·V${variant}` : ''}` : 'Mark Scheme'
  }
  return 'File'
}

async function postForm(path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${CIE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body),
  })
}

export async function fetchPapers(
  subject: string,
  year: string,
  season: string,
): Promise<PaperFile[]> {
  const res = await postForm('/obj/Common/Fetch/renum', { subject, year, season })
  if (!res.ok) throw new Error(`papers HTTP ${res.status}`)
  const data = await res.json()
  const rows: Array<{ file?: string }> = Array.isArray(data?.rows) ? data.rows : []
  const out: PaperFile[] = []
  for (const row of rows) {
    const filename = String(row.file || '')
    if (!filename.toLowerCase().endsWith('.pdf') || !isSafeFilename(filename)) continue
    out.push({ filename, ...parseFilename(filename) })
  }
  return out
}

/** 直链下载单份 PDF（同源 + Content-Disposition，兼容 IDM，不走 fetch+blob） */
export function downloadOne(file: PaperFile): void {
  const a = document.createElement('a')
  a.href = paperDownloadUrl(file.filename)
  a.download = file.filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** 服务端打包 ZIP，直链下载（兼容 IDM） */
export function downloadZip(files: PaperFile[]): { zipUrl: string; zipName: string } {
  const names = files.map((f) => f.filename)
  const q = encodeURIComponent(names.join(','))
  const stamp = new Date().toISOString().slice(0, 10)
  const zipName = `cie-papers-${stamp}.zip`
  const zipUrl = `${CIE}/__zip?files=${q}`
  return { zipUrl, zipName }
}

export function triggerZipDownload(files: PaperFile[]): void {
  const { zipUrl, zipName } = downloadZip(files)
  const a = document.createElement('a')
  a.href = zipUrl
  a.download = zipName
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
