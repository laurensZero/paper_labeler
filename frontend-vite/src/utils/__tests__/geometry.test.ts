import { describe, it, expect } from 'vitest'
import { clamp01, clampInt, normalizeBox, pointInBox, escapeHtml, extractYearSeason } from '../geometry'

describe('clamp01', () => {
  it('clamps to 0', () => expect(clamp01(-0.5)).toBe(0))
  it('clamps to 1', () => expect(clamp01(1.5)).toBe(1))
  it('passes through 0-1 range', () => expect(clamp01(0.5)).toBe(0.5))
  it('handles exact boundaries', () => {
    expect(clamp01(0)).toBe(0)
    expect(clamp01(1)).toBe(1)
  })
})

describe('clampInt', () => {
  it('clamps below min', () => expect(clampInt(0, 1, 10)).toBe(1))
  it('clamps above max', () => expect(clampInt(15, 1, 10)).toBe(10))
  it('passes through valid range', () => expect(clampInt(5, 1, 10)).toBe(5))
  it('parses string input', () => expect(clampInt('7', 1, 10)).toBe(7))
  it('returns min for NaN', () => expect(clampInt('abc', 1, 10)).toBe(1))
  it('returns min for null', () => expect(clampInt(null, 1, 10)).toBe(1))
  it('returns min for undefined', () => expect(clampInt(undefined, 1, 10)).toBe(1))
})

describe('normalizeBox', () => {
  it('normalizes swapped coordinates', () => {
    expect(normalizeBox([0.8, 0.7, 0.2, 0.3])).toEqual([0.2, 0.3, 0.8, 0.7])
  })
  it('clamps to 0-1', () => {
    expect(normalizeBox([-0.1, 0.5, 1.2, 0.5])).toEqual([0, 0.5, 1, 0.5])
  })
  it('handles already-normal box', () => {
    expect(normalizeBox([0.1, 0.2, 0.3, 0.4])).toEqual([0.1, 0.2, 0.3, 0.4])
  })
})

describe('pointInBox', () => {
  const box: [number, number, number, number] = [0.2, 0.3, 0.8, 0.7]

  it('returns true for point inside', () => expect(pointInBox(0.5, 0.5, box)).toBe(true))
  it('returns true for point on edge', () => expect(pointInBox(0.2, 0.3, box)).toBe(true))
  it('returns false for point outside', () => expect(pointInBox(0.1, 0.1, box)).toBe(false))
})

describe('escapeHtml', () => {
  it('escapes ampersand', () => expect(escapeHtml('a&b')).toBe('a&amp;b'))
  it('escapes angle brackets', () => expect(escapeHtml('<div>')).toBe('&lt;div&gt;'))
  it('escapes quotes', () => expect(escapeHtml('"hi"')).toBe('&quot;hi&quot;'))
  it('escapes single quotes', () => expect(escapeHtml("'hi'")).toBe('&#39;hi&#39;'))
  it('handles non-string input', () => expect(escapeHtml(123)).toBe('123'))
  it('handles null', () => expect(escapeHtml(null)).toBe(''))
})

describe('extractYearSeason', () => {
  it('extracts from standard filename', () => {
    expect(extractYearSeason('9709_s25_qp_15.pdf')).toEqual({ season: 's', year: '25' })
  })
  it('extracts winter', () => {
    expect(extractYearSeason('9709_w23_ms_1.pdf')).toEqual({ season: 'w', year: '23' })
  })
  it('extracts march', () => {
    expect(extractYearSeason('9709_m24_qp_1.pdf')).toEqual({ season: 'm', year: '24' })
  })
  it('returns null for no match', () => {
    expect(extractYearSeason('random_file.pdf')).toEqual({ season: null, year: null })
  })
})
