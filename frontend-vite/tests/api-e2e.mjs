const baseUrl = (process.env.PAPER_LABELER_API_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '')
const token = `codex_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const created = {
  qpId: null,
  msId: null,
  sectionId: null,
  groupId: null,
  questionId: null,
  exportJobId: null,
}

const checks = []

function check(name, pass, detail = '') {
  checks.push({ name, pass: !!pass, detail: String(detail || '') })
}

function fail(name, detail = '') {
  check(name, false, detail)
  throw new Error(`${name}: ${detail}`)
}

async function api(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body)
    throw new Error(`HTTP ${res.status} ${res.statusText} ${path}: ${detail}`)
  }
  return body
}

async function apiMaybe(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options)
  const text = await res.text().catch(() => '')
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { ok: res.ok, status: res.status, body }
}

function escapePdfText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

function makePdf(title, lines = []) {
  const bodyLines = [title, ...lines]
  const textOps = bodyLines
    .map((line, idx) => `BT /F1 ${idx === 0 ? 24 : 14} Tf 72 ${760 - idx * 28} Td (${escapePdfText(line)}) Tj ET`)
    .join('\n')
  const stream = `${textOps}\n`
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}endstream\nendobj\n`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'))
    pdf += obj
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8')
  pdf += 'xref\n0 6\n'
  pdf += '0000000000 65535 f \n'
  for (let i = 1; i <= 5; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += 'trailer\n<< /Size 6 /Root 1 0 R >>\n'
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`
  return new Blob([pdf], { type: 'application/pdf' })
}

async function uploadPair() {
  const qpName = `9999_s23_qp_99_${token}.pdf`
  const msName = `9999_s23_ms_99_${token}.pdf`
  const fd = new FormData()
  fd.append('files', makePdf('Question Paper', [`Synthetic QP ${token}`, 'Question 1']), qpName)
  fd.append('files', makePdf('Mark Scheme', [`Synthetic MS ${token}`, 'Answer 1']), msName)
  fd.append('ocr_auto', 'false')
  const data = await api('/upload_pdfs', { method: 'POST', body: fd })
  const papers = Array.isArray(data?.papers) ? data.papers : []
  const qp = papers.find((p) => String(p.filename || '').includes('_qp_'))
  const ms = papers.find((p) => String(p.filename || '').includes('_ms_'))
  if (!qp?.paper_id || !ms?.paper_id) fail('upload qp/ms pair', JSON.stringify(data))
  created.qpId = Number(qp.paper_id)
  created.msId = Number(ms.paper_id)
  check('upload qp/ms pair', true, `qp=${created.qpId} ms=${created.msId}`)
}

async function waitForExport(jobId) {
  const started = Date.now()
  while (Date.now() - started < 60000) {
    const status = await api(`/export/questions_pdf_job/${jobId}`)
    if (status?.status === 'done') return status
    if (status?.status === 'error' || status?.status === 'cancelled') {
      fail('export job completes', JSON.stringify(status))
    }
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  fail('export job completes', 'timeout')
}

async function cleanup() {
  const errors = []
  if (created.qpId != null) {
    const res = await apiMaybe(`/papers/${created.qpId}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) errors.push(`delete qp ${created.qpId}: ${res.status}`)
  }
  if (created.msId != null) {
    const res = await apiMaybe(`/papers/${created.msId}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) errors.push(`delete ms ${created.msId}: ${res.status}`)
  }
  if (created.sectionId != null) {
    const res = await apiMaybe(`/section_defs/${created.sectionId}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) errors.push(`delete section ${created.sectionId}: ${res.status}`)
  }
  if (created.groupId != null) {
    const res = await apiMaybe(`/section_groups/${created.groupId}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) errors.push(`delete group ${created.groupId}: ${res.status}`)
  }
  if (errors.length) check('cleanup', false, errors.join('; '))
  else check('cleanup', true)
}

try {
  const health = await api('/health')
  check('backend health', health?.status === 'ok', JSON.stringify(health))

  const preClean = await api('/maintenance/questions_repair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dry_run: false, remove_orphan_boxes: true }),
  })
  check('pre-clean orphan records', preClean?.ok === true, JSON.stringify(preClean))

  await uploadPair()

  const qpDetail = await api(`/papers/${created.qpId}`)
  const msDetail = await api(`/papers/${created.msId}`)
  check('paper pair linked from qp', Number(qpDetail?.paired_paper_id) === created.msId, JSON.stringify(qpDetail))
  check('paper pair linked from ms', Number(msDetail?.paired_paper_id) === created.qpId, JSON.stringify(msDetail))

  const qpPages = await api(`/papers/${created.qpId}/pages`)
  const msPages = await api(`/papers/${created.msId}/pages`)
  check('qp pages rendered', Array.isArray(qpPages?.pages) && qpPages.pages.length === 1, JSON.stringify(qpPages))
  check('ms pages rendered', Array.isArray(msPages?.pages) && msPages.pages.length === 1, JSON.stringify(msPages))

  const group = await api('/section_groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `E2E Group ${token}`, show_in_filter: true }),
  })
  created.groupId = Number(group?.group?.id)
  check('create section group', Number.isFinite(created.groupId), JSON.stringify(group))

  const section = await api('/section_defs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `E2E Section ${token}`, content: 'api e2e', group_id: created.groupId }),
  })
  created.sectionId = Number(section?.section?.id)
  let sectionName = section?.section?.name
  check('create section def', Number.isFinite(created.sectionId) && !!sectionName, JSON.stringify(section))

  const question = await api(`/papers/${created.qpId}/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sections: [sectionName],
      status: 'confirmed',
      notes: `notes ${token}`,
      boxes: [{ page: 1, bbox: [0.08, 0.12, 0.8, 0.38] }],
    }),
  })
  created.questionId = Number(question?.question?.id)
  const createdSections = question?.question?.sections || []
  check('create question', Number.isFinite(created.questionId), JSON.stringify(question))
  check('question has only created section', createdSections.length === 1 && createdSections.includes(sectionName), JSON.stringify(createdSections))

  const originalSectionName = sectionName
  const renamedSectionName = `${sectionName} Renamed`
  const renamedSection = await api(`/section_defs/${created.sectionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: renamedSectionName, content: 'api e2e renamed', group_id: created.groupId }),
  })
  sectionName = renamedSectionName
  check('rename section def', renamedSection?.section?.name === sectionName, JSON.stringify(renamedSection))
  check('rename section syncs question count', Number(renamedSection?.updated_questions || 0) >= 1, JSON.stringify(renamedSection))

  const questionAfterRename = await api(`/questions/${created.questionId}`)
  const renamedSections = questionAfterRename?.question?.sections || []
  check(
    'renamed section visible on question',
    renamedSections.length === 1 && renamedSections.includes(sectionName)
      && !renamedSections.includes(originalSectionName),
    JSON.stringify(renamedSections),
  )

  const updatedQuestion = await api(`/questions/${created.questionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_favorite: true, notes: `updated ${token}` }),
  })
  check('update question favorite/notes', updatedQuestion?.question?.is_favorite === true && updatedQuestion?.question?.notes === `updated ${token}`, JSON.stringify(updatedQuestion))

  const replaced = await api(`/questions/${created.questionId}/boxes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boxes: [{ page: 1, bbox: [0.1, 0.15, 0.82, 0.42] }] }),
  })
  check('replace question boxes', replaced?.question?.boxes?.length === 1, JSON.stringify(replaced))

  const answer = await api(`/questions/${created.questionId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ms_paper_id: created.msId,
      notes: `answer ${token}`,
      boxes: [{ page: 1, bbox: [0.12, 0.18, 0.78, 0.45] }],
    }),
  })
  check('upsert answer', answer?.answer?.boxes?.length === 1 && Number(answer?.answer?.ms_paper_id) === created.msId, JSON.stringify(answer))

  const search = await api('/questions/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      section: sectionName,
      paper_ids: [created.qpId],
      years: ['23'],
      seasons: ['s'],
      favorite: true,
      page: 1,
      page_size: 10,
    }),
  })
  const found = (search?.questions || []).some((q) => Number(q.id) === created.questionId)
  check('search filters find question', found, JSON.stringify(search))

  const batch = await api('/questions/batch_update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [created.questionId], sections: [sectionName], is_favorite: false }),
  })
  check('batch update question', batch?.ok === true && Number(batch?.updated) === 1, JSON.stringify(batch))

  const randomPick = await api('/random_by_sections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sections: { [sectionName]: 1 }, favorite_only: false, exclude_years: [] }),
  })
  check('random pick by section', (randomPick?.question_ids || []).map(Number).includes(created.questionId), JSON.stringify(randomPick))

  const integrity = await api('/maintenance/questions_integrity')
  check('integrity check returns report', Number.isFinite(Number(integrity?.total_questions)), JSON.stringify(integrity))

  const repairDryRun = await api('/maintenance/questions_repair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dry_run: true, remove_orphan_boxes: true, fill_missing_question_no: true }),
  })
  check('repair dry run returns report', repairDryRun?.ok === true && !!repairDryRun?.report, JSON.stringify(repairDryRun))

  const exportJob = await api('/export/questions_pdf_job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ids: [created.questionId],
      options: {
        include_question_no: true,
        include_section: true,
        include_paper: true,
        include_original_qno: true,
        include_notes: true,
        include_answers: true,
        answers_placement: 'interleaved',
        filter_section: sectionName,
        filename: `api_e2e_${token}`,
        include_filter_summary: true,
        filter_summary_lines: ['Section: e2e', 'Paper: test', 'Year: 2023', 'Season: s', 'Favorites: no', 'Count: 1'],
        crop_workers: 1,
      },
    }),
  })
  created.exportJobId = exportJob?.job_id
  check('create export job', !!created.exportJobId, JSON.stringify(exportJob))
  await waitForExport(created.exportJobId)
  check('export job completes', true, created.exportJobId)

  const pdfRes = await fetch(`${baseUrl}/export/download/${created.exportJobId}`)
  const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer())
  const signature = new TextDecoder('ascii').decode(pdfBytes.slice(0, 5))
  check('download exported pdf', pdfRes.ok && signature === '%PDF-', `${pdfRes.status} ${signature} bytes=${pdfBytes.length}`)
} finally {
  await cleanup()
}

console.log(JSON.stringify({ checks, token, created }, null, 2))

if (checks.some((item) => !item.pass)) {
  process.exitCode = 1
}
