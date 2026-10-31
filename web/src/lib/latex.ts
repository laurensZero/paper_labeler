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
    if (rest.startsWith('\\[') || rest.startsWith('\\(') || rest.startsWith('$$')) {
      const tok = rest.startsWith('$$') ? '$$' : rest.slice(0, 2)
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
        // 行内 $ 仅在同行可配对时视为数学开界符；否则是货币等字面量
        const close = src.indexOf('$', i + 1)
        const nl = src.indexOf('\n', i + 1)
        if (close !== -1 && (nl === -1 || close < nl)) {
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
