import { describe, it, expect } from 'vitest'
import { buildAnswerSaveBoxes, type AnswerSaveBox } from '../paper'

const box = (page: number, x0 = 0.1): AnswerSaveBox => ({
  page,
  bbox: [x0, 0.1, x0 + 0.2, 0.2],
})

describe('buildAnswerSaveBoxes', () => {
  it('keeps existing + new in normal mode', () => {
    const out = buildAnswerSaveBoxes({
      existing: [box(1), box(2, 0.3)],
      newBoxes: [box(3, 0.5)],
    })
    expect(out.map((b) => b.page)).toEqual([1, 2, 3])
  })

  it('drops removed existing boxes so one save is enough', () => {
    // Regression: deleting a mixed-in box used to re-merge the full existing list
    const out = buildAnswerSaveBoxes({
      existing: [box(1), box(2, 0.3), box(3, 0.5)],
      newBoxes: [box(4, 0.7)],
      removedExistingIndices: [1],
    })
    expect(out.map((b) => b.page)).toEqual([1, 3, 4])
    expect(out.some((b) => b.page === 2)).toBe(false)
  })

  it('supports deleting every existing box and saving empty', () => {
    const out = buildAnswerSaveBoxes({
      existing: [box(1), box(2)],
      newBoxes: [],
      removedExistingIndices: [0, 1],
    })
    expect(out).toEqual([])
  })

  it('replace mode uses only new boxes', () => {
    const out = buildAnswerSaveBoxes({
      existing: [box(1), box(2)],
      newBoxes: [box(9, 0.8)],
      isReplace: true,
    })
    expect(out.map((b) => b.page)).toEqual([9])
  })

  it('replace mode ignores removedExistingIndices', () => {
    const out = buildAnswerSaveBoxes({
      existing: [box(1)],
      newBoxes: [box(2), box(3)],
      removedExistingIndices: [0],
      isReplace: true,
    })
    expect(out.map((b) => b.page)).toEqual([2, 3])
  })

  it('clones bbox arrays so later drag edits do not mutate the payload', () => {
    const src = box(1)
    const out = buildAnswerSaveBoxes({ existing: [src], newBoxes: [] })
    out[0].bbox[0] = 0.99
    expect(src.bbox[0]).toBe(0.1)
  })

  it('handles null/undefined inputs', () => {
    expect(buildAnswerSaveBoxes({ existing: null, newBoxes: undefined })).toEqual([])
  })

  it('drops removed existing boxes by stable id', () => {
    const out = buildAnswerSaveBoxes({
      existing: [
        { id: 'a', ...box(1) },
        { id: 'b', ...box(2, 0.3) },
        { id: 'c', ...box(3, 0.5) },
      ],
      newBoxes: [box(4, 0.7)],
      removedExistingIds: ['b'],
    })
    expect(out.map((b) => b.page)).toEqual([1, 3, 4])
    expect(out.some((b) => b.page === 2)).toBe(false)
  })

  it('supports id-based removal of every existing box', () => {
    const out = buildAnswerSaveBoxes({
      existing: [
        { id: 'a', ...box(1) },
        { id: 'b', ...box(2) },
      ],
      newBoxes: [],
      removedExistingIds: ['a', 'b'],
    })
    expect(out).toEqual([])
  })
})
