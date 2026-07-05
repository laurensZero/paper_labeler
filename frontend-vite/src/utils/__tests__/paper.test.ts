import { describe, it, expect } from 'vitest'
import { formatPaperName, extractYearFromPaperName, extractCacheBustToken, stripPdfSuffix, deriveMsCode, sortQuestionsByNoAsc } from '../paper'

describe('stripPdfSuffix', () => {
  it('strips .pdf', () => expect(stripPdfSuffix('test.pdf')).toBe('test'))
  it('strips .PDF case-insensitive', () => expect(stripPdfSuffix('test.PDF')).toBe('test'))
  it('handles no suffix', () => expect(stripPdfSuffix('test')).toBe('test'))
  it('handles empty string', () => expect(stripPdfSuffix('')).toBe(''))
})

describe('formatPaperName', () => {
  it('uses exam_code when available', () => {
    expect(formatPaperName({ exam_code: '9709_s25', filename: 'other.pdf' })).toBe('9709_s25')
  })
  it('falls back to filename', () => {
    expect(formatPaperName({ filename: '9709_s25_qp_15.pdf' })).toBe('9709_s25_qp_15')
  })
  it('handles null exam_code', () => {
    expect(formatPaperName({ exam_code: null, filename: 'f.pdf' })).toBe('f')
  })
  it('handles empty input', () => expect(formatPaperName({})).toBe(''))
  it('handles null', () => expect(formatPaperName(null)).toBe(''))
})

describe('extractYearFromPaperName', () => {
  it('extracts year from combined code+filename with season pattern', () => {
    expect(extractYearFromPaperName({ exam_code: '9709_s25_qp', filename: '15.pdf' })).toBe('25')
  })
  it('extracts year from filename alone', () => {
    expect(extractYearFromPaperName({ filename: '9709_s25_qp_15' })).toBe('25')
  })
  it('returns null for no match', () => {
    expect(extractYearFromPaperName({ filename: 'random' })).toBeNull()
  })
  it('returns null for null input', () => expect(extractYearFromPaperName(null)).toBeNull())
})

describe('extractCacheBustToken', () => {
  // extractCacheBustToken uses window.location.origin internally
  it('returns null for empty string', () => expect(extractCacheBustToken('')).toBeNull())
  it('returns null for invalid url', () => expect(extractCacheBustToken('not-a-url')).toBeNull())
})

describe('deriveMsCode', () => {
  it('replaces _qp_ with _ms_', () => {
    expect(deriveMsCode('9709_s25_qp_15')).toBe('9709_s25_ms_15')
  })
  it('returns null when no _qp_', () => {
    expect(deriveMsCode('9709_s25_ms_15')).toBeNull()
  })
})

describe('sortQuestionsByNoAsc', () => {
  it('sorts by numeric question_no', () => {
    const qs = [{ id: 1, question_no: '3' }, { id: 2, question_no: '1' }, { id: 3, question_no: '2' }]
    expect(sortQuestionsByNoAsc(qs).map((q) => q.id)).toEqual([2, 3, 1])
  })
  it('sorts non-numeric question_no last', () => {
    const qs = [{ id: 1, question_no: 'abc' }, { id: 2, question_no: '1' }]
    expect(sortQuestionsByNoAsc(qs).map((q) => q.id)).toEqual([2, 1])
  })
  it('handles null question_no', () => {
    const qs = [{ id: 1, question_no: null }, { id: 2, question_no: '1' }]
    expect(sortQuestionsByNoAsc(qs).map((q) => q.id)).toEqual([2, 1])
  })
})
