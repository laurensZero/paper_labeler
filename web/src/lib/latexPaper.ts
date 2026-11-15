// LaTeX 试卷版导出：打印 CSS 路线（矢量文本，浏览器打印/另存 PDF）。
//
// 版式对齐 CIE 9709 官方题卷（data/pdfs/paper_6.pdf 版式研究结论）：
//   封面可自定义（标题/副标题/卷号/日期/时长/姓名栏/考试说明）；
//   一题一页，题干上方题号 gutter，题干后答题点线占满余页；
//   图形区按 question_figures bbox 从框图裁切插入（CSS overflow 裁切）；
//   页脚左中右 = 自定义水印 / 卷号 / 页码（@page margin boxes，Chromium 131+）。
//
// 答案暂不含（answer_boxes 无 OCR）；OCR 缺失的题回退整框图模式。
import { renderLatexHtml } from '@/lib/latex'
import renderBodyCss from '../../../shared/latex-render/src/render.css?raw'
import { getSupabase, imageUrl } from '@/lib/supabase'
import type { HeaderFields } from '@/lib/pdfExport'
import type { ExportQuestionInput } from '@/lib/pdfExport'

export interface LatexCover {
  title: string
  subtitle: string
  code: string
  date: string
  duration: string
  showNameField: boolean
  instructions: string
}

export interface LatexPaperOptions {
  cover: LatexCover
  /** 题目来源标注行（沿用图片版式的页眉字段开关） */
  caption: HeaderFields
  /** 页脚左侧水印文本（替代官方 © UCLES；空串不显示） */
  watermark: string
  filename: string
}

interface PaperFigure {
  boxId: number
  bbox: [number, number, number, number]
  kind: 'figure' | 'table'
  fullBox: boolean
  url: string
}

interface PaperQuestion {
  no: number
  qno: string | null
  sections: string[]
  paperLabel: string
  notes: string | null
  /** 渲染好的题干 HTML；null = OCR 缺失，走整框图回退 */
  contentHtml: string | null
  figs: PaperFigure[]
  boxUrls: string[]
  blankPages: number
  isBlankPage: boolean
  /** 框级重建（0016）：框 id（按 page,id 排序）与对应文本；数据齐全时优先走框级流 */
  boxIds?: number[]
  /** 框级文本；undefined = 该框无行（护栏：非 undefined 才算覆盖） */
  boxTexts?: (string | undefined)[]
}

export interface LatexExportProgress {
  (done: number, total: number, phase: 'prepare' | 'question' | 'write'): void
}

// ---------------------------------------------------------------- 数据抓取

interface FigureRow {
  question_id: number
  box_id: number
  ord: number
  bbox: [number, number, number, number]
  kind: 'figure' | 'table'
  full_box: boolean
}

/** 批量拉 OCR 文本；0012 未执行时整体降级（全走图片回退） */
async function fetchOcr(qids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  if (!qids.length) return map
  try {
    const { data, error } = await getSupabase()
      .from('question_ocr')
      .select('question_id,content')
      .in('question_id', qids)
    if (error) throw error
    for (const r of (data ?? []) as { question_id: number; content: string }[]) {
      if (r.content) map.set(r.question_id, r.content)
    }
  } catch (e) {
    console.warn('[latexPaper] question_ocr 拉取失败，全部走图片回退', e)
  }
  return map
}

/** 批量拉图形区元数据；0015 未执行时降级为无图 */
async function fetchFigures(qids: number[]): Promise<Map<number, PaperFigure[]>> {
  const map = new Map<number, PaperFigure[]>()
  if (!qids.length) return map
  try {
    const supa = getSupabase()
    const { data: figs, error } = await supa
      .from('question_figures')
      .select('question_id,box_id,ord,bbox,kind,full_box')
      .in('question_id', qids)
      .order('box_id')
      .order('ord')
    if (error) throw error
    const boxIds = [...new Set((figs ?? []).map((f: FigureRow) => f.box_id))]
    const keyById = new Map<number, string>()
    for (let i = 0; i < boxIds.length; i += 200) {
      const chunk = boxIds.slice(i, i + 200)
      const { data: boxes, error: bErr } = await supa
        .from('question_boxes')
        .select('id,image_key')
        .in('id', chunk)
      if (bErr) throw bErr
      for (const b of (boxes ?? []) as { id: number; image_key: string }[]) {
        keyById.set(b.id, b.image_key)
      }
    }
    for (const f of (figs ?? []) as FigureRow[]) {
      const key = keyById.get(f.box_id)
      if (!key) continue
      const list = map.get(f.question_id) ?? []
      list.push({
        boxId: f.box_id,
        bbox: f.bbox,
        kind: f.kind ?? 'figure',
        fullBox: !!f.full_box,
        url: imageUrl(key),
      })
      map.set(f.question_id, list)
    }
  } catch (e) {
    console.warn('[latexPaper] question_figures 拉取失败，按无图渲染', e)
  }
  return map
}

/** 批量拉框列表（按 page,id 排序）——框级题面流重建的骨架 */
async function fetchBoxes(qids: number[]): Promise<Map<number, { id: number; page: number }[]>> {
  const map = new Map<number, { id: number; page: number }[]>()
  if (!qids.length) return map
  try {
    const { data, error } = await getSupabase()
      .from('question_boxes')
      .select('id,question_id,page')
      .in('question_id', qids)
      .order('page')
      .order('id')
    if (error) throw error
    for (const b of (data ?? []) as { id: number; question_id: number; page: number }[]) {
      const list = map.get(b.question_id) ?? []
      list.push({ id: b.id, page: b.page })
      map.set(b.question_id, list)
    }
  } catch (e) {
    console.warn('[latexPaper] question_boxes 拉取失败', e)
  }
  return map
}

/** 批量拉框级文本（0016）；未执行/未回填时降级为合并文本模式 */
async function fetchBoxOcr(qids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  if (!qids.length) return map
  try {
    const { data, error } = await getSupabase()
      .from('question_box_ocr')
      .select('box_id,content')
      .in('question_id', qids)
    if (error) throw error
    for (const r of (data ?? []) as { box_id: number; content: string }[]) {
      map.set(r.box_id, r.content ?? '')
    }
  } catch (e) {
    console.warn('[latexPaper] question_box_ocr 拉取失败（0016 未执行？），走合并文本模式', e)
  }
  return map
}

// ---------------------------------------------------------------- 图片尺寸

const imgSizeCache = new Map<string, Promise<{ w: number; h: number }>>()

function loadImgSize(url: string): Promise<{ w: number; h: number }> {
  let p = imgSizeCache.get(url)
  if (p) return p
  p = new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 })
    img.onerror = () => resolve({ w: 1, h: 1 })
    img.src = url
  })
  imgSizeCache.set(url, p)
  return p
}

// ---------------------------------------------------------------- HTML 组装

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escCss(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
}

/** 框图裁切：框图视为通栏（宽 = 190mm 正文宽），bbox 按占比换算成 mm，
 *  容器 overflow hidden + img 绝对定位负偏移实现 CSS 裁切 */
function figureHtml(f: PaperFigure, naturalW: number): string {
  if (f.fullBox) {
    return `<figure class="lp-fig"><img src="${f.url}" style="width:100%"></figure>`
  }
  const [fx, fy, fw, fh] = f.bbox
  const mmPerPx = 190 / Math.max(naturalW, 1)
  let w = fw * mmPerPx
  const scale = Math.min(w, 160) / w // 超宽夹到 160mm
  w = Math.max(w * scale, 18)
  const h = fh * mmPerPx * scale
  const imgW = naturalW * mmPerPx * scale
  const left = -fx * mmPerPx * scale
  const top = -fy * mmPerPx * scale
  return (
    `<figure class="lp-fig" style="width:${w.toFixed(1)}mm;height:${h.toFixed(1)}mm">` +
    `<img src="${f.url}" style="width:${imgW.toFixed(1)}mm;left:${left.toFixed(1)}mm;top:${top.toFixed(1)}mm"></figure>`
  )
}

function captionHtml(q: PaperQuestion, caption: HeaderFields): string {
  const parts: string[] = []
  if (caption.paper && q.paperLabel) parts.push(escHtml(q.paperLabel))
  if (caption.section && q.sections.length) parts.push(escHtml(q.sections.join(' / ')))
  if (caption.qno && q.no != null) parts.push(`Q${q.no}`)
  if (caption.originalQno && q.qno) parts.push(`原卷 ${escHtml(q.qno)}`)
  if (!parts.length) return ''
  return `<div class="lp-cap">${parts.join(' · ')}</div>`
}

function questionPageHtml(q: PaperQuestion, opts: LatexPaperOptions, sizes: Map<string, { w: number; h: number }>): string {
  if (q.isBlankPage) return `<section class="lp-q lp-blank"></section>`
  const cap = captionHtml(q, opts.caption)
  const notes = q.notes && opts.caption.notes
    ? `<div class="lp-notes">备注：${escHtml(q.notes)}</div>`
    : ''

  const boxMode = !!q.boxIds?.length && !!q.boxTexts?.length &&
    q.boxIds.every((_, i) => q.boxTexts![i] !== undefined)
  let body: string
  if (boxMode) {
    // 框级重建（0016 数据齐全）：按框顺序 框文本 ↔ 框图形 精确穿插。
    // 框内位置用启发式：图形 bbox 在框图顶部 35% 内 → 框文本前（官方卷图形通常在上方）。
    const raw = q.boxIds!.map((_, i) => q.boxTexts![i]!).join('\n')
    const hasMdTable = /\|\s*-{3,}/.test(raw) // OCR 已有 Markdown 表格 → table 区去重
    const parts: string[] = []
    for (let i = 0; i < q.boxIds!.length; i++) {
      const boxId = q.boxIds![i]
      const figs = q.figs.filter((f) => f.boxId === boxId && !(f.kind === 'table' && hasMdTable))
      const boxH = figs.length ? (sizes.get(figs[0].url)?.h ?? 1) : 1
      const top = figs
        .filter((f) => !f.fullBox && f.bbox[1] / Math.max(boxH, 1) < 0.35)
        .map((f) => figureHtml(f, sizes.get(f.url)?.w ?? 1))
      const bottom = figs
        .filter((f) => f.fullBox || f.bbox[1] / Math.max(boxH, 1) >= 0.35)
        .map((f) => figureHtml(f, f.fullBox ? 1 : (sizes.get(f.url)?.w ?? 1)))
      const text = q.boxTexts![i]!.trim()
      if (top.length) parts.push(top.join('\n'))
      if (text) parts.push(`<div class="latex-body lp-stem">${renderLatexHtml(text)}</div>`)
      if (bottom.length) parts.push(bottom.join('\n'))
    }
    body = parts.length
      ? parts.join('\n') + (notes ? `\n${notes}` : '')
      : q.boxUrls.map((u) => `<figure class="lp-fig"><img src="${u}" style="width:100%"></figure>`).join('\n')
  } else if (q.contentHtml) {
    // 合并文本模式（0016 未回填/框数不齐的题）：图形 bbox 在框顶 35% 内 → 题干前
    const hasMdTable = q.contentHtml.includes('<table')
    const alive = q.figs.filter((f) => !(f.kind === 'table' && hasMdTable))
    const before = alive
      .filter((f) => !f.fullBox && f.bbox[1] / Math.max(sizes.get(f.url)?.h ?? 1, 1) < 0.35)
      .map((f) => figureHtml(f, sizes.get(f.url)?.w ?? 1))
      .join('\n')
    const after = alive
      .filter((f) => f.fullBox || f.bbox[1] / Math.max(sizes.get(f.url)?.h ?? 1, 1) >= 0.35)
      .map((f) => figureHtml(f, f.fullBox ? 1 : sizes.get(f.url)?.w ?? 1))
      .join('\n')
    body =
      (before ? `${before}\n` : '') +
      `<div class="latex-body lp-stem">${q.contentHtml}</div>` +
      (after ? `\n${after}` : '') +
      notes
  } else {
    // OCR 缺失 / 纯图形题：整框图回退
    body = q.boxUrls.map((u) => `<figure class="lp-fig"><img src="${u}" style="width:100%"></figure>`).join('\n') + notes
  }
  return (
    `<section class="lp-q">` +
    cap +
    `<div class="lp-body"><div class="lp-no">${q.no}</div><div class="lp-main">${body}<div class="lp-ans"></div></div></div>` +
    `</section>`
  )
}

function coverHtml(cover: LatexCover): string {
  const right = [cover.code, cover.date, cover.duration].map((s) => s.trim()).filter(Boolean)
  const title = cover.title.trim()
  const subtitle = cover.subtitle.trim()
  const instructions = cover.instructions.trim()
  return (
    `<section class="lp-cover">` +
    (title ? `<h1 class="lp-cover-title">${escHtml(title)}</h1>` : '') +
    (subtitle ? `<div class="lp-cover-sub">${escHtml(subtitle)}</div>` : '') +
    (right.length
      ? `<div class="lp-cover-right">${right.map((s) => `<div>${escHtml(s)}</div>`).join('')}</div>`
      : '') +
    (cover.showNameField
      ? `<div class="lp-cover-name"><span>CANDIDATE NAME</span><div class="lp-cover-box"></div></div>`
      : '') +
    (instructions ? `<div class="lp-cover-instructions">${escHtml(instructions).replace(/\n/g, '<br>')}</div>` : '') +
    `</section>`
  )
}

const PAPER_CSS = `
  /* 官方 Times 风字体：STIX Two（Times 兼容设计）覆盖 KaTeX 的 CM 字形。
     只换 KaTeX_Main / KaTeX_Math 两族（字母数字运算符），Size/AMS 等符号保持 CM。 */
  @font-face { font-family: 'KaTeX_Main'; font-weight: 100 900; font-style: normal;
    src: url('__FB__STIXTwoText.ttf') format('truetype-variations'); }
  @font-face { font-family: 'KaTeX_Main'; font-weight: 100 900; font-style: italic;
    src: url('__FB__STIXTwoText-Italic.ttf') format('truetype-variations'); }
  @font-face { font-family: 'KaTeX_Math'; font-weight: 100 900; font-style: italic;
    src: url('__FB__STIXTwoMath-Regular.ttf') format('truetype-variations'); }
  @font-face { font-family: 'SimHei'; font-weight: 100 900; font-style: normal;
    src: url('__FB__simhei.ttf') format('truetype'); }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page {
    size: A4;
    margin: 16mm 16mm 18mm 16mm;
    @top-center { content: counter(page); font: 10pt 'Times New Roman', serif; }
    @bottom-left { content: "__WM__"; font: 9pt 'Times New Roman', serif; color: #666; }
    @bottom-center { content: "__CODE__"; font: 10pt 'Times New Roman', serif; }
  }
  @page :first {
    @top-center { content: ""; }
    @bottom-left { content: ""; }
    @bottom-center { content: ""; }
  }
  html, body { background: #fff; }
  /* 正文与公式同源（Times 系）：KaTeX_Main 已被 STIX Two 覆盖，见顶部 @font-face */
  body { font-family: 'KaTeX_Main', 'Times New Roman', 'SimHei', serif; font-size: 11pt; color: #000; }

  .lp-cover { page-break-after: always; padding-top: 24mm; }
  .lp-cover-title { font-size: 15pt; font-weight: bold; letter-spacing: .02em; }
  .lp-cover-sub { font-size: 11.5pt; font-weight: bold; margin-top: 6mm; }
  .lp-cover-right { margin-top: 14mm; text-align: right; }
  .lp-cover-right div { font-weight: bold; margin-bottom: 3mm; }
  .lp-cover-name { display: flex; align-items: center; gap: 4mm; margin-top: 14mm; }
  .lp-cover-name span { font-size: 10pt; white-space: nowrap; }
  .lp-cover-box { flex: 1; height: 16mm; border: 1.2pt solid #000; }
  .lp-cover-instructions { border-top: 1.2pt solid #000; margin-top: 16mm; padding-top: 8mm;
    font-size: 10pt; line-height: 1.55; }

  .lp-q { height: 261mm; display: flex; flex-direction: column; break-after: page; }
  .lp-blank { }
  .lp-cap { font-size: 8pt; color: #666; text-align: right; margin-bottom: 4mm; }
  .lp-body { display: flex; gap: 3mm; flex: 1; min-height: 0; }
  .lp-no { min-width: 8mm; font-weight: bold; font-size: 11.5pt; }
  .lp-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }

  .lp-stem p { margin: 0 0 3.2mm; }
  .lp-stem table { border-collapse: collapse; margin: 2mm 0 4mm; font-size: 10pt; }
  .lp-stem td, .lp-stem th { border: 0.6pt solid #000; padding: 1mm 3mm; }
  .lp-notes { font-size: 9pt; color: #555; margin-top: 2mm; }

  .lp-fig { margin: 3mm auto 4mm; overflow: hidden; page-break-inside: avoid; }
  .lp-fig img { position: absolute; }
  .lp-fig { position: relative; }

  /* 答题点线暂不启用（先留白不放线）；如需恢复用径向渐变点阵占满余页 */
  .lp-ans { flex: 1 0 auto; min-height: 0; }
`

function buildCss(opts: LatexPaperOptions, fontBase: string): string {
  return (
    // 空值用 "" 而非 none：Chromium margin box 会把 none 渲染成字面 "none"
    PAPER_CSS.replace('__WM__', opts.watermark.trim() ? `"${escCss(opts.watermark.trim())}"` : '""')
      .replace('__CODE__', opts.cover.code.trim() ? `"${escCss(opts.cover.code.trim())}"` : '""')
      .replaceAll('__FB__', fontBase)
      + '\n' + renderBodyCss
  )
}

// ---------------------------------------------------------------- 主流程

export async function exportLatexPaper(
  items: ExportQuestionInput[],
  opts: LatexPaperOptions,
  progress?: LatexExportProgress,
): Promise<number> {
  const qs = items.filter((i) => !i.isBlankPage && i.id > 0)
  const qids = [...new Set(qs.map((i) => i.id))]
  progress?.(0, qs.length, 'prepare')
  const [ocrMap, figMap, boxMap, boxOcrMap] = await Promise.all([
    fetchOcr(qids),
    fetchFigures(qids),
    fetchBoxes(qids),
    fetchBoxOcr(qids),
  ])

  // 需要裁切的框图 URL → 预载自然尺寸（裁切换算依赖框图宽度）
  const cropUrls = new Set<string>()
  for (const figs of figMap.values()) for (const f of figs) if (!f.fullBox) cropUrls.add(f.url)
  const sizes = new Map<string, { w: number; h: number }>()
  await Promise.all([...cropUrls].map(async (u) => sizes.set(u, await loadImgSize(u))))

  let no = 0
  const pages: string[] = [coverHtml(opts.cover)]
  for (const it of items) {
    if (it.isBlankPage) {
      pages.push(`<section class="lp-q lp-blank"></section>`)
      continue
    }
    no += 1
    const content = ocrMap.get(it.id) ?? ''
    // 框级重建（0016）：框文本行覆盖该题全部框时走框级流，否则回退合并文本
    const boxes = boxMap.get(it.id)
    const q: PaperQuestion = {
      no,
      qno: it.questionNo,
      sections: it.sections,
      paperLabel: it.paperLabel,
      notes: it.notes,
      contentHtml: content ? renderLatexHtml(content) : null,
      figs: figMap.get(it.id) ?? [],
      boxUrls: it.boxes.map((b) => b.url),
      blankPages: it.blankPages || 0,
      isBlankPage: false,
      boxIds: boxes?.map((b) => b.id),
      boxTexts: boxes?.map((b) => boxOcrMap.get(b.id)),
    }
    progress?.(no, qs.length, 'question')
    pages.push(questionPageHtml(q, opts, sizes))
    for (let i = 0; i < q.blankPages; i++) pages.push(`<section class="lp-q lp-blank"></section>`)
  }

  // KaTeX 资源取自本站 public/katex/（同源、离线可用；字体随 css 相对引用）。
  // 必须用 origin 绝对路径：baseURI 在 /compose/{id} 等带路径页面下会把
  // 相对路径解析成 /compose/katex/... → 404 → SPA 兜底 HTML → KaTeX CSS 缺失
  const katexCssUrl = new URL('/katex/katex.min.css', location.origin).href
  const fontBase = new URL('/fonts/', location.origin).href
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(opts.filename)}</title>` +
    `<link rel="stylesheet" href="${escHtml(katexCssUrl)}">` +
    `<style>${buildCss(opts, fontBase)}</style></head><body>${pages.join('\n')}</body></html>`

  progress?.(qs.length, qs.length, 'write')
  await printHtml(html)
  return pages.length
}

/** 隐藏 iframe 装载试卷并调起系统打印（另存 PDF 即得矢量文件） */
function printHtml(html: string): Promise<void> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
      setTimeout(() => iframe.remove(), 10 * 60 * 1000)
    }
    iframe.onload = async () => {
      try {
        await iframe.contentWindow?.document.fonts?.ready
        await new Promise((r) => setTimeout(r, 300)) // KaTeX 字体就位缓冲
        iframe.contentWindow!.onafterprint = finish
        iframe.contentWindow!.print()
        setTimeout(finish, 5 * 60 * 1000) // 用户不打印直接关掉的兜底
      } catch {
        finish()
      }
    }
    document.body.appendChild(iframe)
    iframe.srcdoc = html
  })
}
