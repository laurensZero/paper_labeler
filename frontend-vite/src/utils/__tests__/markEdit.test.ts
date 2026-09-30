import { describe, expect, it } from 'vitest'
import { buildMarkEditPayload, canSaveMarkQuestion } from '../markEdit'

describe('edit save payload regressions', () => {
  it('allows metadata-only save with empty boxes', () => {
    expect(canSaveMarkQuestion(114, 0)).toBe(true)
  })

  it('keeps manual box geometry as provided (no snap in payload builder)', () => {
    const payload = buildMarkEditPayload({
      section: '',
      selectedSections: ['力学'],
      original: { sections: ['力学'], notes: '旧', difficulty: 3 },
      notes: '新备注',
      difficulty: 5,
      boxes: [{ page: 3, bbox: [0.11, 0.22, 0.33, 0.44] }],
    })
    expect(payload.boxes).toEqual([{ page: 3, bbox: [0.11, 0.22, 0.33, 0.44] }])
    expect(payload.difficulty).toBe(5)
    expect(payload.notes).toBe('新备注')
  })

  it('treats intentional empty notes as clear while keeping difficulty', () => {
    expect(buildMarkEditPayload({
      section: '',
      selectedSections: [],
      original: { sections: ['代数'], notes: '旧备注', difficulty: 4 },
      notes: '',
      difficulty: 4,
      boxes: [],
    })).toEqual({ sections: ['代数'], notes: null, difficulty: 4, boxes: [] })
  })
})
