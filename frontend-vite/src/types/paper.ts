/** Paper as returned by GET /papers (list item) */
export interface PaperListItem {
  id: number
  display_no: number | null
  filename: string
  exam_code: string | null
  page_count: number | null
  question_count: number
  answers_marked: number
  done: boolean
  paired_paper_id: number | null
  is_answer: boolean
  year_token: string | null
  season_token: string | null
  created_at: string
}

/** Paper detail as returned by GET /papers/:id */
export interface PaperDetail {
  id: number
  filename: string
  exam_code: string | null
  done: boolean
  paired_paper_id: number | null
  is_answer: boolean
  pdf_url: string
  pages_dir: string | null
  page_count: number | null
  created_at: string
}

/** Answer paper list item (GET /answer_papers) */
export interface AnswerPaperListItem {
  id: number
  display_no: number | null
  filename: string
  exam_code: string | null
  page_count: number | null
  paired_paper_id: number | null
  done: boolean
  question_count: number
  answers_marked: number
  created_at: string
}

/** Page image info (GET /papers/:id/pages) */
export interface Page {
  page: number
  image_url: string
}

/** Paper update payload (PATCH /papers/:id) */
export interface PaperUpdateParams {
  examCode?: string
  done?: boolean
}

/** Single upload result */
export interface UploadPdfResult {
  paper_id: number
  filename: string
  pages_dir: string
  page_count: number
  paired_paper_id: number | null
  ocr_questions: OcrQuestionDraft[]
  ocr_boxes: OcrBoxDraft[]
  ocr_warning: string | null
}

/** Batch upload response (POST /upload_pdfs) */
export interface UploadPdfsResponse {
  papers: UploadPdfResult[]
}

/** OCR auto-suggest question draft */
export interface OcrQuestionDraft {
  label: string | null
  boxes: OcrBoxDraft[]
  sections?: string[]
  section?: string
  source?: string
}

/** OCR auto-suggest box draft */
export interface OcrBoxDraft {
  page: number
  bbox: number[]
  label?: string | null
}

/** Auto-suggest request (POST /papers/:id/auto_suggest) */
export interface AutoSuggestRequest {
  minHeightPx?: number
  yPaddingPx?: number
}

/** Auto-suggest response */
export interface AutoSuggestResponse {
  paper_id: number
  ocr_questions: OcrQuestionDraft[]
  ocr_boxes: OcrBoxDraft[]
  ocr_warning: string | null
  skipped_pages: number[]
}
