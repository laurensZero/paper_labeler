/**
 * Lightweight frontend logger.
 * - mirrors to console
 * - batches to POST /logs so renderer errors land in data/logs/app.log
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEvent {
  level: LogLevel
  message: string
  source: string
  extra?: Record<string, unknown>
}

const queue: LogEvent[] = []
const MAX_QUEUE = 40
let flushTimer: number | null = null
let disabled = false

function enqueue(ev: LogEvent) {
  if (disabled) return
  queue.push(ev)
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE)
  if (flushTimer != null) return
  flushTimer = window.setTimeout(() => {
    flushTimer = null
    void flush()
  }, 800)
}

async function flush() {
  if (!queue.length) return
  const batch = queue.splice(0, queue.length)
  try {
    await fetch('/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    })
  } catch {
    // drop — logging must never break the app
  }
}

export function logEvent(level: LogLevel, message: string, extra?: Record<string, unknown>, source = 'ui') {
  const text = String(message ?? '')
  const payload = { level, message: text, source, extra }
  if (level === 'error' || level === 'warn') {
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : 'warn'](`[${source}]`, text, extra ?? '')
  } else if (level === 'debug') {
    // eslint-disable-next-line no-console
    console.debug(`[${source}]`, text, extra ?? '')
  }
  enqueue(payload as LogEvent)
}

export const logger = {
  debug: (message: string, extra?: Record<string, unknown>, source?: string) =>
    logEvent('debug', message, extra, source),
  info: (message: string, extra?: Record<string, unknown>, source?: string) =>
    logEvent('info', message, extra, source),
  warn: (message: string, extra?: Record<string, unknown>, source?: string) =>
    logEvent('warn', message, extra, source),
  error: (message: string, extra?: Record<string, unknown>, source?: string) =>
    logEvent('error', message, extra, source),
  flush,
  disable() {
    disabled = true
    queue.length = 0
  },
}

/** Wire uncaught errors / unhandled rejections once at startup. */
export function installGlobalErrorLogging() {
  window.addEventListener('error', (e) => {
    logEvent('error', e.message || 'window.error', {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
    }, 'window')
  })
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason
    logEvent('error', 'unhandledrejection', {
      reason: reason instanceof Error ? `${reason.message}\n${reason.stack || ''}` : String(reason),
    }, 'promise')
  })
}
