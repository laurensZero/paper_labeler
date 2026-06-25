export type AnswersPlacement = 'end' | 'interleaved'

/** Export options (matches backend ExportOptions) */
export interface ExportOptions {
  includeQuestionNo?: boolean
  includeSection?: boolean
  includePaper?: boolean
  includeOriginalQno?: boolean
  includeNotes?: boolean
  includeAnswers?: boolean
  answersPlacement?: AnswersPlacement
  filterSection?: string | null
  filename?: string | null
  saveDir?: string | null
  includeFilterSummary?: boolean
  filterSummaryLines?: string[] | null
  cropWorkers?: number
  // Composition mode extensions
  title?: string | null
  headerText?: string | null
  footerText?: string | null
  blankPagesPerQuestion?: number[] | null
  showPageNumbers?: boolean
}

/** Export request payload (POST /questions_pdf_job) */
export interface ExportRequest {
  ids: number[]
  options?: ExportOptions
}

/** Export job creation response */
export interface ExportJobCreated {
  job_id: string
  status: string
  queue_position: number
}

/** Export job progress detail */
export interface ExportJobProgress {
  done: number
  total: number
  percent: number
}

/** Export job status (GET /questions_pdf_job/:id) */
export interface ExportJobStatus {
  status: 'queued' | 'processing' | 'done' | 'error' | 'cancelled'
  download_url?: string
  saved_copy_path?: string | null
  message?: string
  phase?: string
  queue_position?: number
  progress?: ExportJobProgress
}

/** Pick save dir request */
export interface PickSaveDirRequest {
  initialDir?: string | null
}

/** Pick save dir response */
export interface PickSaveDirResponse {
  cancelled: boolean
  selected?: string
}

/** CIE import request */
export interface CieImportRequest {
  url: string
  ocrAuto?: boolean
  ocrMinHeightPx?: number
  ocrYPaddingPx?: number
}

/** CIE batch import request */
export interface CieBatchImportRequest {
  urls: string[]
  ocrAuto?: boolean
  ocrMinHeightPx?: number
  ocrYPaddingPx?: number
}

/** CIE fetch papers request */
export interface CieFetchPapersRequest {
  subject: string
  year: string
  season: string
}

/** CIE paper entry */
export interface CiePaper {
  filename: string
  url: string
}

/** CIE fetch papers response */
export interface CieFetchPapersResponse {
  success: boolean
  total: number
  papers: CiePaper[]
}

/** CIE import result for a single URL */
export interface CieImportResult {
  url: string
  success: boolean
  paper?: {
    id: number
    filename: string
    exam_code: string | null
    is_answer: boolean
    page_count: number | null
    paired_paper_id: number | null
  }
  ocr_questions?: unknown[]
  ocr_boxes?: unknown[]
  ocr_warn?: string | null
  error?: string
}

/** CIE batch import response */
export interface CieBatchImportResponse {
  total: number
  successful: number
  failed: number
  results: CieImportResult[]
  errors: CieImportResult[]
}

/** Purge all request */
export interface PurgeAllRequest {
  confirm1: string
  confirm2: string
  wipeSections?: boolean
}

/** Global stats (GET /stats) */
export interface GlobalStats {
  qp_papers: number
  answer_papers: number
  classified_questions: number
  max_question_no_numeric: number
}
