// 考情雷达：按科目聚合「模块 × 年份」考情。
// 科目口径与 PaperCascadeMultiSelect.parsePaperMeta 一致：exam_code/filename 前缀 token。

import { getSupabase } from '@/lib/supabase'

// ── 难度 ──────────────────────────────────────────────────────
// questions.difficulty: smallint 1–5，未标注为 null（supabase/migrations/0008）。
export type DifficultyValue = number | null

/** 热力图取值方式。 */
export type HeatValueMode = 'count' | 'difficulty'

/** UI 可选模式 */
export const HEAT_VALUE_MODES: HeatValueMode[] = ['count', 'difficulty']

export interface PaperLite {
  id: number
  filename: string | null
  exam_code: string | null
  year_token: string | null
  season_token: string | null
}

export interface RadarQuestion {
  id: number
  paper_id: number
  question_no: string | null
  /** question_sections 优先，否则回退 questions.section */
  sections: string[]
  year: string
  season: string
  /** 1–5，未标注为 null */
  difficulty: DifficultyValue
  paperLabel: string
}

export interface SubjectPill {
  subject: string
  paperCount: number
  years: string[]
}

export interface HeatCell {
  section: string
  year: string
  count: number
  /** 该格难度样本 */
  difficulties: number[]
  questionIds: number[]
}

export interface OverdueItem {
  section: string
  lastYear: string
  gap: number
}

export interface SubjectRadar {
  subject: string
  years: string[]
  sections: string[]
  cells: Map<string, HeatCell>
  yearTotals: Map<string, number>
  sectionTotals: Map<string, number>
  totalQuestions: number
  overdue: OverdueItem[]
}

/** 雷达展示中应忽略的占位模块 / 年份 / 季度 */
export const HIDDEN_SECTION = '__UNSET__'
export const HIDDEN_TOKEN = 'unknown'

export function cellKey(section: string, year: string): string {
  return section + ' ' + year
}

function isHiddenSection(name: string): boolean {
  return !name || name === HIDDEN_SECTION || name === '__UNSET__'
}

function isHiddenToken(token: string): boolean {
  return !token || token === HIDDEN_TOKEN || token === 'unknown'
}

/** exam_code/filename 前缀 token，如 9231_s26_qp_13 -> 9231 */
export function parseSubject(code: string | null | undefined): string | null {
  const text = String(code || '').trim()
  if (!text) return null
  return text.match(/^([A-Za-z0-9]+)/)?.[1] ?? null
}

/** year_token 两位年份展示为 20xx；其余原样 */
export function formatYearToken(token: string): string {
  if (/^\d{2}$/.test(token)) return '20' + token
  return token
}

function yearNum(token: string): number | null {
  if (/^\d{2}$/.test(token)) {
    const n = Number(token)
    // 90-99 -> 19xx，00-89 -> 20xx
    return n >= 90 ? 1900 + n : 2000 + n
  }
  if (/^\d{4}$/.test(token)) return Number(token)
  return null
}

export function compareYearsDesc(a: string, b: string): number {
  const na = yearNum(a)
  const nb = yearNum(b)
  if (na != null && nb != null) return nb - na
  if (na != null) return -1
  if (nb != null) return 1
  return b.localeCompare(a, undefined, { numeric: true })
}

/** 热力格取值。难度模式接入后在此扩展。 */
export function cellDisplayValue(
  count: number,
  difficulties: DifficultyValue[],
  mode: HeatValueMode,
): number {
  if (mode === 'difficulty') {
    // 难度加权：难度和 × log(1+count)；无难度样本回退 0
    const nums = difficulties.filter((d): d is number => typeof d === 'number')
    if (!nums.length) return 0
    const sum = nums.reduce((a, b) => a + b, 0)
    return sum * Math.log(1 + count)
    return count
  }
  return count
}

/** 该格平均难度（无样本为 null） */
export function cellAvgDifficulty(cell: HeatCell | null): number | null {
  if (!cell || !cell.difficulties.length) return null
  const nums = cell.difficulties.filter((d): d is number => typeof d === 'number')
  if (!nums.length) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

export function maxCellDisplayValue(radar: SubjectRadar, mode: HeatValueMode): number {
  let max = 0
  for (const cell of radar.cells.values()) {
    const v = cellDisplayValue(cell.count, cell.difficulties, mode)
    if (v > max) max = v
  }
  return max
}

// ── 数据加载 ──────────────────────────────────────────────────

const MAX_QUESTIONS_PER_SUBJECT = 5000
const PAPER_IN_BATCH = 80

export async function fetchPapersForRadar(): Promise<PaperLite[]> {
  const { data, error } = await getSupabase()
    .from('papers')
    .select('id,filename,exam_code,year_token,season_token')
    .eq('is_answer', false)
    .order('id', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as PaperLite[]
}

/** 按科目分组试卷（仅题目卷）。 */
export function groupPapersBySubject(papers: PaperLite[]): SubjectPill[] {
  const map = new Map<string, { paperCount: number; years: Set<string> }>()
  for (const p of papers) {
    const subject = parseSubject(p.exam_code || p.filename)
    if (!subject) continue
    let entry = map.get(subject)
    if (!entry) {
      entry = { paperCount: 0, years: new Set() }
      map.set(subject, entry)
    }
    entry.paperCount += 1
    if (p.year_token && !isHiddenToken(p.year_token)) entry.years.add(p.year_token)
  }
  return [...map.entries()]
    .map(([subject, v]) => ({
      subject,
      paperCount: v.paperCount,
      years: [...v.years].sort(compareYearsDesc),
    }))
    .sort((a, b) => b.paperCount - a.paperCount || a.subject.localeCompare(b.subject))
}

async function fetchQuestionsByPaperIds(paperIds: number[]): Promise<RadarQuestion[]> {
  const sb = getSupabase()
  const out: RadarQuestion[] = []

  for (let i = 0; i < paperIds.length; i += PAPER_IN_BATCH) {
    const batch = paperIds.slice(i, i + PAPER_IN_BATCH)
    const selectCols =
      'id, question_no, paper_id, section, difficulty, ' +
      'question_sections ( section_name ), ' +
      'papers ( id, filename, exam_code, year_token, season_token )'
    const { data, error } = await sb
      .from('questions')
      .select(selectCols)
      .in('paper_id', batch)
      .order('id', { ascending: true })
      .limit(MAX_QUESTIONS_PER_SUBJECT)
    if (error) throw new Error(error.message)

    const rows = (data ?? []) as unknown as {
      id: number
      question_no: string | null
      paper_id: number
      section: string | null
      difficulty: number | null
      question_sections: { section_name: string }[] | null
      papers: PaperLite | PaperLite[] | null
    }[]

    for (const row of rows) {
      const paperRaw = row.papers
      const paper = Array.isArray(paperRaw) ? (paperRaw[0] ?? null) : paperRaw

      const tagged = row.question_sections?.map((s) => s.section_name).filter(Boolean) ?? []
      const rawSections = tagged.length ? tagged : row.section ? [row.section] : []
      const sections = rawSections.filter((s) => !isHiddenSection(s))

      const year = paper?.year_token ?? HIDDEN_TOKEN
      const season = paper?.season_token ?? HIDDEN_TOKEN

      // 无有效模块/年份/季度的题不进雷达（避免 __UNSET__ / unknown 污染矩阵）
      if (isHiddenToken(year) || isHiddenToken(season) || !sections.length) continue

      out.push({
        id: row.id,
        paper_id: row.paper_id,
        question_no: row.question_no,
        sections,
        year,
        season,
        difficulty: typeof row.difficulty === 'number' ? row.difficulty : null,
        paperLabel: paper?.exam_code || paper?.filename || '#' + row.paper_id,
      })
    }
  }

  return out
}

export function buildSubjectRadar(subject: string, questions: RadarQuestion[]): SubjectRadar {
  const cells = new Map<string, HeatCell>()
  const yearTotals = new Map<string, number>()
  const sectionTotals = new Map<string, number>()

  for (const q of questions) {
    if (isHiddenToken(q.year)) continue

    yearTotals.set(q.year, (yearTotals.get(q.year) ?? 0) + 1)

    // 多标签题在每个模块下各计 1（与题库筛选口径一致）
    for (const sec of q.sections) {
      if (isHiddenSection(sec)) continue
      const key = cellKey(sec, q.year)
      let cell = cells.get(key)
      if (!cell) {
        cell = {
          section: sec,
          year: q.year,
          count: 0,
          difficulties: [],
          questionIds: [],
        }
        cells.set(key, cell)
      }
      cell.count += 1
      cell.questionIds.push(q.id)
      if (q.difficulty != null) cell.difficulties.push(q.difficulty)
      sectionTotals.set(sec, (sectionTotals.get(sec) ?? 0) + 1)
    }
  }

  const years = [...yearTotals.keys()].sort(compareYearsDesc)
  const sections = [...sectionTotals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name)

  return {
    subject,
    years,
    sections,
    cells,
    yearTotals,
    sectionTotals,
    totalQuestions: questions.length,
    overdue: computeOverdue(cells, years, sections),
  }
}

/**
 * 「该考未考」启发式：历史上考过、但最近 gapThreshold 个年份 token 均未出现。
 * 不做预测，只提示空缺。
 */
export function computeOverdue(
  cells: Map<string, HeatCell>,
  years: string[],
  sections: string[],
  gapThreshold = 2,
): OverdueItem[] {
  if (!years.length) return []
  const latest = years[0]
  const recent = new Set(years.slice(0, gapThreshold))
  const out: OverdueItem[] = []

  for (const sec of sections) {
    let lastYear: string | null = null
    let appearsInRecent = false

    for (const y of years) {
      const cell = cells.get(cellKey(sec, y))
      if (!cell || cell.count <= 0) continue
      if (recent.has(y)) appearsInRecent = true
      if (lastYear == null) lastYear = y
    }

    if (appearsInRecent || lastYear == null) continue

    const ln = yearNum(lastYear)
    const tn = yearNum(latest)
    const gap = ln != null && tn != null ? Math.max(0, tn - ln) : gapThreshold
    if (gap >= gapThreshold) {
      out.push({ section: sec, lastYear, gap })
    }
  }

  return out.sort((a, b) => b.gap - a.gap || a.section.localeCompare(b.section))
}

/** 拉取单科题目并聚合。 */
export async function loadSubjectRadar(
  subject: string,
  papers: PaperLite[],
  seasonFilter: string[] = [],
): Promise<SubjectRadar> {
  const ids = papers
    .filter((p) => parseSubject(p.exam_code || p.filename) === subject)
    .map((p) => p.id)
  if (!ids.length) {
    return buildSubjectRadar(subject, [])
  }

  let questions = await fetchQuestionsByPaperIds(ids)
  if (seasonFilter.length) {
    const set = new Set(seasonFilter)
    questions = questions.filter((q) => set.has(q.season))
  }
  return buildSubjectRadar(subject, questions)
}
