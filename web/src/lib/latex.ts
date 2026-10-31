import katex from 'katex'
import 'katex/dist/katex.min.css'

/**
 * OCR 文本（Markdown + LaTeX）渲染工具。
 *
 * OCR 输出的公式分隔符偶有错配（如 `\[...,$` 换行 `$...\]`），
 * normalizeLatexDelimiters 用状态机把所有定界符归一成 `\( \)` / `\[ \]`：
 *   - 显示块内出现 `$` 一律丢弃（错配对的残片）；
 *   - 行内 `$` 找不到同行配对时视为游离字符丢弃；
 *   - 未闭合的块按上下文补全，保证 katex 不吃进整段文本。
 */

type MathMode = 'out' | 'display' | 'inline'

interface MathSegment {
  kind: 'text'
  value: string
}

interface Segments {
  parts: (MathSegment | { kind: 'math'; tex: string; display: boolean })[]
  tail: MathMode
}

/** 按定界符切分（内部；输入假定分隔符合法） */
function splitSegments(src: string): Segments {
  const parts: Segments['parts'] = []
  let mode: MathMode = 'out'
  let buf = ''
  let tex = ''
  let i = 0
  const n = src.length
  const flushText = () => {
    if (buf) parts.push({ kind: 'text', value: buf })
    buf = ''
  }
  while (i < n) {
    const rest = src.slice(i)
    const tagMatch = /^\\\[|^\\\(|^\$\$/.exec(rest)
    if (tagMatch) {
      const tok = tagMatch[0]
      if (tok === '\\(' && mode === 'out') {
        // 显式 \( \) 内容含 >=2 个英文长单词 → 误包正文，去掉定界符按正文保留
        // （先剔除 \命令 再数词，避免把 \theta/\frac/\sqrt 当英文）
        const close = src.indexOf('\\)', i + 2)
        const nl = src.indexOf('\n', i + 2)
        if (close !== -1 && (nl === -1 || close < nl)) {
          const candidate = src.slice(i + 2, close)
          const englishWords = candidate.replace(/\\[A-Za-z]+/g, '').match(/[A-Za-z]{3,}/g)?.length ?? 0
          if (englishWords >= 2) {
            buf += candidate
            i = close + 2
            continue
          }
        }
      }
      if (mode === 'out') {
        flushText()
        mode = tok === '\\(' ? 'inline' : 'display'
        tex = ''
        i += tok.length
        continue
      }
      // 嵌套/错配：当作普通文本保留，交给 katex 的 throwOnError 兜底
      if (mode === 'display') tex += tok
      else buf += tok
      i += tok.length
      continue
    }
    if (rest.startsWith('\\]') || rest.startsWith('\\)')) {
      const tok = rest.slice(0, 2)
      const closing = tok === '\\]' ? 'display' : 'inline'
      if (mode === closing) {
        mode = 'out'
        parts.push({ kind: 'math', tex, display: closing === 'display' })
        tex = ''
        i += 2
        continue
      }
      if (mode === 'display') tex += tok
      else buf += tok
      i += 2
      continue
    }
    if (src[i] === '$') {
      if (mode === 'out') {
        // 行内 $ 仅在同行可配对、且内容不像英文句子（货币误配对防护）时视为数学
        const close = src.indexOf('$', i + 1)
        const nl = src.indexOf('\n', i + 1)
        const candidate = close !== -1 ? src.slice(i + 1, close) : ''
        const englishWords = candidate.match(/[A-Za-z]{3,}/g)?.length ?? 0
        if (close !== -1 && (nl === -1 || close < nl) && englishWords < 2) {
          flushText()
          mode = 'inline'
          tex = ''
          i += 1
          continue
        }
        buf += '$'
        i += 1
        continue
      }
      if (mode === 'inline') {
        mode = 'out'
        parts.push({ kind: 'math', tex, display: false })
        tex = ''
        i += 1
        continue
      }
      // display 块内的 $：OCR 错配残片（\[...,$ $...\]），丢弃
      i += 1
      continue
    }
    if (mode === 'out') buf += src[i]
    else tex += src[i]
    i += 1
  }
  if (buf) parts.push({ kind: 'text', value: buf })
  if (tex) parts.push({ kind: 'math', tex, display: mode === 'display' })
  return { parts, tail: mode }
}

export function normalizeLatexDelimiters(src: string): string {
  if (!src) return ''
  const { parts, tail } = splitSegments(src)
  let out = ''
  for (const p of parts) {
    if (p.kind === 'text') out += p.value
    else if (p.display) out += `\\[${p.tex}\\]`
    else out += `\\(${p.tex}\\)`
  }
  if (tail === 'display') out += '\\]'
  else if (tail === 'inline') out += '\\)'
  return out
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function katexRender(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      output: 'html',
    })
  } catch {
    return `<code class="ocr-tex-fallback">${escapeHtml(tex)}</code>`
  }
}

/** 文本段：空行分段、单换行 <br>；数学段：katex HTML */
export function renderLatexHtml(src: string | null | undefined): string {
  const text = normalizeLatexDelimiters(src ?? '')
  if (!text.trim()) return ''
  // 回写侧把 OTSL 转成单行 <table>…</table>（自有转换器生成、单元格已转义）；
  // 先抽出表格块单独重建渲染，其余走原段落管线
  const out: string[] = []
  const tableRe = /<table[\s\S]*?<\/table>/gi
  let last = 0
  let m: RegExpExecArray | null
  while ((m = tableRe.exec(text))) {
    if (m.index > last) out.push(renderParagraphs(text.slice(last, m.index)))
    out.push(renderStoredTable(m[0]))
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(renderParagraphs(text.slice(last)))
  return out.join('')
}

function renderParagraphs(text: string): string {
  if (!text.trim()) return ''
  const { parts } = splitSegments(text)
  let html = '<p>'
  let blankPending = false
  for (const p of parts) {
    if (p.kind === 'math') {
      if (blankPending) {
        html += '</p><p>'
        blankPending = false
      }
      html += katexRender(p.tex, p.display)
      continue
    }
    const lines = p.value.split('\n')
    lines.forEach((line, idx) => {
      if (!line.trim()) {
        blankPending = true
        return
      }
      if (blankPending && idx > 0) {
        html += '</p><p>'
        blankPending = false
      }
      if (idx > 0) html += '<br>'
      html += escapeHtml(line)
    })
  }
  html += '</p>'
  return html.replace(/<p><\/p>/g, '')
}

/** 存储的 HTML 表格 → 白名单重建（rowspan/colspan 整数，单元格走公式渲染） */
function renderStoredTable(tableHtml: string): string {
  try {
    const doc = new DOMParser().parseFromString(tableHtml, 'text/html')
    const src = doc.querySelector('table')
    if (!src) return escapeHtml(tableHtml)
    const table = document.createElement('table')
    table.className = 'ocr-table'
    for (const tr of Array.from(src.querySelectorAll('tr'))) {
      const trOut = document.createElement('tr')
      for (const cell of Array.from(tr.children)) {
        if (cell.tagName !== 'TD' && cell.tagName !== 'TH') continue
        const td = document.createElement(cell.tagName === 'TH' ? 'th' : 'td')
        for (const attr of ['rowspan', 'colspan'] as const) {
          const v = cell.getAttribute(attr)
          if (v && /^\d+$/.test(v) && Number(v) > 1) td.setAttribute(attr, v)
        }
        td.innerHTML = renderInline(cell.textContent ?? '')
        trOut.appendChild(td)
      }
      table.appendChild(trOut)
    }
    return table.outerHTML
  } catch {
    return escapeHtml(tableHtml)
  }
}

/** 单元格级渲染：文本转义、\( \) 走 katex */
function renderInline(text: string): string {
  const { parts } = splitSegments(text)
  let html = ''
  for (const p of parts) {
    if (p.kind === 'math') html += katexRender(p.tex, p.display)
    else html += escapeHtml(p.value).replace(/\n/g, '<br>')
  }
  return html || '&nbsp;'
}

/** 一键复制（http 环境降级 execCommand） */
export async function copyPlainText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 降级 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
