import { extractYearSeason } from './geometry'
import type { PaperDetail, PaperListItem } from '../types'

/**
 * Strip trailing .pdf extension (case-insensitive).
 */
export function stripPdfSuffix(name: string): string {
  const s = String(name || '').trim()
  return s.replace(/\.pdf$/i, '')
}

/**
 * Derive a display name for a paper from its exam_code or filename.
 */
export function formatPaperName(paper: { exam_code?: string | null; filename?: string } | null | undefined): string {
  const base = paper?.exam_code || paper?.filename || ''
  return stripPdfSuffix(base)
}

/**
 * Extract the cache-bust token ("v" param) from a URL string.
 * Returns null if missing or on parse failure.
 */
export function extractCacheBustToken(url: string): string | null {
  try {
    const u = new URL(String(url || ''), window.location.origin)
    const v = u.searchParams.get('v')
    return v ? String(v) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Last-marked-page persistence (localStorage)
// Keys follow the pattern: lastMarkedPage:<paperId>[:<token>]
// ---------------------------------------------------------------------------

export function lastMarkedPageKey(paperId: number | null | undefined, token?: string | null): string | null {
  if (paperId == null) return null
  const t = token ? String(token) : ''
  return t ? `lastMarkedPage:${paperId}:${t}` : `lastMarkedPage:${paperId}`
}

export function getLastMarkedPageNum(paperId: number | null | undefined, token?: string | null): number | null {
  const key = lastMarkedPageKey(paperId, token)
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    const n = raw != null ? parseInt(raw, 10) : NaN
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export function setLastMarkedPageNum(paperId: number | null | undefined, token: string | null | undefined, pageNum: number): void {
  const key = lastMarkedPageKey(paperId, token)
  if (!key) return
  try {
    localStorage.setItem(key, String(pageNum))
  } catch { /* storage full or unavailable */ }
}

// ---------------------------------------------------------------------------
// Answer-progress persistence (localStorage)
// Keys follow the pattern: answerProgress:<kind>:<qpId>:<qpToken>:<msId>:<msToken>
// ---------------------------------------------------------------------------

export function answerProgressKey(
  kind: string,
  qpPaperId: number | null | undefined,
  qpToken: string | null | undefined,
  msPaperId: number | null | undefined,
  msToken: string | null | undefined,
): string | null {
  if (!qpPaperId || !msPaperId) return null
  const qt = qpToken ? String(qpToken) : ''
  const mt = msToken ? String(msToken) : ''
  return `answerProgress:${kind}:${qpPaperId}:${qt}:${msPaperId}:${mt}`
}

export function getAnswerProgress(
  kind: string,
  qpPaperId: number | null | undefined,
  qpToken: string | null | undefined,
  msPaperId: number | null | undefined,
  msToken: string | null | undefined,
): number | null {
  const key = answerProgressKey(kind, qpPaperId, qpToken, msPaperId, msToken)
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    const n = raw != null ? parseInt(raw, 10) : NaN
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export function setAnswerProgress(
  kind: string,
  qpPaperId: number | null | undefined,
  qpToken: string | null | undefined,
  msPaperId: number | null | undefined,
  msToken: string | null | undefined,
  value: number,
): void {
  const key = answerProgressKey(kind, qpPaperId, qpToken, msPaperId, msToken)
  if (!key) return
  try {
    localStorage.setItem(key, String(value))
  } catch { /* storage full or unavailable */ }
}

// ---------------------------------------------------------------------------
// Mark-scheme pairing helpers
// ---------------------------------------------------------------------------

/**
 * Given a QP exam code or filename, derive the expected MS code by
 * replacing "_qp_" with "_ms_".  Returns null if no "_qp_" pattern is found.
 */
export function deriveMsCode(codeOrFilename: string): string | null {
  const s = String(codeOrFilename || '').replace(/\.pdf$/i, '')
  if (/_qp_/i.test(s)) return s.replace(/_qp_/i, '_ms_')
  return null
}

/**
 * Find the matching mark-scheme paper for a given paper detail.
 * Searches by paired_paper_id first, then by exam_code, then by filename.
 */
export function findMatchedMsPaper(
  paperDetail: PaperDetail | null | undefined,
  papers: PaperListItem[],
): PaperListItem | { id: number } | null {
  const list = Array.isArray(papers) ? papers : []
  const pairedId = paperDetail?.paired_paper_id
  if (pairedId) return list.find((p) => p.id === pairedId) || { id: pairedId }

  const msCode = deriveMsCode(paperDetail?.exam_code || paperDetail?.filename || '')
  if (!msCode) return null
  const byExam = list.find((p) => String(p.exam_code || '') === msCode)
  if (byExam) return byExam
  const byName = list.find((p) => String(p.filename || '').includes(msCode))
  return byName || null
}

// ---------------------------------------------------------------------------
// Question sorting
// ---------------------------------------------------------------------------

interface QuestionLike {
  id?: number
  question_no?: string | null
}

/**
 * Sort questions by numeric question_no ascending.
 * Non-numeric question_no values sort last.  Ties broken by id.
 */
export function sortQuestionsByNoAsc<T extends QuestionLike>(qs: T[]): T[] {
  const arr = Array.from(qs || [])
  arr.sort((a, b) => {
    const aNo = a.question_no
    const bNo = b.question_no
    const an =
      aNo != null && String(aNo).trim().match(/^\d+$/)
        ? parseInt(String(aNo).trim(), 10)
        : Number.POSITIVE_INFINITY
    const bn =
      bNo != null && String(bNo).trim().match(/^\d+$/)
        ? parseInt(String(bNo).trim(), 10)
        : Number.POSITIVE_INFINITY
    if (an !== bn) return an - bn
    return (a.id || 0) - (b.id || 0)
  })
  return arr
}

/**
 * Extract the two-digit year string from a paper's exam_code + filename.
 * Returns null if no year pattern is found.
 */
export function extractYearFromPaperName(paper: { exam_code?: string | null; filename?: string } | null | undefined): string | null {
  if (!paper) return null
  const { year } = extractYearSeason(
    String(paper.exam_code || '') + ' ' + String(paper.filename || ''),
  )
  return year || null
}

/**
 * Remove trailing promotional emoji text from OCR-extracted strings.
 */
export function removeAdText(text: string | null | undefined): string | null | undefined {
  if (!text) return text
  return text.replace(/\s*-\s*🔥.*🔥\s*$/g, '').trim()
}
