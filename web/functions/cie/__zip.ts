/**
 * GET /cie/__zip?files=a.pdf,b.pdf
 * 服务端打包，返回 application/zip + Content-Disposition。
 * 直链下载，兼容 IDM 等下载器（不走浏览器 fetch+blob）。
 */
import { buildZipStore } from './zip-store'

const UPSTREAM = 'https://cie.fraft.cn'
const FILENAME_RE = /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*\.pdf$/i
const MAX_FILES = 30

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
}

export async function onRequest(context: { request: Request; url: URL }): Promise<Response> {
  const { request } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS })
  }

  const src = new URL(request.url)
  const raw = src.searchParams.get('files') || ''
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (!names.length) {
    return jsonError('files required', 400)
  }
  if (names.length > MAX_FILES) {
    return jsonError(`too many files (max ${MAX_FILES})`, 400)
  }
  for (const n of names) {
    if (!FILENAME_RE.test(n) || n.includes('..') || n.length > 128) {
      return jsonError(`invalid filename: ${n}`, 400)
    }
  }

  const entries: { name: string; data: Uint8Array }[] = []
  const failed: string[] = []
  const queue = [...names]

  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const name = queue.shift()!
        try {
          const res = await fetch(
            `${UPSTREAM}/obj/Common/Fetch/redir/${encodeURIComponent(name)}`,
            { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PaperLabeler/1.0)' } },
          )
          if (!res.ok) throw new Error(String(res.status))
          const buf = new Uint8Array(await res.arrayBuffer())
          if (buf.length < 5 || buf[0] !== 0x25) throw new Error('not pdf')
          entries.push({ name, data: buf })
        } catch {
          failed.push(name)
        }
      }
    }),
  )

  if (!entries.length) {
    return jsonError(`all downloads failed: ${failed.join(', ')}`, 502)
  }

  // 保持请求顺序
  const order = new Map(names.map((n, i) => [n, i]))
  entries.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0))

  const zipBytes = buildZipStore(entries)
  const stamp = new Date().toISOString().slice(0, 10)
  const zipName = `cie-papers-${stamp}.zip`

  return new Response(zipBytes, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'application/zip',
      'Content-Length': String(zipBytes.length),
      'Content-Disposition': `attachment; filename="${zipName}"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
      'X-Zip-Failed': failed.join(',') || '',
      'Cache-Control': 'no-store',
    },
  })
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
