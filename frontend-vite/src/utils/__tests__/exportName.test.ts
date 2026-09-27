import { describe, it, expect } from 'vitest'
import {
  DEFAULT_EXPORT_NAME_TEMPLATE,
  applyAutoTimestamp,
  commitExportSeqState,
  formatDateYmd,
  formatTimeHm,
  nextExportSeq,
  normalizeUniqueValues,
  renderExportNameTemplate,
  sanitizeExportFileNameCore,
  sanitizeExportTokenValue,
  templateHasTimeToken,
  templateUsesSeq,
  validateExportNameTemplate,
} from '../exportName'

describe('exportName / sanitize', () => {
  it('normalizes unique values', () => {
    expect(normalizeUniqueValues(['a', 'a', ' b ', '', null, 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('sanitizes token values', () => {
    expect(sanitizeExportTokenValue('a/b:c*d')).toBe('a_b_c_d')
    expect(sanitizeExportTokenValue('  hello world  ')).toBe('hello-world')
  })

  it('sanitizes filename core', () => {
    expect(sanitizeExportFileNameCore('a\\b/c d')).toBe('a_b_c_d')
  })
})

describe('exportName / template', () => {
  it('flags unknown tokens', () => {
    expect(validateExportNameTemplate('{mode}_{nope}')).toContain('{nope}')
    expect(validateExportNameTemplate('{mode}_{count}')).toBe('')
  })

  it('falls back to default on unknown tokens', () => {
    const r = renderExportNameTemplate({
      template: '{mode}_{bad}',
      context: { mode: 'Filter', ts: '20260101_1200' },
    })
    expect(r.usedFallback).toBe(true)
    expect(r.templateUsed).toBe(DEFAULT_EXPORT_NAME_TEMPLATE)
    expect(r.name).toContain('Filter')
  })

  it('renders known tokens', () => {
    const r = renderExportNameTemplate({
      template: '{mode}_{count}',
      context: { mode: 'Random', count: '5q' },
    })
    expect(r.usedFallback).toBe(false)
    expect(r.name).toBe('Random_5q')
  })

  it('detects seq and time tokens', () => {
    expect(templateUsesSeq('{mode}_{seq}')).toBe(true)
    expect(templateUsesSeq('{mode}')).toBe(false)
    expect(templateHasTimeToken('{mode}_{ts}')).toBe(true)
    expect(templateHasTimeToken('{mode}_{date}')).toBe(true)
    expect(templateHasTimeToken('{mode}')).toBe(false)
  })

  it('auto-appends timestamp when missing', () => {
    expect(applyAutoTimestamp('{mode}', true)).toBe('{mode}_{ts}')
    expect(applyAutoTimestamp('{mode}_{ts}', true)).toBe('{mode}_{ts}')
    expect(applyAutoTimestamp('{mode}', false)).toBe('{mode}')
    expect(applyAutoTimestamp('', true)).toBe(`${DEFAULT_EXPORT_NAME_TEMPLATE}_{ts}`)
  })
})

describe('exportName / seq', () => {
  it('starts at 1 on a new day', () => {
    const now = new Date(2026, 0, 2, 10, 0, 0)
    expect(nextExportSeq({ exportSeqDate: '20260101', exportSeqNum: 9 }, now)).toBe(1)
  })

  it('increments same day', () => {
    const now = new Date(2026, 0, 2, 10, 0, 0)
    expect(nextExportSeq({ exportSeqDate: formatDateYmd(now), exportSeqNum: 3 }, now)).toBe(4)
  })

  it('commit writes date and number', () => {
    const now = new Date(2026, 5, 15, 8, 30, 0)
    const next = commitExportSeqState({ exportSeqDate: '', exportSeqNum: 0 }, now)
    expect(next.exportSeqDate).toBe('20260615')
    expect(next.exportSeqNum).toBe(1)
  })
})

describe('exportName / dates', () => {
  it('formats ymd and hm', () => {
    const d = new Date(2026, 11, 31, 23, 5, 0)
    expect(formatDateYmd(d)).toBe('20261231')
    expect(formatTimeHm(d)).toBe('2305')
  })
})
