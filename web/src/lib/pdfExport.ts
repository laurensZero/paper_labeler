// 浏览器端 PDF 导出引擎
// 版式严格对齐管理端 backend/routers/export.py::_make_pdf（mm 制、边框到页底、
// 70% 续页、答案自动分页缩放、首页信息页/封面页、页码偏移）。
// 图片链路：R2 webp → createImageBitmap → canvas → JPEG → pdf-lib 嵌入。
import { PDFDocument, PDFFont, PDFImage, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

const MM = 72 / 25.4
const mm = (v: number) => v * MM
const A4_W = mm(210)
const A4_H = mm(297)
const CONTENT_X = 15
const PAGE_BOTTOM = 282
const BOX_X = 13
const BOX_W = 184
const PX_TO_MM = 25.4 / 96 // 与管理端 0.264583 一致：96dpi 物理尺寸

const GRAY = rgb(0.5, 0.5, 0.5)
const LIGHT_GRAY = rgb(200 / 255, 200 / 255, 200 / 255)
const BLACK = rgb(0, 0, 0)

export interface HeaderFields {
  qno: boolean
  section: boolean
  paper: boolean
  originalQno: boolean
  notes: boolean
}

export interface ExportProgress {
  (done: number, total: number, phase: string): void
}

export interface ExportCommonOptions {
  includeAnswers: boolean
  answersPlacement: 'end' | 'interleaved'
  header: HeaderFields
  includeFilterSummary: boolean
  filterSummaryLines: string[]
  filename: string
  showPageNumbers: boolean
  /** 组卷模式 */
  title?: string
  headerText?: string
  coverLines?: string[]
  /** 模块显示名映射（组名前缀规则与管理端一致） */
  sectionLabel?: (name: string) => string
  progress?: ExportProgress
  /** 取消开关：置 true 后在下一个检查点中断 */
  cancel?: { value: boolean }
}

export interface ExportBox {
  url: string
}

export interface ExportQuestionInput {
  id: number
  questionNo: string | null
  sections: string[]
  paperLabel: string
  notes: string | null
  boxes: ExportBox[]
  answerBoxes: ExportBox[]
  /** 附属空白页（组卷） */
  blankPages: number
  /** 独立空白页条目（组卷 blank_page item）标记为 null id 时仅出空白页 */
  isBlankPage?: boolean
}

let fontBytesPromise: Promise<Uint8Array> | null = null

/** JPEG 字节缓存：同 URL 的图跨导出复用，免重复下载+编码 */
const jpegBytesCache = new Map<string, Uint8Array>()

function cancelledError(): Error {
  const err = new Error('cancelled')
  err.name = 'ExportCancelled'
  return err
}

function assertNotCancelled(cancel?: { value: boolean }) {
  if (cancel?.value) throw cancelledError()
}

async function loadCjkFontBytes(): Promise<Uint8Array> {
  if (!fontBytesPromise) {
    fontBytesPromise = fetch('/fonts/simhei.ttf').then(async (r) => {
      if (!r.ok) throw new Error(`字体加载失败: ${r.status}`)
      return new Uint8Array(await r.arrayBuffer())
    })
  }
  return fontBytesPromise
}

function sanitizeFilename(name: string): string {
  const base = (name || '').trim().replace(/[\\/:*?"<>|]/g, '_') || 'export'
  return base.endsWith('.pdf') ? base : `${base}.pdf`
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

interface EmbeddedImg {
  image: PDFImage
  wPx: number
  hPx: number
}

/** 下载 + 转 JPEG 字节（带缓存）。优先 OffscreenCanvas.convertToBlob（比 toDataURL+atob 快）。 */
async function urlToJpegBytes(url: string): Promise<Uint8Array | null> {
  const hit = jpegBytesCache.get(url)
  if (hit) return hit
  try {
    let res: Response
    try {
      res = await fetch(url)
    } catch {
      // 浏览器可能缓存了 <img>（无 Origin）的无 ACAO 响应，fetch 复用即被 CORS 拦。
      // 绕过本地缓存回源，边缘会按 Origin 补上 ACAO。
      res = await fetch(url, { cache: 'no-store' })
    }
    if (!res.ok) return null
    const blob = await res.blob()
    const bmp = await createImageBitmap(blob)
    let bytes: Uint8Array | null = null
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(bmp, 0, 0)
        bmp.close()
        const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
        bytes = new Uint8Array(await out.arrayBuffer())
      } else {
        bmp.close()
      }
    } else {
      const canvas = document.createElement('canvas')
      canvas.width = bmp.width
      canvas.height = bmp.height
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(bmp, 0, 0)
        bytes = b64ToBytes(canvas.toDataURL('image/jpeg', 0.9).split(',')[1] || '')
      }
      bmp.close()
      canvas.width = 0
      canvas.height = 0
    }
    if (bytes) jpegBytesCache.set(url, bytes)
    return bytes
  } catch {
    return null
  }
}

/** 并行预取（默认 6 路），布局阶段只做 embed（很快） */
async function prefetchJpegs(urls: string[], cancel?: { value: boolean }): Promise<void> {
  const queue = [...new Set(urls)]
  const workerCount = Math.max(1, Math.min(6, queue.length))
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      assertNotCancelled(cancel)
      const url = queue.shift()
      if (!url) break
      if (!jpegBytesCache.has(url)) await urlToJpegBytes(url)
    }
  })
  await Promise.all(workers)
}

async function fetchAsJpeg(doc: PDFDocument, url: string): Promise<EmbeddedImg | null> {
  try {
    const bytes = await urlToJpegBytes(url)
    if (!bytes) return null
    const image = await doc.embedJpg(bytes)
    return { image, wPx: image.width, hPx: image.height }
  } catch {
    return null
  }
}

/** 与管理端一致的渲染尺寸（mm）：96dpi 物理宽，上限 180mm */
function renderSize(img: EmbeddedImg): { w: number; h: number } {
  const w = Math.min(180, img.wPx * PX_TO_MM)
  const h = w * (img.hPx / img.wPx)
  return { w, h }
}

function drawCenteredText(
  page: import('pdf-lib').PDFPage,
  text: string,
  font: PDFFont,
  size: number,
  topMm: number,
  widthMm: number,
  xMm: number,
  color = BLACK,
) {
  const width = font.widthOfTextAtSize(text, size)
  const x = mm(xMm) + (mm(widthMm) - width) / 2
  page.drawText(text, { x, y: A4_H - mm(topMm) - size, size, font, color })
}

function drawBorder(
  page: import('pdf-lib').PDFPage,
  xMm: number,
  topMm: number,
  wMm: number,
  hMm: number,
  color = BLACK,
) {
  page.drawRectangle({
    x: mm(xMm),
    y: A4_H - mm(topMm) - mm(hMm),
    width: mm(wMm),
    height: mm(hMm),
    borderColor: color,
    borderWidth: 1,
  })
}

function drawLine(
  page: import('pdf-lib').PDFPage,
  x1Mm: number,
  topMm: number,
  x2Mm: number,
  color = LIGHT_GRAY,
) {
  page.drawLine({
    start: { x: mm(x1Mm), y: A4_H - mm(topMm) },
    end: { x: mm(x2Mm), y: A4_H - mm(topMm) },
    thickness: 0.7,
    color,
  })
}

function headerLine(opts: ExportCommonOptions, seq: number, q: ExportQuestionInput, extra?: string): string {
  const parts: string[] = []
  if (opts.header.qno) parts.push(`Q${seq}`)
  if (opts.header.originalQno && q.questionNo) parts.push(`[${q.questionNo}]`)
  if (opts.header.section) {
    const label = opts.sectionLabel ?? ((n: string) => n)
    parts.push(q.sections.length ? q.sections.map(label).join(', ') : '未分类')
  }
  if (opts.header.paper && q.paperLabel) parts.push(q.paperLabel)
  if (opts.header.notes && q.notes) parts.push(`备注: ${q.notes}`)
  if (extra) parts.push(extra)
  return parts.join(' - ')
}

export async function buildQuestionsPdf(
  list: ExportQuestionInput[],
  opts: ExportCommonOptions,
): Promise<{ blob: Blob; filename: string; pageCount: number }> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const fontBytes = await loadCjkFontBytes()
  const font = await doc.embedFont(fontBytes, { subset: true })

  const progress = opts.progress ?? (() => {})
  const hasTitlePage = !!(opts.title?.trim() || (opts.coverLines?.length ?? 0) > 0)
  const frontPages = (opts.includeFilterSummary ? 1 : 0) + (hasTitlePage ? 1 : 0)

  const questions = list.filter((q) => !q.isBlankPage)
  const blankOnlyCount = list.filter((q) => q.isBlankPage).length
  const totalUnits =
    questions.length + (opts.includeAnswers ? questions.length : 0) + frontPages + blankOnlyCount + 2
  let done = 0
  const report = async (phase: string) => {
    assertNotCancelled(opts.cancel)
    done += 1
    progress(Math.min(done, totalUnits), totalUnits, phase)
    await tick()
  }

  // 图片并行预取（与首页绘制重叠），布局阶段直接命中字节缓存
  const allUrls = list.flatMap((i) => [...i.boxes, ...i.answerBoxes].map((b) => b.url))
  const prefetch = prefetchJpegs(allUrls, opts.cancel)

  // ---- 首页：筛选信息 ----
  if (opts.includeFilterSummary) {
    const page = doc.addPage([A4_W, A4_H])
    const lines = (opts.filterSummaryLines || []).map((s) => s.trim()).filter(Boolean)
    const info = lines.length ? lines : ['(无筛选条件)']
    drawBorder(page, BOX_X, 12, BOX_W, 297 - 20)
    const lineH = 14
    const totalH = info.length * lineH
    let top = 12 + Math.max(8, (297 - 20 - totalH) / 2)
    for (const line of info) {
      drawCenteredText(page, line, font, 18, top + (lineH - 18) / 2, BOX_W, BOX_X)
      top += lineH
    }
    await report('front')
  }

  // ---- 封面 / 标题页 ----
  if (hasTitlePage) {
    const page = doc.addPage([A4_W, A4_H])
    drawBorder(page, BOX_X, 12, BOX_W, 297 - 20)
    type Row = { size: number; text: string; h: number; gap: number }
    const rows: Row[] = []
    if (opts.title?.trim()) rows.push({ size: 24, text: opts.title.trim(), h: 16, gap: 0 })
    if (opts.headerText?.trim()) rows.push({ size: 12, text: opts.headerText.trim(), h: 12, gap: 8 })
    ;(opts.coverLines ?? []).forEach((line, i) => {
      if (!line.trim()) return
      rows.push({ size: 13, text: line, h: 14, gap: i === 0 ? 16 : 4 })
    })
    const totalH = rows.reduce((s, r) => s + r.h + r.gap, 0)
    const boxH = 297 - 20
    let top = 12 + Math.max(10, (boxH - totalH) / 2)
    if (top + totalH > 12 + boxH - 10) top = 12 + Math.max(8, boxH - 10 - totalH)
    for (const row of rows) {
      top += row.gap
      drawCenteredText(page, row.text, font, row.size, top + (row.h - row.size) / 2, BOX_W, BOX_X)
      top += row.h
    }
    await report('cover')
  }

  // 等图片就绪（预取期间已画完首页）
  await prefetch
  await report('prepare')

  // ---- 题目 / 答案渲染 ----
  async function drawImageAt(
    page: import('pdf-lib').PDFPage,
    img: EmbeddedImg,
    leftTop: { xMm: number; topMm: number },
    forceW?: number,
    forceH?: number,
  ): Promise<{ w: number; h: number }> {
    const size = renderSize(img)
    const w = forceW ?? size.w
    const h = forceH ?? size.h
    page.drawImage(img.image, {
      x: mm(leftTop.xMm),
      y: A4_H - mm(leftTop.topMm) - mm(h),
      width: mm(w),
      height: mm(h),
    })
    return { w, h }
  }

  async function renderQuestion(q: ExportQuestionInput, seq: number): Promise<number> {
    assertNotCancelled(opts.cancel)
    // 返回使用的图片数（无图跳过，与管理端一致）
    const imgs: EmbeddedImg[] = []
    for (const b of q.boxes) {
      const im = await fetchAsJpeg(doc, b.url)
      if (im) imgs.push(im)
    }
    if (!imgs.length) return 0

    const page = doc.addPage([A4_W, A4_H])
    let top = 15
    if (opts.headerText?.trim()) {
      drawCenteredText(page, opts.headerText.trim(), font, 8, top + 1, BOX_W, BOX_X, GRAY)
      top += 8 // cell 6 + ln 2
    }
    const head = headerLine(opts, seq, q)
    if (head) {
      page.drawText(head, { x: mm(CONTENT_X), y: A4_H - mm(top) - 11, size: 11, font, color: BLACK })
      top += 10 // cell 8 + ln 2
    }
    const startY = top
    let cur = startY
    let maxW = 0
    for (const im of imgs) {
      const { w, h } = renderSize(im)
      await drawImageAt(page, im, { xMm: CONTENT_X, topMm: cur })
      cur += h + 2
      maxW = Math.max(maxW, w)
    }
    // 边框：从内容顶部延伸到页底（管理端规则）
    drawBorder(page, CONTENT_X - 2, startY - 2, maxW + 4, PAGE_BOTTOM - startY + 2)
    drawLine(page, CONTENT_X, cur + 3, CONTENT_X + maxW)

    const avail = PAGE_BOTTOM - startY
    const contentH = cur - startY
    if (avail > 0 && contentH / avail >= 0.7) {
      // ≥70% 高度：追加一页同款边框（管理端的续题空白页）
      const p2 = doc.addPage([A4_W, A4_H])
      drawBorder(p2, CONTENT_X - 2, startY - 2, maxW + 4, PAGE_BOTTOM - startY + 2)
    }
    return imgs.length
  }

  async function renderAnswer(q: ExportQuestionInput, seq: number): Promise<number> {
    assertNotCancelled(opts.cancel)
    const imgs: EmbeddedImg[] = []
    for (const b of q.answerBoxes) {
      const im = await fetchAsJpeg(doc, b.url)
      if (im) imgs.push(im)
    }
    if (!imgs.length) return 0

    let continued = false
    let page = doc.addPage([A4_W, A4_H])
    let top = 15
    const drawHead = () => {
      const text = headerLine(opts, seq, q, continued ? 'continued' : undefined)
      if (text) {
        page.drawText(text, { x: mm(CONTENT_X), y: A4_H - mm(top) - 11, size: 11, font })
        top += 10
      }
    }
    drawHead()
    let startY = top
    let cur = startY
    let maxW = 0

    const finishPage = () => {
      if (cur <= startY) return
      const totalH = Math.max(0, cur - startY - 2) // 管理端 inter_gap=2mm
      drawBorder(page, CONTENT_X - 2, startY - 2, maxW + 4, totalH + 4)
    }

    for (const im of imgs) {
      const size = renderSize(im)
      const avail = PAGE_BOTTOM - cur
      if (cur > startY && size.h > avail) {
        finishPage()
        continued = true
        page = doc.addPage([A4_W, A4_H])
        top = 15
        drawHead()
        startY = top
        cur = startY
        maxW = 0
      }
      let w = size.w
      let h = size.h
      const avail2 = PAGE_BOTTOM - cur
      if (h > avail2 && avail2 > 5) {
        const scale = avail2 / h
        h = avail2
        w = Math.max(10, w * scale)
      }
      page.drawImage(im.image, {
        x: mm(CONTENT_X),
        y: A4_H - mm(cur) - mm(h),
        width: mm(w),
        height: mm(h),
      })
      cur += h + 2
      maxW = Math.max(maxW, w)
    }
    finishPage()
    return imgs.length
  }

  function renderBlankPage() {
    const page = doc.addPage([A4_W, A4_H])
    drawBorder(page, BOX_X, 12, BOX_W, 297 - 20, LIGHT_GRAY)
  }

  // 主循环（与管理端一致：interleaved / end 两种顺序；独立空白页按原顺序插入）
  const hasInlineBlanks = list.some((q) => q.isBlankPage)
  if (opts.answersPlacement === 'interleaved' && opts.includeAnswers && !hasInlineBlanks) {
    let seq = 0
    for (const q of questions) {
      seq += 1
      await renderQuestion(q, seq)
      await report('question')
      await renderAnswer(q, seq)
      await report('answer')
      for (let i = 0; i < (q.blankPages || 0); i++) {
        renderBlankPage()
        await report('blank')
      }
    }
  } else if (hasInlineBlanks) {
    // 组卷：严格按条目顺序（含独立空白页）
    let seq = 0
    for (const item of list) {
      if (item.isBlankPage) {
        renderBlankPage()
        await report('blank')
        continue
      }
      seq += 1
      await renderQuestion(item, seq)
      await report('question')
      if (opts.includeAnswers && opts.answersPlacement === 'interleaved') {
        await renderAnswer(item, seq)
        await report('answer')
      }
      for (let i = 0; i < (item.blankPages || 0); i++) {
        renderBlankPage()
        await report('blank')
      }
    }
    if (opts.includeAnswers && opts.answersPlacement === 'end') {
      let seq2 = 0
      for (const item of list) {
        if (item.isBlankPage) continue
        seq2 += 1
        await renderAnswer(item, seq2)
        await report('answer')
      }
    }
  } else {
    let seq = 0
    for (const q of questions) {
      seq += 1
      await renderQuestion(q, seq)
      await report('question')
      for (let i = 0; i < (q.blankPages || 0); i++) {
        renderBlankPage()
        await report('blank')
      }
    }
    if (opts.includeAnswers) {
      let seq2 = 0
      for (const q of questions) {
        seq2 += 1
        await renderAnswer(q, seq2)
        await report('answer')
      }
    }
  }

  // ---- 页码（与管理端一致：跳过首页数、灰8居中） ----
  if (opts.showPageNumbers) {
    const pages = doc.getPages()
    pages.forEach((page, idx) => {
      const display = idx + 1 - frontPages
      if (display <= 0) return
      const text = String(display)
      drawCenteredText(page, text, font, 8, 297 - 10, BOX_W, BOX_X, GRAY)
    })
  }

  await report('write')
  const bytes = await doc.save()
  const ab = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(ab).set(bytes)
  return {
    blob: new Blob([ab], { type: 'application/pdf' }),
    filename: sanitizeFilename(opts.filename),
    pageCount: doc.getPageCount(),
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
