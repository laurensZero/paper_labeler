const API_BASE = ''

/** Convert camelCase keys to snake_case */
export function convertKeysToSnake(obj: unknown): unknown {
  if (obj == null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(convertKeysToSnake)
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
    result[snakeKey] = convertKeysToSnake((obj as Record<string, unknown>)[key])
  }
  return result
}

export class ApiError extends Error {
  status: number
  statusText: string
  body: string

  constructor(status: number, statusText: string, body: string) {
    super(`API Error ${status}: ${statusText}`)
    this.status = status
    this.statusText = statusText
    this.body = body
  }
}

/** Fetch JSON — no key conversion, use snake_case like the backend */
export async function api<T = any>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, opts)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ApiError(res.status, res.statusText, body)
  }
  return res.json()
}

/** Upload FormData */
export async function upload<T>(path: string, formData: FormData): Promise<T> {
  return api<T>(path, { method: 'POST', body: formData })
}

// Status sink for UI status messages
let statusSink: ((text: string, kind?: string) => void) | null = null

export function setStatusSink(fn: (text: string, kind?: string) => void): void {
  statusSink = fn
}

export function setStatus(text: string, kind?: string): void {
  statusSink?.(text, kind)
}
