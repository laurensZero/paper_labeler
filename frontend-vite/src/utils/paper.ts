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
 * Index of the first unanswered question in a question_no-sorted list.
 * Returns -1 when every question is answered (or the list is empty).
 *
 * Critical for answer-mode entry: must scan ascending so a fresh paper
 * lands on question 1, not the last item.
 */
export function findFirstUnansweredIndex(
  questions: Array<{ id?: number | null } | null | undefined>,
  answeredIds: Iterable<number | string> | null | undefined,
): number {
  const list = Array.isArray(questions) ? questions : []
  if (!list.length) return -1
  const answered = new Set(
    Array.from(answeredIds || []).map((v) => Number(v)).filter((n) => Number.isFinite(n)),
  )
  for (let i = 0; i < list.length; i++) {
    const id = Number(list[i]?.id)
    if (!Number.isFinite(id) || id <= 0) return i
    if (!answered.has(id)) return i
  }
  return -1
}

/**
 * Question index to open after a successful save.
 * Advances by one from the index that was saved; never invents a jump.
 * Returns null when there is no next question.
 */
export function nextAnswerIndexAfterSave(
  savedIndex: number,
  total: number,
): number | null {
  if (!Number.isFinite(savedIndex) || savedIndex < 0) return null
  if (!Number.isFinite(total) || total <= 0) return null
  if (savedIndex + 1 >= total) return null
  return savedIndex + 1
}

/**
 * Clamp a persisted answer-progress index into the current question list.
 * Returns 0 when there is no valid saved index and the list is non-empty.
 */
export function clampAnswerProgressIndex(
  saved: number | null | undefined,
  total: number,
): number {
  if (!Number.isFinite(total) || total <= 0) return -1
  const n = Number(saved)
  if (!Number.isFinite(n) || n < 0 || n >= total) return 0
  return Math.floor(n)
}

/** Minimal box shape used when assembling an answer save payload. */
export interface AnswerSaveBox {
  /** Stable identity for soft-delete; never an array index. */
  id?: string
  page: number
  bbox: number[]
}

/**
 * Build the box list for POST /questions/:id/answer.
 *
 * - replace mode: only the new boxes (existing are discarded)
 * - normal mode: existing boxes minus removed ones, then new boxes
 *
 * Removing an existing box must actually drop it from the payload —
 * merging the full existing list back is what made "delete then save"
 * appear to require two attempts.
 *
 * Soft-delete identity is a stable `id` string. `removedExistingIndices`
 * remains supported for callers that still hold indices.
 */
export function buildAnswerSaveBoxes(options: {
  existing: AnswerSaveBox[] | null | undefined
  newBoxes: AnswerSaveBox[] | null | undefined
  removedExistingIndices?: Iterable<number> | null
  removedExistingIds?: Iterable<string> | null
  isReplace?: boolean
}): AnswerSaveBox[] {
  const existing = Array.isArray(options.existing) ? options.existing : []
  const newBoxes = Array.isArray(options.newBoxes) ? options.newBoxes : []
  if (options.isReplace) {
    return newBoxes.map((b) => ({ page: b.page, bbox: [...b.bbox] }))
  }
  const removedIdx = new Set(
    Array.from(options.removedExistingIndices || []).map((n) => Number(n)).filter((n) => Number.isFinite(n)),
  )
  const removedIds = new Set(
    Array.from(options.removedExistingIds || []).map((s) => String(s)).filter((s) => s !== ''),
  )
  const keptExisting = existing
    .map((b, idx) => ({ b, idx }))
    .filter(({ b, idx }) => {
      if (removedIdx.has(idx)) return false
      if (b.id != null && removedIds.has(String(b.id))) return false
      return true
    })
    .map(({ b }) => ({ page: b.page, bbox: [...b.bbox] }))
  return [...keptExisting, ...newBoxes.map((b) => ({ page: b.page, bbox: [...b.bbox] }))]
}

/** A real OCR question label — not null/empty and not the '?' placeholder. */
export function isUsableOcrLabel(label: unknown): boolean {
  const s = String(label ?? '').trim()
  return !!s && s !== '?'
}

export interface OcrDraftBoxLike {
  page?: number | string | null
  bbox?: number[] | null
  label?: string | null
}

export interface OcrDraftLike {
  label?: string | null
  boxes?: OcrDraftBoxLike[] | null
  difficulty?: number | null
}

export interface NormalizedOcrDraft {
  label: string
  boxes: OcrDraftBoxLike[]
  difficulty: number | null
}

/**
 * Keep only OCR drafts that carry a real question number.
 *
 * Garbled-text fallbacks used to arrive as `{label: null, boxes:[page-sized]}`.
 * Those must never become "题？" cards — drop the whole draft, boxes included.
 */
export function normalizeOcrDrafts(input: unknown): NormalizedOcrDraft[] {
  const drafts = Array.isArray(input) ? input : []
  const out: NormalizedOcrDraft[] = []
  for (const d of drafts) {
    if (!d || typeof d !== 'object') continue
    const raw = d as OcrDraftLike
    if (!isUsableOcrLabel(raw.label)) continue
    const boxes = Array.isArray(raw.boxes) ? raw.boxes.filter((b) => b && Array.isArray(b.bbox) && b.bbox.length === 4) : []
    if (!boxes.length) continue
    const difficulty = typeof raw.difficulty === 'number' && Number.isFinite(raw.difficulty) && raw.difficulty >= 1 && raw.difficulty <= 5
      ? Math.round(raw.difficulty)
      : null
    out.push({ label: String(raw.label).trim(), boxes, difficulty })
  }
  return out
}

/**
 * Keep only OCR boxes that carry a real question label.
 * Unlabeled boxes from the old per-page fallback are discarded.
 */
export function normalizeOcrBoxes(input: unknown): { page: number; bbox: number[]; label: string }[] {
  const boxes = Array.isArray(input) ? input : []
  const out: { page: number; bbox: number[]; label: string }[] = []
  for (const b of boxes) {
    if (!b || typeof b !== 'object') continue
    const raw = b as OcrDraftBoxLike
    if (!isUsableOcrLabel(raw.label)) continue
    const page = Number(raw.page)
    const bbox = Array.isArray(raw.bbox) ? raw.bbox.map(Number) : []
    if (!Number.isFinite(page) || bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) continue
    out.push({ page, bbox, label: String(raw.label).trim() })
  }
  return out
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
