/** Composition (exam paper template) returned from the API */
export interface Composition {
  id: number
  name: string
  title: string | null
  header_text: string | null
  footer_text: string | null
  include_answers: boolean
  answers_placement: 'end' | 'interleaved'
  group_by_section: boolean
  show_section_headers: boolean
  show_question_info: boolean
  show_page_numbers: boolean
  created_at: string
  updated_at: string
  item_count: number
}

/** Composition detail with items */
export interface CompositionDetail extends Composition {
  items: CompositionItemDetail[]
}

/** A single item in a composition (question or blank page) */
export interface CompositionItem {
  id: number
  composition_id: number
  question_id: number
  sort_order: number
  blank_pages: number
  item_type: 'question' | 'blank_page'
  score: number | null
  custom_header: string | null
  created_at: string
}

/** Composition item enriched with question info */
export interface CompositionItemDetail extends CompositionItem {
  question_no: string | null
  sections: string[]
  paper_exam_code: string | null
  preview_image_url: string | null
  is_favorite: boolean
  notes: string | null
}

/** Create composition request */
export interface CompositionCreateParams {
  name: string
  title?: string | null
  header_text?: string | null
  footer_text?: string | null
  include_answers?: boolean
  answers_placement?: 'end' | 'interleaved'
  group_by_section?: boolean
  show_section_headers?: boolean
  show_question_info?: boolean
  show_page_numbers?: boolean
}

/** Update composition request */
export interface CompositionUpdateParams {
  name?: string
  title?: string | null
  header_text?: string | null
  footer_text?: string | null
  include_answers?: boolean
  answers_placement?: 'end' | 'interleaved'
  group_by_section?: boolean
  show_section_headers?: boolean
  show_question_info?: boolean
  show_page_numbers?: boolean
}

/** Add item to composition */
export interface CompositionItemAddParams {
  question_id: number
  sort_order?: number
  blank_pages?: number
  item_type?: 'question' | 'blank_page'
  score?: number | null
  custom_header?: string | null
}

/** Batch add items */
export interface CompositionItemBatchAddParams {
  question_ids: number[]
}

/** Update composition item */
export interface CompositionItemUpdateParams {
  sort_order?: number
  blank_pages?: number
  custom_header?: string | null
  score?: number | null
}

/** Reorder items */
export interface CompositionReorderParams {
  item_ids: number[]
}
