/**
 * 本地开发：/cie 同源反代 + /cie/__zip 打包
 * 与 Cloudflare Pages Function 行为对齐（含 Content-Disposition）。
 */
import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildZipStore } from './src/lib/zip-store'

const UPSTREAM = 'https://cie.fraft.cn'
const FILENAME_RE = /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*\.pdf$/i

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: Uint8Array | string): void {
  res.statusCode = status
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.end(body)
}

function json(res: ServerResponse, status: number, obj: unknown): void {
  send(res, status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, JSON.stringify(obj))
}

async function handleProxy(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
  const path = url.replace(/^\/cie/, '')
  const target = `${UPSTREAM}${path}`
  const method = req.method || 'GET'

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (compatible; PaperLabeler/1.0)',
    Accept: String(req.headers.accept || '*/*'),
  }
  if (req.headers['content-type']) headers['Content-Type'] = String(req.headers['content-type'])

  let body: Buffer | undefined
  if (method === 'POST' || method === 'PUT') body = await readBody(req)

  const upstream = await fetch(target, {
    method,
    headers,
    body: body as BodyInit | undefined,
    redirect: 'follow',
  })

  const buf = new Uint8Array(await upstream.arrayBuffer())
  const outHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300',
  }
  const ctype = upstream.headers.get('content-type')
  if (ctype) outHeaders['Content-Type'] = ctype

  const last = decodeURIComponent(path.split('/').pop() || '')
  const isPdf = upstream.ok && (String(ctype || '').includes('pdf') || /\.pdf$/i.test(last))
  if (isPdf) {
    const filename = last.replace(/[^\w.\-]+/g, '_') || 'paper.pdf'
    outHeaders['Content-Disposition'] = `attachment; filename="${filename}"`
    outHeaders['Content-Length'] = String(buf.byteLength)
  }

  send(res, upstream.status, outHeaders, buf)
}

async function handleZip(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const u = new URL(req.url || '/cie/__zip', 'http://localhost')
  const raw = u.searchParams.get('files') || ''
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (!names.length) return json(res, 400, { error: 'files required' })
  if (names.length > 30) return json(res, 400, { error: 'too many files' })
  for (const n of names) {
    if (!FILENAME_RE.test(n) || n.includes('..') || n.length > 128) {
      return json(res, 400, { error: `invalid filename: ${n}` })
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
          const r = await fetch(`${UPSTREAM}/obj/Common/Fetch/redir/${encodeURIComponent(name)}`)
          if (!r.ok) throw new Error(String(r.status))
          const data = new Uint8Array(await r.arrayBuffer())
          if (data.length < 5 || data[0] !== 0x25) throw new Error('not pdf')
          entries.push({ name, data })
        } catch {
          failed.push(name)
        }
      }
    }),
  )

  if (!entries.length) return json(res, 502, { error: `all failed: ${failed.join(',')}` })

  const order = new Map(names.map((n, i) => [n, i]))
  entries.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0))
  const zip = buildZipStore(entries)
  const stamp = new Date().toISOString().slice(0, 10)
  const zipName = `cie-papers-${stamp}.zip`

  send(
    res,
    200,
    {
      'Content-Type': 'application/zip',
      'Content-Length': String(zip.byteLength),
      'Content-Disposition': `attachment; filename="${zipName}"`,
      'X-Zip-Failed': failed.join(',') || '',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
    zip,
  )
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function middleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  const url = req.url || ''
  if (!url.startsWith('/cie')) return next()

  const run = url.startsWith('/cie/__zip') ? handleZip(req, res) : handleProxy(req, res, url)
  run.catch((e) => {
    if (!res.headersSent) json(res, 502, { error: e instanceof Error ? e.message : String(e) })
  })
}

export function cieDevMiddleware(): Plugin {
  return {
    name: 'cie-dev-middleware',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
