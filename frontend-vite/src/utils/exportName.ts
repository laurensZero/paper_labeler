/** Pure export filename template helpers (no Vue / no localStorage). */

export const DEFAULT_EXPORT_NAME_TEMPLATE = '{mode}_{section}_{paper}_{year}_{season}_{count}'

export const EXPORT_NAME_TOKENS = new Set([
  'mode', 'section', 'paper', 'year', 'season', 'fav', 'exclude', 'count',
  'ts', 'date', 'time', 'seq', 'custom',
])

export function normalizeUniqueValues(values: unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values || []) {
    const key = String(value ?? '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

export function sanitizeExportTokenValue(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/_+/g, '_')
    .replace(/^[-_.]+|[-_.]+$/g, '')
}

export function sanitizeExportFileNameCore(value: unknown): string {
  const normalized = String(value ?? '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
  return normalized
    .split('_')
    .map((part) => part.trim().replace(/^[-.]+|[-.]+$/g, ''))
    .filter(Boolean)
    .join('_')
}

export function formatDateYmd(now = new Date()): string {
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
}

export function formatTimeHm(now = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
}

export function validateExportNameTemplate(template: string): string {
  const effective = String(template || '').trim() || DEFAULT_EXPORT_NAME_TEMPLATE
  const unknown: string[] = []
  const seen = new Set<string>()
  const tokenRe = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(effective)) !== null) {
    const key = String(m[1] || '').toLowerCase()
    if (!EXPORT_NAME_TOKENS.has(key) && !seen.has(key)) {
      seen.add(key)
      unknown.push(`{${key}}`)
    }
  }
  return unknown.length ? `导出文件名模板包含未知占位符：${unknown.join('、')}` : ''
}

export function templateUsesSeq(template: string): boolean {
  const effective = String(template || '').trim() || DEFAULT_EXPORT_NAME_TEMPLATE
  return /\{seq\}/i.test(effective)
}

export function templateHasTimeToken(template: string): boolean {
  return /\{(?:ts|date|time)\}/i.test(String(template || ''))
}

export function renderExportNameTemplate({
  template,
  context,
}: {
  template: string
  context: Record<string, unknown>
}): {
  name: string
  usedFallback: boolean
  templateError: string
  templateUsed: string
} {
  const effectiveTemplate = String(template || '').trim() || DEFAULT_EXPORT_NAME_TEMPLATE
  const templateError = validateExportNameTemplate(effectiveTemplate)
  const usedTemplate = templateError ? DEFAULT_EXPORT_NAME_TEMPLATE : effectiveTemplate
  const rendered = usedTemplate.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_m, rawKey) => {
    const key = String(rawKey || '').toLowerCase()
    return String(context?.[key] ?? '')
  })
  const name = sanitizeExportFileNameCore(rendered).slice(0, 150)
  return {
    name: name || `export_${context.ts || `${formatDateYmd()}_${formatTimeHm()}`}`,
    usedFallback: !!templateError,
    templateError,
    templateUsed: usedTemplate,
  }
}

export function applyAutoTimestamp(template: string, autoTimestamp: boolean): string {
  let t = String(template || '').trim() || DEFAULT_EXPORT_NAME_TEMPLATE
  if (autoTimestamp && !templateHasTimeToken(t)) t = `${t}_{ts}`
  return t
}

export interface ExportSeqState {
  exportSeqDate: string
  exportSeqNum: number
}

export function nextExportSeq(state: ExportSeqState, now = new Date()): number {
  const today = formatDateYmd(now)
  return state.exportSeqDate === today ? Math.max(0, state.exportSeqNum) + 1 : 1
}

export function commitExportSeqState(state: ExportSeqState, now = new Date()): ExportSeqState {
  return { exportSeqDate: formatDateYmd(now), exportSeqNum: nextExportSeq(state, now) }
}
