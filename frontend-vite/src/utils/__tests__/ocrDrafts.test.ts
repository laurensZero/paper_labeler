import { describe, it, expect } from 'vitest'
import { isUsableOcrLabel, normalizeOcrDrafts, normalizeOcrBoxes } from '../paper'

describe('isUsableOcrLabel', () => {
  it('accepts real question numbers', () => {
    expect(isUsableOcrLabel('1')).toBe(true)
    expect(isUsableOcrLabel('12')).toBe(true)
    expect(isUsableOcrLabel(' 3 ')).toBe(true)
    expect(isUsableOcrLabel('1(a)')).toBe(true)
  })

  it('rejects null/empty/placeholder', () => {
    expect(isUsableOcrLabel(null)).toBe(false)
    expect(isUsableOcrLabel(undefined)).toBe(false)
    expect(isUsableOcrLabel('')).toBe(false)
    expect(isUsableOcrLabel('   ')).toBe(false)
    expect(isUsableOcrLabel('?')).toBe(false)
  })
})

describe('normalizeOcrDrafts', () => {
  const box = { page: 2, bbox: [0.1, 0.1, 0.9, 0.9] }

  it('drops garbled fallback drafts with label=null', () => {
    const drafts = [
      { label: null, boxes: [box] },
      { label: null, boxes: [{ page: 3, bbox: [0.1, 0.16, 0.9, 0.98] }] },
    ]
    expect(normalizeOcrDrafts(drafts)).toEqual([])
  })

  it('drops drafts with no boxes or invalid bbox', () => {
    expect(normalizeOcrDrafts([{ label: '1', boxes: [] }])).toEqual([])
    expect(normalizeOcrDrafts([{ label: '1', boxes: [{ page: 2, bbox: [0.1, 0.2] }] }])).toEqual([])
  })

  it('keeps labeled drafts and trims the label', () => {
    const out = normalizeOcrDrafts([{ label: ' 2 ', boxes: [box] }])
    expect(out).toHaveLength(1)
    expect(out[0].label).toBe('2')
    expect(out[0].boxes).toHaveLength(1)
  })

  it('handles non-array input', () => {
    expect(normalizeOcrDrafts(null)).toEqual([])
    expect(normalizeOcrDrafts(undefined)).toEqual([])
    expect(normalizeOcrDrafts({})).toEqual([])
  })
})

describe('normalizeOcrBoxes', () => {
  it('drops unlabeled per-page fallback boxes', () => {
    const boxes = [
      { page: 2, bbox: [0.113, 0.16, 0.891, 0.98], label: null },
      { page: 3, bbox: [0.113, 0.16, 0.891, 0.98] },
      { page: 4, bbox: [0.1, 0.1, 0.2, 0.2], label: '?' },
    ]
    expect(normalizeOcrBoxes(boxes)).toEqual([])
  })

  it('keeps labeled boxes with finite page/bbox', () => {
    const out = normalizeOcrBoxes([
      { page: 2, bbox: [0.1, 0.2, 0.3, 0.4], label: '1' },
      { page: '3', bbox: [0.1, 0.2, 0.3, 0.4], label: ' 2 ' },
    ])
    expect(out).toEqual([
      { page: 2, bbox: [0.1, 0.2, 0.3, 0.4], label: '1' },
      { page: 3, bbox: [0.1, 0.2, 0.3, 0.4], label: '2' },
    ])
  })

  it('drops invalid bbox values', () => {
    expect(normalizeOcrBoxes([{ page: 2, bbox: [0.1, 0.2, 0.3], label: '1' }])).toEqual([])
    expect(normalizeOcrBoxes([{ page: 2, bbox: [0.1, 0.2, 0.3, Number.NaN], label: '1' }])).toEqual([])
    expect(normalizeOcrBoxes([{ page: Number.NaN, bbox: [0.1, 0.2, 0.3, 0.4], label: '1' }])).toEqual([])
  })
})
