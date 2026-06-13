import { api, upload } from './client'
import type {
  PaperListItem,
  PaperDetail,
  AnswerPaperListItem,
  Page,
  PaperUpdateParams,
  UploadPdfResult,
  UploadPdfsResponse,
  AutoSuggestRequest,
  AutoSuggestResponse,
  Question,
  QuestionCreateParams,
  QuestionUpdateParams,
  QuestionBoxesReplaceParams,
  QuestionSearchParams,
  QuestionSearchResponse,
  QuestionIdsSearchResponse,
  QuestionsBatchUpdateParams,
  SectionStat,
  RandomPickParams,
  QuestionsIntegrityReport,
  QuestionsRepairResponse,
  Answer,
  AnswerUpsertParams,
  SectionDef,
  SectionDefCreateParams,
  SectionDefUpdateParams,
  SectionGroup,
  SectionGroupCreateParams,
  SectionGroupUpdateParams,
  ExportRequest,
  ExportJobCreated,
  ExportJobStatus,
  PickSaveDirRequest,
  PickSaveDirResponse,
  CieImportRequest,
  CieBatchImportRequest,
  CieFetchPapersRequest,
  CieFetchPapersResponse,
  CieBatchImportResponse,
  PurgeAllRequest,
  GlobalStats,
} from '@/types'

// ---------------------------------------------------------------------------
// Papers
// ---------------------------------------------------------------------------

export const papersApi = {
  /** Return all paper filenames for duplicate checking */
  listFilenames(): Promise<{ filenames: string[] }> {
    return api('/papers/filenames')
  },

  /** Upload a single PDF */
  uploadPdf(
    file: File,
    options?: { ocrAuto?: boolean; ocrMinHeightPx?: number; ocrYPaddingPx?: number },
  ): Promise<UploadPdfResult> {
    const fd = new FormData()
    fd.append('file', file)
    if (options?.ocrAuto != null) fd.append('ocr_auto', String(options.ocrAuto))
    if (options?.ocrMinHeightPx != null)
      fd.append('ocr_min_height_px', String(options.ocrMinHeightPx))
    if (options?.ocrYPaddingPx != null)
      fd.append('ocr_y_padding_px', String(options.ocrYPaddingPx))
    return upload('/upload_pdf', fd)
  },

  /** Upload multiple PDFs */
  uploadPdfs(
    files: File[],
    options?: { ocrAuto?: boolean; ocrMinHeightPx?: number; ocrYPaddingPx?: number },
  ): Promise<UploadPdfsResponse> {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    if (options?.ocrAuto != null) fd.append('ocr_auto', String(options.ocrAuto))
    if (options?.ocrMinHeightPx != null)
      fd.append('ocr_min_height_px', String(options.ocrMinHeightPx))
    if (options?.ocrYPaddingPx != null)
      fd.append('ocr_y_padding_px', String(options.ocrYPaddingPx))
    return upload('/upload_pdfs', fd)
  },

  /** List all QP papers */
  list(): Promise<{ papers: PaperListItem[] }> {
    return api('/papers')
  },

  /** Get paper detail */
  get(paperId: number): Promise<PaperDetail> {
    return api(`/papers/${paperId}`)
  },

  /** Update paper metadata */
  update(paperId: number, params: PaperUpdateParams): Promise<{ paper: PaperListItem }> {
    return api(`/papers/${paperId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(params.examCode !== undefined && { exam_code: params.examCode }),
        ...(params.done !== undefined && { done: params.done }),
      }),
    })
  },

  /** Delete paper (and paired MS if exists) */
  delete(paperId: number): Promise<{ ok: boolean }> {
    return api(`/papers/${paperId}`, { method: 'DELETE' })
  },

  /** List rendered page images for a paper */
  listPages(paperId: number): Promise<{ paper_id: number; pages: Page[] }> {
    return api(`/papers/${paperId}/pages`)
  },

  /** Manually trigger auto-suggest for an existing paper */
  autoSuggest(paperId: number, params?: AutoSuggestRequest): Promise<AutoSuggestResponse> {
    return api(`/papers/${paperId}/auto_suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        min_height_px: params?.minHeightPx ?? 70,
        y_padding_px: params?.yPaddingPx ?? 12,
      }),
    })
  },

  /** List all answer (MS) papers */
  listAnswerPapers(): Promise<{ papers: AnswerPaperListItem[] }> {
    return api('/answer_papers')
  },

  /** Lookup an answer paper by exam code */
  lookupAnswerPaper(
    code: string,
  ): Promise<{ paper: { id: number; filename: string; examCode: string | null; pageCount: number | null; pairedPaperId: number | null } | null }> {
    return api(`/answer_papers/lookup?code=${encodeURIComponent(code)}`)
  },
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export const questionsApi = {
  /** Create a question under a paper */
  create(
    paperId: number,
    params: QuestionCreateParams,
  ): Promise<{ question: Question }> {
    return api(`/papers/${paperId}/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question_no: params.questionNo,
        section: params.section,
        sections: params.sections,
        status: params.status ?? 'confirmed',
        notes: params.notes,
        boxes: params.boxes.map((b) => ({ page: b.page, bbox: b.bbox })),
      }),
    })
  },

  /** Get a single question with boxes */
  get(questionId: number): Promise<{ question: Question }> {
    return api(`/questions/${questionId}`)
  },

  /** Update a question */
  update(
    questionId: number,
    params: QuestionUpdateParams,
  ): Promise<{ question: Question }> {
    const body: Record<string, unknown> = {}
    if (params.questionNo !== undefined) body.question_no = params.questionNo
    if (params.section !== undefined) body.section = params.section
    if (params.sections !== undefined) body.sections = params.sections
    if (params.status !== undefined) body.status = params.status
    if (params.notes !== undefined) body.notes = params.notes
    if (params.isFavorite !== undefined) body.is_favorite = params.isFavorite
    return api(`/questions/${questionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  /** Batch update questions */
  batchUpdate(params: QuestionsBatchUpdateParams): Promise<{ ok: boolean; updated: number }> {
    return api('/questions/batch_update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: params.ids,
        sections: params.sections,
        is_favorite: params.isFavorite,
        notes: params.notes,
      }),
    })
  },

  /** Delete a question */
  delete(questionId: number): Promise<{ ok: boolean }> {
    return api(`/questions/${questionId}`, { method: 'DELETE' })
  },

  /** Replace all boxes for a question */
  replaceBoxes(
    questionId: number,
    params: QuestionBoxesReplaceParams,
  ): Promise<{ question: Question }> {
    return api(`/questions/${questionId}/boxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boxes: params.boxes.map((b) => ({ page: b.page, bbox: b.bbox })),
      }),
    })
  },

  /** Delete a single question box */
  deleteBox(boxId: number): Promise<{ ok: boolean }> {
    return api(`/question_boxes/${boxId}`, { method: 'DELETE' })
  },

  /** List questions for a paper (with optional section/page filter) */
  listForPaper(
    paperId: number,
    params?: { section?: string; status?: string; page?: number },
  ): Promise<{ paper_id: number; questions: Question[] }> {
    const qs = new URLSearchParams()
    if (params?.section) qs.set('section', params.section)
    if (params?.status) qs.set('status', params.status)
    if (params?.page != null) qs.set('page', String(params.page))
    const query = qs.toString()
    return api(`/papers/${paperId}/questions${query ? `?${query}` : ''}`)
  },

  /** Search questions (POST body) */
  search(
    params: QuestionSearchParams,
  ): Promise<QuestionSearchResponse | QuestionIdsSearchResponse> {
    return api('/questions/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        section: params.section,
        status: params.status,
        paper_id: params.paperId,
        paper_ids: params.paperIds,
        question_no: params.questionNo,
        year: params.year,
        years: params.years,
        season: params.season,
        seasons: params.seasons,
        favorite: params.favorite,
        unsectioned: params.unsectioned,
        exclude_multi_section: params.excludeMultiSection,
        page: params.page,
        page_size: params.pageSize,
        ids_only: params.idsOnly,
      }),
    })
  },

  /** Get the answer for a question */
  getAnswer(questionId: number): Promise<{ answer: Answer | null }> {
    return api(`/questions/${questionId}/answer`)
  },

  /** Get which question IDs in a paper have answer boxes */
  getAnswerStatus(paperId: number): Promise<{ answered_ids: number[] }> {
    return api(`/papers/${paperId}/questions/answer_status`)
  },

  /** Create or update the answer for a question */
  upsertAnswer(
    questionId: number,
    params: AnswerUpsertParams,
  ): Promise<{ answer: Answer }> {
    return api(`/questions/${questionId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ms_paper_id: params.msPaperId,
        notes: params.notes,
        boxes: params.boxes.map((b) => ({ page: b.page, bbox: b.bbox })),
      }),
    })
  },

  /** Get section stats (question counts per section) */
  sectionStats(favoriteOnly?: boolean): Promise<SectionStat[]> {
    const qs = favoriteOnly ? '?favorite_only=true' : ''
    return api(`/section_stats${qs}`)
  },

  /** Questions integrity check */
  integrityCheck(): Promise<QuestionsIntegrityReport> {
    return api('/maintenance/questions_integrity')
  },

  /** Questions repair */
  repair(payload: {
    dryRun?: boolean
    removeOrphanBoxes?: boolean
    fillMissingQuestionNo?: boolean
    renumberQuestionNoSequence?: boolean
  }): Promise<QuestionsRepairResponse> {
    return api('/maintenance/questions_repair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dry_run: payload.dryRun ?? true,
        remove_orphan_boxes: payload.removeOrphanBoxes ?? false,
        fill_missing_question_no: payload.fillMissingQuestionNo ?? false,
        renumber_question_no_sequence: payload.renumberQuestionNoSequence ?? false,
      }),
    })
  },

  /** Randomly pick questions by section quotas */
  randomBySections(params: RandomPickParams): Promise<{ question_ids: number[] }> {
    return api('/random_by_sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sections: params.sections,
        favorite_only: params.favoriteOnly ?? false,
        exclude_years: params.excludeYears ?? [],
      }),
    })
  },
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export const sectionsApi = {
  /** List all distinct section names */
  list(): Promise<{ sections: string[] }> {
    return api('/sections')
  },

  /** List section definitions with group info */
  listDefs(): Promise<{ sections: SectionDef[] }> {
    return api('/section_defs')
  },

  /** Create a section definition */
  createDef(params: SectionDefCreateParams): Promise<{ section: SectionDef }> {
    return api('/section_defs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: params.name,
        content: params.content,
        group_id: params.groupId,
      }),
    })
  },

  /** Update a section definition */
  updateDef(
    sectionId: number,
    params: SectionDefUpdateParams,
  ): Promise<{ section: SectionDef; renamed_count: number }> {
    const body: Record<string, unknown> = {}
    if (params.name !== undefined) body.name = params.name
    if (params.content !== undefined) body.content = params.content
    if (params.groupId !== undefined) body.group_id = params.groupId
    return api(`/section_defs/${sectionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  /** Delete a section definition */
  deleteDef(sectionId: number): Promise<{ ok: boolean }> {
    return api(`/section_defs/${sectionId}`, { method: 'DELETE' })
  },

  /** List section groups */
  listGroups(): Promise<{ groups: SectionGroup[] }> {
    return api('/section_groups')
  },

  /** Create a section group */
  createGroup(params: SectionGroupCreateParams): Promise<{ group: SectionGroup }> {
    return api('/section_groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: params.name,
        show_in_filter: params.showInFilter,
      }),
    })
  },

  /** Update a section group */
  updateGroup(
    groupId: number,
    params: SectionGroupUpdateParams,
  ): Promise<{ group: SectionGroup }> {
    const body: Record<string, unknown> = {}
    if (params.name !== undefined) body.name = params.name
    if (params.showInFilter !== undefined) body.show_in_filter = params.showInFilter
    return api(`/section_groups/${groupId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  /** Delete a section group */
  deleteGroup(groupId: number): Promise<{ ok: boolean }> {
    return api(`/section_groups/${groupId}`, { method: 'DELETE' })
  },
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const exportApi = {
  /** Pick a save directory (desktop file picker) */
  pickSaveDir(params?: PickSaveDirRequest): Promise<PickSaveDirResponse> {
    return api('/export/pick_save_dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initial_dir: params?.initialDir,
      }),
    })
  },

  /** Create an export job */
  createJob(params: ExportRequest): Promise<ExportJobCreated> {
    return api('/export/questions_pdf_job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: params.ids,
        options: params.options
          ? {
              include_question_no: params.options.includeQuestionNo,
              include_section: params.options.includeSection,
              include_paper: params.options.includePaper,
              include_original_qno: params.options.includeOriginalQno,
              include_notes: params.options.includeNotes,
              include_answers: params.options.includeAnswers,
              answers_placement: params.options.answersPlacement,
              filter_section: params.options.filterSection,
              filename: params.options.filename,
              save_dir: params.options.saveDir,
              include_filter_summary: params.options.includeFilterSummary,
              filter_summary_lines: params.options.filterSummaryLines,
              crop_workers: params.options.cropWorkers,
            }
          : undefined,
      }),
    })
  },

  /** Check export job status */
  checkStatus(jobId: string): Promise<ExportJobStatus> {
    return api(`/export/questions_pdf_job/${jobId}`)
  },

  /** Cancel an export job */
  cancelJob(jobId: string): Promise<{ status: string; message?: string }> {
    return api(`/export/questions_pdf_job/${jobId}/cancel`, { method: 'POST' })
  },

  /** Get the download URL for a completed export job */
  downloadUrl(jobId: string): string {
    return `/export/download/${jobId}`
  },
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export const statsApi = {
  /** Get global stats */
  get(): Promise<GlobalStats> {
    return api('/stats')
  },
}

// ---------------------------------------------------------------------------
// CIE Import
// ---------------------------------------------------------------------------

export const cieImportApi = {
  /** Get subject combo list from CIE website */
  getSubjectCombo(): Promise<unknown[]> {
    return api('/cie_import/subject_combo')
  },

  /** Fetch paper list from CIE website */
  fetchPapers(params: CieFetchPapersRequest): Promise<CieFetchPapersResponse> {
    return api('/cie_import/fetch_papers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: params.subject,
        year: params.year,
        season: params.season,
      }),
    })
  },

  /** Import a single paper from URL */
  importFromUrl(params: CieImportRequest): Promise<{
    paper: {
      id: number
      filename: string
      exam_code: string | null
      is_answer: boolean
      page_count: number | null
      paired_paper_id: number | null
    }
    ocr_questions: unknown[]
    ocr_boxes: unknown[]
    ocr_warn: string | null
  }> {
    return api('/cie_import/from_url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: params.url,
        ocr_auto: params.ocrAuto,
        ocr_min_height_px: params.ocrMinHeightPx,
        ocr_y_padding_px: params.ocrYPaddingPx,
      }),
    })
  },

  /** Batch import papers from multiple URLs */
  batchImportFromUrls(params: CieBatchImportRequest): Promise<CieBatchImportResponse> {
    return api('/cie_import/batch_from_urls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: params.urls,
        ocr_auto: params.ocrAuto,
        ocr_min_height_px: params.ocrMinHeightPx,
        ocr_y_padding_px: params.ocrYPaddingPx,
      }),
    })
  },
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const adminApi = {
  /** Purge all data (requires double confirmation) */
  purgeAll(params: PurgeAllRequest): Promise<{ ok: boolean }> {
    return api('/admin/purge_all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirm1: params.confirm1,
        confirm2: params.confirm2,
        wipe_sections: params.wipeSections ?? false,
      }),
    })
  },
}
