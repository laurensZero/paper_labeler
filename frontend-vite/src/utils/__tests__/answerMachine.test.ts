import { describe, it, expect } from 'vitest'
import {
  createAnswerMachine,
  reduceAnswer,
  resolveStateName,
  assertTransition,
  primeAnswerMachine,
  createInitialAnswerState,
  type AnswerEvent,
  type AnswerStateName,
} from '../answerMachine'

describe('answerMachine — SAVE / double-click', () => {
  it('double-click SAVE only enters saving once', () => {
    const m = primeAnswerMachine('ready.dirty')
    expect(m.send({ type: 'SAVE' })).toBe(true)
    expect(m.getStateName()).toBe('saving')
    // second click must be ignored and must not leave saving
    expect(m.send({ type: 'SAVE' })).toBe(false)
    expect(m.getStateName()).toBe('saving')
    expect(m.send({ type: 'SAVE' })).toBe(false)
    expect(m.getStateName()).toBe('saving')
  })

  it('SAVE_OK from normal save returns to ready.clean with dirty=false', () => {
    const m = primeAnswerMachine('ready.dirty')
    m.send({ type: 'SAVE' })
    expect(m.send({ type: 'SAVE_OK' })).toBe(true)
    expect(m.getStateName()).toBe('ready.clean')
    expect(m.getState().dirty).toBe(false)
    expect(m.getState().removedBoxIds.size).toBe(0)
  })

  it('SAVE_FAIL returns to ready.dirty', () => {
    const m = primeAnswerMachine('ready.dirty')
    m.send({ type: 'SAVE' })
    expect(m.send({ type: 'SAVE_FAIL' })).toBe(true)
    expect(m.getStateName()).toBe('ready.dirty')
    expect(m.getState().dirty).toBe(true)
    // after fail, a new SAVE is allowed again
    expect(m.send({ type: 'SAVE' })).toBe(true)
    expect(m.getStateName()).toBe('saving')
  })
})

describe('answerMachine — stale LOAD/OPEN responses', () => {
  it('discards LOAD_OK from a superseded request', () => {
    const m = primeAnswerMachine('ready.clean')
    expect(m.send({ type: 'LOAD_Q', index: 1 })).toBe(true)
    const firstSeq = m.getState().requestSeq!
    expect(m.send({ type: 'LOAD_Q', index: 2 })).toBe(true)
    const secondSeq = m.getState().requestSeq!
    expect(secondSeq).not.toBe(firstSeq)

    // stale response must be dropped
    expect(m.send({ type: 'LOAD_OK', seq: firstSeq })).toBe(false)
    expect(m.getState().requestSeq).toBe(secondSeq)
    expect(m.getState().loadIndex).toBe(2)

    // current response applies
    expect(m.send({ type: 'LOAD_OK', seq: secondSeq })).toBe(true)
    expect(m.getState().requestSeq).toBeNull()
    expect(m.getStateName()).toBe('ready.clean')
  })

  it('discards OPEN_OK / OPEN_FAIL with the wrong seq', () => {
    const m = createAnswerMachine()
    m.send({ type: 'OPEN' })
    const openSeq = m.getState().seq
    expect(m.send({ type: 'OPEN_OK', seq: openSeq + 99 })).toBe(false)
    expect(m.getStateName()).toBe('opening')
    expect(m.send({ type: 'OPEN_OK', seq: openSeq })).toBe(true)
    expect(m.getStateName()).toBe('ready.clean')
  })

  it('discards a late LOAD_OK that arrives after the request finished', () => {
    const m = primeAnswerMachine('ready.clean')
    m.send({ type: 'LOAD_Q', index: 0 })
    const seq = m.getState().requestSeq!
    expect(m.send({ type: 'LOAD_OK', seq })).toBe(true)
    expect(m.send({ type: 'LOAD_OK', seq })).toBe(false)
    expect(m.send({ type: 'LOAD_FAIL', seq })).toBe(false)
  })
})

describe('answerMachine — replace mode', () => {
  it('replace SAVE_OK goes to replaceReturning', () => {
    const m = primeAnswerMachine('ready.replacing.dirty')
    expect(m.getState().mode).toBe('replacing')
    expect(m.send({ type: 'SAVE' })).toBe(true)
    expect(m.getStateName()).toBe('saving')
    expect(m.send({ type: 'SAVE_OK' })).toBe(true)
    expect(m.getStateName()).toBe('replaceReturning')
  })

  it('replace SAVE_FAIL goes back to ready.replacing.dirty', () => {
    const m = primeAnswerMachine('ready.replacing.dirty')
    m.send({ type: 'SAVE' })
    expect(m.send({ type: 'SAVE_FAIL' })).toBe(true)
    expect(m.getStateName()).toBe('ready.replacing.dirty')
  })

  it('CLEAR in replace mode does NOT silently leave replace', () => {
    const m = primeAnswerMachine('ready.replacing.dirty')
    expect(m.send({ type: 'CLEAR' })).toBe(true)
    // regression: used to flip replace off when boxes became empty
    expect(m.getStateName()).toBe('ready.replacing.dirty')
    expect(m.getState().mode).toBe('replacing')
    expect(m.getState().dirty).toBe(true)
  })

  it('REPLACE_EXIT drops replace while keeping dirty', () => {
    const m = primeAnswerMachine('ready.replacing.dirty')
    expect(m.send({ type: 'REPLACE_EXIT' })).toBe(true)
    expect(m.getStateName()).toBe('ready.dirty')
    expect(m.getState().mode).toBe('normal')
    expect(m.getState().dirty).toBe(true)
  })
})

describe('answerMachine — saving lock', () => {
  it('ignores NAV / EDIT / SAVE while saving', () => {
    const m = primeAnswerMachine('saving')
    expect(m.getStateName()).toBe('saving')
    const ignored: AnswerEvent[] = [
      { type: 'NAV_NEXT' },
      { type: 'NAV_PREV' },
      { type: 'NAV_JUMP', index: 3 },
      { type: 'EDIT' },
      { type: 'SAVE' },
      { type: 'LOAD_Q', index: 1 },
      { type: 'CLEAR' },
      { type: 'UNDO' },
      { type: 'REDO' },
      { type: 'BACK' },
    ]
    for (const ev of ignored) {
      expect(m.send(ev)).toBe(false)
      expect(m.getStateName()).toBe('saving')
    }
  })
})

describe('answerMachine — dirty flags', () => {
  it('EDIT and CLEAR mark dirty', () => {
    const m = primeAnswerMachine('ready.clean')
    expect(m.getState().dirty).toBe(false)
    expect(m.send({ type: 'EDIT' })).toBe(true)
    expect(m.getStateName()).toBe('ready.dirty')

    const m2 = primeAnswerMachine('ready.clean')
    expect(m2.send({ type: 'CLEAR' })).toBe(true)
    expect(m2.getStateName()).toBe('ready.dirty')
  })

  it('EDIT soft-delete uses stable box ids, not indices', () => {
    const m = primeAnswerMachine('ready.clean')
    m.send({ type: 'EDIT', removeBoxId: 'box-a' })
    m.send({ type: 'EDIT', removeBoxId: 'box-b' })
    expect([...m.getState().removedBoxIds].sort()).toEqual(['box-a', 'box-b'])
    m.send({ type: 'EDIT', restoreBoxId: 'box-a' })
    expect([...m.getState().removedBoxIds]).toEqual(['box-b'])
    expect(m.getState().dirty).toBe(true)
  })

  it('LOAD_Q / LOAD_OK clear removed ids and dirty (new question)', () => {
    const m = primeAnswerMachine('ready.dirty')
    m.send({ type: 'EDIT', removeBoxId: 'x' })
    expect(m.getState().removedBoxIds.has('x')).toBe(true)
    m.send({ type: 'LOAD_Q', index: 1 })
    const seq = m.getState().requestSeq!
    expect(m.getState().removedBoxIds.size).toBe(0)
    expect(m.getState().dirty).toBe(false)
    m.send({ type: 'LOAD_OK', seq })
    expect(m.getStateName()).toBe('ready.clean')
  })

  it('UNDO / REDO mark dirty', () => {
    const m = primeAnswerMachine('ready.clean')
    expect(m.send({ type: 'UNDO' })).toBe(true)
    expect(m.getStateName()).toBe('ready.dirty')
    const m2 = primeAnswerMachine('ready.clean')
    expect(m2.send({ type: 'REDO' })).toBe(true)
    expect(m2.getStateName()).toBe('ready.dirty')
  })
})

describe('answerMachine — resolveStateName / reduce purity', () => {
  it('maps phase+mode+dirty to canonical names', () => {
    expect(resolveStateName({ phase: 'idle', mode: 'normal', dirty: false })).toBe('idle')
    expect(resolveStateName({ phase: 'opening', mode: 'normal', dirty: false })).toBe('opening')
    expect(resolveStateName({ phase: 'ready', mode: 'normal', dirty: false })).toBe('ready.clean')
    expect(resolveStateName({ phase: 'ready', mode: 'normal', dirty: true })).toBe('ready.dirty')
    expect(resolveStateName({ phase: 'ready', mode: 'replacing', dirty: true })).toBe('ready.replacing.dirty')
    // replace is always treated as dirty
    expect(resolveStateName({ phase: 'ready', mode: 'replacing', dirty: false })).toBe('ready.replacing.dirty')
    expect(resolveStateName({ phase: 'saving', mode: 'normal', dirty: true })).toBe('saving')
    expect(resolveStateName({ phase: 'replaceReturning', mode: 'replacing', dirty: false })).toBe('replaceReturning')
  })

  it('reduceAnswer is pure — does not mutate the input state', () => {
    const s = createInitialAnswerState()
    const before = { ...s, removedBoxIds: new Set(s.removedBoxIds) }
    reduceAnswer(s, { type: 'OPEN' })
    expect(s).toEqual(before)
    expect(s.phase).toBe('idle')
    expect(s.seq).toBe(0)
  })
})

describe('answerMachine — assertTransition helper', () => {
  it('accepts legal transitions', () => {
    assertTransition('idle', { type: 'OPEN' }, 'opening')
    assertTransition('ready.dirty', { type: 'SAVE' }, 'saving')
    assertTransition('ready.replacing.dirty', { type: 'SAVE' }, 'saving')
    assertTransition('ready.replacing.dirty', { type: 'CLEAR' }, 'ready.replacing.dirty')
  })

  it('rejects illegal transitions', () => {
    expect(() =>
      assertTransition('saving', { type: 'SAVE' }, 'saving'),
    ).toThrow(/ignored/)
    expect(() =>
      assertTransition('ready.dirty', { type: 'SAVE' }, 'ready.dirty'),
    ).toThrow()
  })
})

describe('answerMachine — named-state table', () => {
  const cases: Array<[AnswerStateName, AnswerEvent, AnswerStateName | 'ignored']> = [
    ['idle', { type: 'OPEN' }, 'opening'],
    ['idle', { type: 'SAVE' }, 'ignored'],
    ['idle', { type: 'BACK' }, 'idle'],
    ['opening', { type: 'OPEN_OK', seq: 0 }, 'ignored'], // wrong seq → ignored at runtime; table uses primed seq via assertTransition only when primed
    ['ready.clean', { type: 'EDIT' }, 'ready.dirty'],
    ['ready.clean', { type: 'CLEAR' }, 'ready.dirty'],
    ['ready.dirty', { type: 'SAVE' }, 'saving'],
    ['saving', { type: 'SAVE_OK' }, 'ready.clean'],
    ['saving', { type: 'SAVE_FAIL' }, 'ready.dirty'],
    ['saving', { type: 'NAV_NEXT' }, 'ignored'],
    ['replaceReturning', { type: 'BACK' }, 'idle'],
    ['replaceReturning', { type: 'SAVE' }, 'ignored'],
  ]

  it('covers the core table via assertTransition', () => {
    for (const [from, ev, expected] of cases) {
      // skip seq-sensitive OPEN_OK stub (covered above)
      if (ev.type === 'OPEN_OK') continue
      assertTransition(from, ev, expected)
    }
  })
})
