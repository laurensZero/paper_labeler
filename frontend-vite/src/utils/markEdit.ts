import type { BoundingBox } from '@/types/common'

export interface MarkEditQuestionLike {
  id: number
  question_no?: string | null
}

export interface MarkEditOriginal {
  question_no?: string | null
  sections?: unknown[]
  section?: string | null
  notes?: string | null
  difficulty?: number | null
}

export function resolveEditingQuestionNo(
  editingQuestionId: number | null | undefined,
  pageQuestions: MarkEditQuestionLike[] | null | undefined,
  original: MarkEditOriginal | null | undefined,
): string | null {
  if (editingQuestionId == null) return null
  const question = (pageQuestions || []).find((q) => Number(q.id) === Number(editingQuestionId))
  return question?.question_no || original?.question_no || null
}

export function canSaveMarkQuestion(editingQuestionId: number | null | undefined, boxCount: number): boolean {
  return editingQuestionId != null || boxCount > 0
}

export function buildMarkEditPayload(input: {
  section: string | null | undefined
  selectedSections: string[] | null | undefined
  original: MarkEditOriginal | null | undefined
  notes: string | null | undefined
  difficulty: number | null | undefined
  boxes: { page: number; bbox: BoundingBox }[]
}) {
  let sections = Array.isArray(input.selectedSections) && input.selectedSections.length > 0
    ? [...input.selectedSections]
    : (input.section ? [input.section] : [])
  if (sections.length === 0 && input.original) {
    sections = Array.isArray(input.original.sections)
      ? input.original.sections.filter((s) => s != null && String(s).trim()).map(String)
      : (input.original.section ? [input.original.section] : [])
  }
  const difficulty = typeof input.difficulty === 'number' && input.difficulty >= 1 && input.difficulty <= 5
    ? input.difficulty
    : null
  return {
    sections,
    notes: input.notes || null,
    difficulty,
    boxes: input.boxes.map((b) => ({ page: b.page, bbox: [...b.bbox] as BoundingBox })),
  }
}
