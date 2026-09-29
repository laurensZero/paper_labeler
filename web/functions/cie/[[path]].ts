/**
 * Cloudflare Pages Function — CIE 同源反代
 * /cie/* → https://cie.fraft.cn/*
 * 在边缘节点执行，国内访问时请求从附近 PoP 发出。
 * PDF 带 Content-Disposition: attachment，兼容 IDM / 浏览器下载。
 */
const UPSTREAM = 'https://cie.fraft.cn'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
}

export async function onRequest(context: {
  request: Request
  params: { path: string[] }
}): Promise<Response> {
  const { request, params } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS })
  }

  const segs = params.path || []
  const path = segs.map((s) => encodeURIComponent(decodeURIComponent(s))).join('/')
  const src = new URL(request.url)
  const target = `${UPSTREAM}/${path}${src.search}`

  const headers = new Headers()
  const pass = ['content-type', 'accept', 'user-agent']
  for (const k of pass) {
    const v = request.headers.get(k)
    if (v) headers.set(k, v)
  }
  headers.set('User-Agent', 'Mozilla/5.0 (compatible; PaperLabeler/1.0)')

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'follow',
  }
  if (request.method === 'POST' || request.method === 'PUT') {
    init.body = await request.arrayBuffer()
  }

  try {
    const res = await fetch(target, init)
    const outHeaders = new Headers(CORS)
    const ctype = res.headers.get('content-type')
    if (ctype) outHeaders.set('Content-Type', ctype)
    outHeaders.set('Cache-Control', 'public, max-age=300')

    // PDF → 强制附件下载，文件名从 URL 取
    const lastSeg = segs[segs.length - 1] || ''
    const isPdf =
      res.ok && (ctype?.includes('pdf') || /\.pdf$/i.test(decodeURIComponent(lastSeg)))
    if (isPdf) {
      const filename = decodeURIComponent(lastSeg).replace(/[^\w.\-]+/g, '_') || 'paper.pdf'
      outHeaders.set(
        'Content-Disposition',
        `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      )
    }

    return new Response(res.body, { status: res.status, headers: outHeaders })
  } catch (e) {
    return new Response(
      JSON.stringify({ error: `cie proxy failed: ${e instanceof Error ? e.message : String(e)}` }),
      { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }
}
