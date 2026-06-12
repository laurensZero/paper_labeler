import type { BoundingBox } from './common'

/** A single answer box */
export interface AnswerBox {
  id: number
  page: number
  bbox: BoundingBox
  image_url: string
}

/** Answer returned from the API */
export interface Answer {
  id: number
  question_id: number
  ms_paper_id: number
  notes: string | null
  updated_at: string
  boxes: AnswerBox[]
}

/** Payload for POST /questions/:id/answer */
export interface AnswerUpsertParams {
  msPaperId: number
  notes?: string
  boxes: AnswerBoxInParams[]
}

/** Box input for answer upsert */
export interface AnswerBoxInParams {
  page: number
  bbox: BoundingBox
}
