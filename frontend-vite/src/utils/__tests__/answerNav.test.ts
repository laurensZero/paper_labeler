import { describe, it, expect } from 'vitest'
import {
  findFirstUnansweredIndex,
  nextAnswerIndexAfterSave,
  clampAnswerProgressIndex,
  sortQuestionsByNoAsc,
} from '../paper'

const qs = (...ids: number[]) => ids.map((id) => ({ id, question_no: String(id) }))

describe('findFirstUnansweredIndex', () => {
  it('returns 0 when nothing is answered (fresh paper)', () => {
    expect(findFirstUnansweredIndex(qs(10, 11, 12), [])).toBe(0)
  })

  it('returns 0 when answeredIds is null/undefined', () => {
    expect(findFirstUnansweredIndex(qs(10, 11), null)).toBe(0)
    expect(findFirstUnansweredIndex(qs(10, 11), undefined)).toBe(0)
  })

  it('lands on the FIRST gap, not the last unanswered', () => {
    // 10 answered, 11 unanswered, 12 unanswered → must be index 1
    expect(findFirstUnansweredIndex(qs(10, 11, 12), [10])).toBe(1)
  })

  it('never returns the last item just because it is unanswered', () => {
    // Regression: old code scanned from the end and returned length-1
    const questions = qs(1, 2, 3, 4, 5)
    expect(findFirstUnansweredIndex(questions, [])).toBe(0)
    expect(findFirstUnansweredIndex(questions, [1, 2, 3, 4])).toBe(4)
    expect(findFirstUnansweredIndex(questions, [1, 3, 4, 5])).toBe(1)
  })

  it('returns -1 when every question is answered', () => {
    expect(findFirstUnansweredIndex(qs(1, 2), [1, 2])).toBe(-1)
  })

  it('returns -1 for empty list', () => {
    expect(findFirstUnansweredIndex([], [])).toBe(-1)
    expect(findFirstUnansweredIndex(null as never, [])).toBe(-1)
  })

  it('accepts string ids from the API', () => {
    expect(findFirstUnansweredIndex(qs(7, 8), ['7'])).toBe(1)
  })

  it('treats missing/invalid ids as unanswered', () => {
    expect(findFirstUnansweredIndex([{ id: undefined }, { id: 2 }], [2])).toBe(0)
    expect(findFirstUnansweredIndex([{ id: 0 }, { id: 2 }], [2])).toBe(0)
  })
})

describe('nextAnswerIndexAfterSave', () => {
  it('advances by exactly one from the saved index', () => {
    expect(nextAnswerIndexAfterSave(0, 5)).toBe(1)
    expect(nextAnswerIndexAfterSave(3, 5)).toBe(4)
  })

  it('returns null on the last question', () => {
    expect(nextAnswerIndexAfterSave(4, 5)).toBeNull()
    expect(nextAnswerIndexAfterSave(0, 1)).toBeNull()
  })

  it('rejects invalid indices', () => {
    expect(nextAnswerIndexAfterSave(-1, 5)).toBeNull()
    expect(nextAnswerIndexAfterSave(NaN, 5)).toBeNull()
    expect(nextAnswerIndexAfterSave(0, 0)).toBeNull()
    expect(nextAnswerIndexAfterSave(0, -1)).toBeNull()
  })

  it('never jumps to the end from a mid-list save', () => {
    for (let i = 0; i < 4; i++) {
      expect(nextAnswerIndexAfterSave(i, 5)).toBe(i + 1)
    }
  })
})

describe('clampAnswerProgressIndex', () => {
  it('keeps a valid saved index', () => {
    expect(clampAnswerProgressIndex(2, 5)).toBe(2)
    expect(clampAnswerProgressIndex(0, 5)).toBe(0)
    expect(clampAnswerProgressIndex(4, 5)).toBe(4)
  })

  it('falls back to 0 for missing or out-of-range progress', () => {
    expect(clampAnswerProgressIndex(null, 5)).toBe(0)
    expect(clampAnswerProgressIndex(undefined, 5)).toBe(0)
    expect(clampAnswerProgressIndex(-1, 5)).toBe(0)
    expect(clampAnswerProgressIndex(99, 5)).toBe(0)
    expect(clampAnswerProgressIndex(NaN, 5)).toBe(0)
  })

  it('returns -1 for empty question list', () => {
    expect(clampAnswerProgressIndex(0, 0)).toBe(-1)
    expect(clampAnswerProgressIndex(3, 0)).toBe(-1)
  })
})

describe('sortQuestionsByNoAsc + firstUnanswered integration', () => {
  it('fresh paper sorted by question_no opens at question 1', () => {
    const sorted = sortQuestionsByNoAsc([
      { id: 3, question_no: '3' },
      { id: 1, question_no: '1' },
      { id: 2, question_no: '2' },
    ])
    expect(sorted.map((q) => q.question_no)).toEqual(['1', '2', '3'])
    expect(findFirstUnansweredIndex(sorted, [])).toBe(0)
    expect(findFirstUnansweredIndex(sorted, [1])).toBe(1)
    expect(findFirstUnansweredIndex(sorted, [1, 2, 3])).toBe(-1)
  })
})
