import MarkdownIt from 'markdown-it'
import katexPlugin from '@vscode/markdown-it-katex'
import 'katex/dist/katex.min.css'

/**
 * OCR 文本（Markdown + LaTeX）渲染。
 *
 * 渲染交给 markdown-it + KaTeX（表格/转义/段落均为库行为）；
 * 本文件只做一层 OCR 纠错预归一化：
 *   - 显式 \( \) / \[ \] 统一为 $ / $$（永远视为数学，不做"误包正文"剔除——
 *     启发式会误伤 \begin{pmatrix}/\theta 等真公式，不值得回归风险）
 *   - $ 配对内容疑似货币/正文（剔除命令及参数后仍含 >=2 个英文长单词，
 *     或无同行配对）→ 输出 \$ 按字面量保留
 */

type MathMode = 'out' | 'display' | 'inline'

interface Segment {
  kind: 'text' | 'open-display' | 'close-display' | 'open-inline' | 'close-inline' | 'literal-dollar'
  value: string
}

function tokenize(src: string): Segment[] {
  const tokens: Segment[] = []
  let mode: MathMode = 'out'
  let i = 0
  const n = src.length
  while (i < n) {
    const rest = src.slice(i)
    if (rest.startsWith('\\[') || rest.startsWith('\\(')) {
      const tok = rest.slice(0, 2)
      const want = tok === '\\[' ? 'display' : 'inline'
      if (mode === 'out') mode = want
      tokens.push({ kind: want === 'display' ? 'open-display' : 'open-inline', value: tok })
      i += 2
      continue
    }
    if (rest.startsWith('\\]') || rest.startsWith('\\)')) {
      const tok = rest.slice(0, 2)
      const closing = tok === '\\]' ? 'display' : 'inline'
      if (mode === closing) mode = 'out'
      tokens.push({ kind: closing === 'display' ? 'close-display' : 'close-inline', value: tok })
      i += 2
      continue
    }
    if (rest.startsWith('$$')) {
      if (mode === 'out') mode = 'display'
      else if (mode === 'display') mode = 'out'
      else mode = 'out' // inline 中的 $$ 视为闭合
      tokens.push({ kind: mode === 'display' ? 'open-display' : 'close-display', value: '$$' })
      i += 2
      continue
    }
    if (src[i] === '$') {
      if (mode === 'display') {
        i += 1 // display 块内的 $：OCR 错配残片，丢弃
        continue
      }
      if (mode === 'inline') {
        mode = 'out'
        tokens.push({ kind: 'close-inline', value: '$' })
        i += 1
        continue
      }
      const close = src.indexOf('$', i + 1)
      const nl = src.indexOf('\n', i + 1)
      const candidate = close !== -1 ? src.slice(i + 1, close) : ''
      // 剔除命令及花括号参数后再数词（theta/frac/pmatrix 不算英文）
      const englishWords = candidate
        .replace(/\\[A-Za-z]+(\{[^{}]*\})?/g, '')
        .match(/[A-Za-z]{3,}/g)?.length ?? 0
      if (close !== -1 && (nl === -1 || close < nl) && englishWords < 2) {
        mode = 'inline'
        tokens.push({ kind: 'open-inline', value: '$' })
      } else {
        tokens.push({ kind: 'literal-dollar', value: '$' })
      }
      i += 1
      continue
    }
    tokens.push({ kind: 'text', value: src[i] })
    i += 1
  }
  return tokens
}

/** 归一化 + 转标准 $ / $$（货币等字面量转义为 \$），供 markdown-it 渲染 */
export function normalizeLatexDelimiters(src: string): string {
  if (!src) return ''
  const tokens = tokenize(src)
  let out = ''
  let pendingDisplay = false
  let pendingInline = false
  for (const t of tokens) {
    switch (t.kind) {
      case 'open-display': pendingDisplay = true; out += '$$'; break
      case 'close-display': pendingDisplay = false; out += '$$'; break
      case 'open-inline': pendingInline = true; out += '$'; break
      case 'close-inline': pendingInline = false; out += '$'; break
      case 'literal-dollar': out += '\\$'; break
      default: out += t.value
    }
  }
  // 未闭合：按上下文补全
  if (pendingDisplay) out += '$$'
  else if (pendingInline) out += '$'
  // 显示块内压掉空行（markdown 段落切分会把跨空行的 $$ 块截断成未配对文本）
  out = out.replace(/\$\$([\s\S]*?)\$\$/g, (_, inner) => '$$' + inner.replace(/\n{2,}/g, '\n') + '$$')
  return out
}

const md = new MarkdownIt({ html: false, breaks: true })
// CJS 双层导出兼容：包形如 { default: fn }
const katexPluginAny = katexPlugin as unknown as { default?: unknown }
md.use((katexPluginAny.default ?? katexPlugin) as Parameters<typeof md.use>[0])

/** Markdown（含表格）+ LaTeX → HTML */
export function renderLatexHtml(src: string | null | undefined): string {
  const text = normalizeLatexDelimiters(src ?? '')
  if (!text.trim()) return ''
  return md.render(text)
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
