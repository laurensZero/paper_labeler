import type { BoundingBox } from './common'

/** A single question box (bounding box on a page image) */
export interface QuestionBox {
  id: number
  page: number
  bbox: BoundingBox
  image_url: string
}

/** Question returned from the API */
export interface Question {
  id: number
  paper_id: number
  question_no: string | null
  /** Legacy single-section field (first section) */
  section: string | null
  /** All sections this question belongs to */
  sections: string[]
  status: 'draft' | 'confirmed'
  notes: string | null
  is_favorite: boolean
  updated_at: string
  preview_image_url?: string | null
  boxes: QuestionBox[]
  /** Present in search results only */
  paper?: {
    id: number
    filename: string
    exam_code: string | null
  }
}

/** Payload for POST /papers/:id/questions */
export interface QuestionCreateParams {
  questionNo?: string
  section?: string
  sections?: string[]
  status?: 'draft' | 'confirmed'
  notes?: string
  boxes: BoxInParams[]
}

/** Payload for PATCH /questions/:id */
export interface QuestionUpdateParams {
  questionNo?: string
  section?: string
  sections?: string[]
  status?: 'draft' | 'confirmed'
  notes?: string
  isFavorite?: boolean
}

/** Box input for creating/updating questions */
export interface BoxInParams {
  page: number
  bbox: BoundingBox
}

/** Replace boxes payload (POST /questions/:id/boxes) */
export interface QuestionBoxesReplaceParams {
  boxes: BoxInParams[]
}

/** Search request body (POST /questions/search) */
export interface QuestionSearchParams {
  section?: string
  status?: string
  paperId?: number
  paperIds?: number[]
  questionNo?: string
  year?: string
  years?: string[]
  season?: string
  seasons?: string[]
  favorite?: boolean
  unsectioned?: boolean
  excludeMultiSection?: boolean
  page?: number
  pageSize?: number
  idsOnly?: boolean
}

/** Search response with pagination */
export interface QuestionSearchResponse {
  questions: Question[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

/** Search response when ids_only=true */
export interface QuestionIdsSearchResponse {
  question_ids: number[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

/** Batch update payload (POST /questions/batch_update) */
export interface QuestionsBatchUpdateParams {
  ids: number[]
  sections?: string[]
  isFavorite?: boolean
  notes?: string
}

/** Section stats entry (GET /section_stats) */
export interface SectionStat {
  section: string | null
  count: number
}

/** Random pick payload (POST /random_by_sections) */
export interface RandomPickParams {
  sections: Record<string, number>
  favoriteOnly?: boolean
  excludeYears?: string[]
}

/** Questions integrity check result */
export interface QuestionsIntegrityReport {
  total_questions: number
  missing_question_no: number
  duplicate_question_no_groups: number
  duplicate_question_no_total: number
  orphan_question_boxes: number
  orphan_answer_boxes: number
  orphan_question_sections: number
  duplicate_question_no_examples: string[]
  question_no_gap_count: number
  question_no_gap_examples: number[]
}

/** Questions repair result */
export interface QuestionsRepairReport {
  dry_run: boolean
  orphan_question_boxes_removed: number
  orphan_answer_boxes_removed: number
  orphan_question_sections_removed: number
  missing_question_no_filled: number
  question_no_resequenced_changed: number
}

/** Questions repair response */
export interface QuestionsRepairResponse {
  ok: boolean
  report: QuestionsRepairReport
}
