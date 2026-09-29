/**
 * Supabase 反向代理（国内可达入口）。
 * 浏览器把 VITE_SUPABASE_URL 切到本 worker 域名后，路径原样转发到 Supabase。
 * 只放行 API 前缀，避免变成开放代理。
 */

const ALLOW_PREFIXES = ['/auth/', '/rest/', '/storage/', '/functions/', '/realtime/']

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version, prefer, range, if-match, if-none-match',
  'Access-Control-Expose-Headers': 'content-range, content-location, location, preference-applied, sb-gateway-version',
  'Access-Control-Max-Age': '86400',
}

function withCors(headers) {
  const h = new Headers(headers)
  for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v)
  return h
}

function originFromEnv(env) {
  const raw = (env?.SUPABASE_ORIGIN || 'https://thcormurgwrgekrrgpnj.supabase.co').trim()
  return raw.replace(/\/+$/, '')
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: withCors({}) })
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('ok', {
        status: 200,
        headers: withCors({ 'content-type': 'text/plain; charset=utf-8' }),
      })
    }

    const allowed = ALLOW_PREFIXES.some((p) => url.pathname.startsWith(p))
    if (!allowed) {
      return new Response('Not Found', { status: 404, headers: withCors({}) })
    }

    const target = new URL(url.pathname + url.search, originFromEnv(env) + '/')

    const headers = new Headers(request.headers)
    headers.delete('host')
    // 去掉 hop-by-hop，避免 Workers fetch 转发异常
    for (const h of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']) {
      headers.delete(h)
    }

    const init = {
      method: request.method,
      headers,
      redirect: 'manual',
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body
      // 允许浏览器上送可读流 body（supabase-js 偶发大 JSON）
      init.duplex = 'half'
    }

    let upstream
    try {
      upstream = await fetch(target, init)
    } catch {
      return new Response('Bad Gateway', { status: 502, headers: withCors({}) })
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: withCors(upstream.headers),
    })
  },
}
