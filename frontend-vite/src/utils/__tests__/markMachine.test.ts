import { describe, it, expect } from 'vitest'
import { createMarkMachine, markTransition } from '../markMachine'
import type { MarkMachineState, MarkEvent } from '../markMachine'

function ready(overrides?: Partial<MarkMachineState>) {
  return createMarkMachine({ phase: 'ready', mode: 'create', ...overrides })
}

describe('markMachine / SAVE double-click', () => {
  it('ignores the second SAVE while saving', () => {
    const m = ready()
    expect(m.send({ type: 'EDIT_DRAW_END', changed: true })).toBe(true)
    expect(m.state.dirty).toBe(true)

    expect(m.send({ type: 'SAVE' })).toBe(true)
    expect(m.state.saving).toBe(true)
    expect(m.state.persistBusy).toBe(true)
    expect(m.state.phase).toBe('saving')

    // double-click / Ctrl+S spam
    expect(m.send({ type: 'SAVE' })).toBe(false)
    expect(m.send({ type: 'SAVE' })).toBe(false)
    expect(m.state.saving).toBe(true)

    expect(m.send({ type: 'SAVE_OK' })).toBe(true)
    expect(m.state.saving).toBe(false)
    expect(m.state.persistBusy).toBe(false)
    expect(m.state.dirty).toBe(false)

    // after success a new SAVE is accepted again
    expect(m.send({ type: 'SAVE' })).toBe(true)
  })

  it('ignores SAVE while persistBusy (saved-undo IO)', () => {
    const m = ready()
    expect(m.send({ type: 'PERSIST_BEGIN' })).toBe(true)
    expect(m.send({ type: 'SAVE' })).toBe(false)
    expect(m.state.saving).toBe(false)
    m.send({ type: 'PERSIST_END' })
    expect(m.send({ type: 'SAVE' })).toBe(true)
  })
})

describe('markMachine / mode switch clears draft state', () => {
  it('SET_MODE clears OCR draft count and selection index', () => {
    const m = ready()
    m.send({ type: 'OCR_SUGGEST', draftCount: 4 })
    expect(m.state.mode).toBe('ocr')
    expect(m.state.ocrDraftCount).toBe(4)
    m.send({ type: 'OCR_SELECT_DRAFT', index: 2 })
    expect(m.state.selectedOcrDraftIdx).toBe(2)

    expect(m.send({ type: 'SET_MODE', mode: 'create' })).toBe(true)
    expect(m.state.mode).toBe('create')
    expect(m.state.ocrDraftCount).toBe(0)
    expect(m.state.selectedOcrDraftIdx).toBe(0)
  })

  it('SET_MODE clears in-flight drawing gesture', () => {
    const m = ready()
    m.send({ type: 'EDIT_DRAW_START' })
    expect(m.state.drawing).toBe(true)
    m.send({ type: 'SET_MODE', mode: 'edit', editingQuestionId: 7 })
    expect(m.state.drawing).toBe(false)
    expect(m.state.mode).toBe('edit')
    expect(m.state.editingQuestionId).toBe(7)
  })

  it('switching away from edit drops editingQuestionId', () => {
    const m = ready({ mode: 'edit', editingQuestionId: 3 })
    m.send({ type: 'SET_MODE', mode: 'create' })
    expect(m.state.editingQuestionId).toBeNull()
  })
})

describe('markMachine / OCR draft selection clamp', () => {
  it('clamps out-of-range indices into [0, count-1]', () => {
    const m = ready()
    m.send({ type: 'OCR_SUGGEST', draftCount: 3 })
    m.send({ type: 'OCR_SELECT_DRAFT', index: 99 })
    expect(m.state.selectedOcrDraftIdx).toBe(2)
    m.send({ type: 'OCR_SELECT_DRAFT', index: -5 })
    expect(m.state.selectedOcrDraftIdx).toBe(0)
    m.send({ type: 'OCR_SELECT_DRAFT', index: 1 })
    expect(m.state.selectedOcrDraftIdx).toBe(1)
  })

  it('keeps index at 0 when there are no drafts', () => {
    const m = ready()
    m.send({ type: 'OCR_SUGGEST', draftCount: 0 })
    m.send({ type: 'OCR_SELECT_DRAFT', index: 3 })
    expect(m.state.selectedOcrDraftIdx).toBe(0)
    expect(m.state.ocrDraftCount).toBe(0)
  })
})

describe('markMachine / DELETE_BOX and CLEAR_BOXES mark dirty', () => {
  it('DELETE_BOX sets dirty and drops selection', () => {
    const m = ready()
    m.send({ type: 'SELECT', hasSelection: true })
    expect(m.state.dirty).toBe(false)
    expect(m.send({ type: 'DELETE_BOX' })).toBe(true)
    expect(m.state.dirty).toBe(true)
    expect(m.state.hasSelection).toBe(false)
  })

  it('CLEAR_BOXES sets dirty and clears OCR drafts', () => {
    const m = ready()
    m.send({ type: 'OCR_SUGGEST', draftCount: 2 })
    m.send({ type: 'OCR_SELECT_DRAFT', index: 1 })
    expect(m.send({ type: 'CLEAR_BOXES' })).toBe(true)
    expect(m.state.dirty).toBe(true)
    expect(m.state.ocrDraftCount).toBe(0)
    expect(m.state.selectedOcrDraftIdx).toBe(0)
    expect(m.state.hasSelection).toBe(false)
  })

  it('SET_SECTIONS marks dirty', () => {
    const m = ready()
    expect(m.send({ type: 'SET_SECTIONS' })).toBe(true)
    expect(m.state.dirty).toBe(true)
  })
})

describe('markMachine / SAVE_FAIL keeps dirty', () => {
  it('failed save leaves dirty=true and returns to ready', () => {
    const m = ready()
    m.send({ type: 'EDIT_DRAW_END', changed: true })
    expect(m.state.dirty).toBe(true)
    m.send({ type: 'SAVE' })
    expect(m.send({ type: 'SAVE_FAIL', error: 'network' })).toBe(true)
    expect(m.state.saving).toBe(false)
    expect(m.state.persistBusy).toBe(false)
    expect(m.state.phase).toBe('ready')
    expect(m.state.dirty).toBe(true)
    expect(m.state.lastError).toBe('network')
    // can retry
    expect(m.send({ type: 'SAVE' })).toBe(true)
  })

  it('SAVE_OK clears dirty', () => {
    const m = ready()
    m.send({ type: 'DELETE_BOX' })
    m.send({ type: 'SAVE' })
    m.send({ type: 'SAVE_OK' })
    expect(m.state.dirty).toBe(false)
    expect(m.state.lastError).toBeNull()
  })
})

describe('markMachine / drawing is mutually exclusive with SELECT', () => {
  it('ignores SELECT while drawing', () => {
    const m = ready()
    expect(m.send({ type: 'EDIT_DRAW_START' })).toBe(true)
    expect(m.state.drawing).toBe(true)
    expect(m.send({ type: 'SELECT', hasSelection: true })).toBe(false)
    expect(m.state.hasSelection).toBe(false)
    expect(m.state.drawing).toBe(true)

    expect(m.send({ type: 'EDIT_DRAW_END', changed: true })).toBe(true)
    expect(m.state.drawing).toBe(false)
    expect(m.state.dirty).toBe(true)

    expect(m.send({ type: 'SELECT', hasSelection: true })).toBe(true)
    expect(m.state.hasSelection).toBe(true)
  })

  it('drawing start clears selection; UNDO ignored during gesture', () => {
    const m = ready()
    m.send({ type: 'SELECT', hasSelection: true })
    m.send({ type: 'EDIT_DRAW_START' })
    expect(m.state.hasSelection).toBe(false)
    expect(m.send({ type: 'UNDO' })).toBe(false)

    // dirty stays stable until gesture commit
    m.send({ type: 'EDIT_DRAW_END', changed: false })
    expect(m.state.dirty).toBe(false)
    m.send({ type: 'EDIT_DRAW_START' })
    m.send({ type: 'EDIT_DRAW_END', changed: true })
    expect(m.state.dirty).toBe(true)
  })

  it('second EDIT_DRAW_START during gesture is ignored', () => {
    const m = ready()
    m.send({ type: 'EDIT_DRAW_START' })
    expect(m.send({ type: 'EDIT_DRAW_START' })).toBe(false)
    expect(m.state.drawing).toBe(true)
  })
})

describe('markMachine / lifecycle', () => {
  it('OPEN → OPEN_OK → ready; OPEN_FAIL → idle', () => {
    const m = createMarkMachine({ phase: 'idle' })
    expect(m.send({ type: 'OPEN' })).toBe(true)
    expect(m.state.phase).toBe('opening')
    expect(m.send({ type: 'OPEN_OK', mode: 'edit', editingQuestionId: 9 })).toBe(true)
    expect(m.state.phase).toBe('ready')
    expect(m.state.mode).toBe('edit')
    expect(m.state.editingQuestionId).toBe(9)

    m.send({ type: 'OPEN' })
    expect(m.send({ type: 'OPEN_FAIL', error: 'boom' })).toBe(true)
    expect(m.state.phase).toBe('idle')
    expect(m.state.lastError).toBe('boom')
  })

  it('OPEN_OK is ignored outside opening', () => {
    const m = ready()
    expect(m.send({ type: 'OPEN_OK' })).toBe(false)
  })

  it('CLOSE resets everything to idle', () => {
    const m = ready({ mode: 'ocr', dirty: true, editingQuestionId: 2 })
    m.send({ type: 'OCR_SUGGEST', draftCount: 3 })
    expect(m.send({ type: 'CLOSE' })).toBe(true)
    expect(m.state.phase).toBe('idle')
    expect(m.state.mode).toBe('create')
    expect(m.state.dirty).toBe(false)
    expect(m.state.editingQuestionId).toBeNull()
    expect(m.state.ocrDraftCount).toBe(0)
  })

  it('markTransition is pure and does not mutate input state', () => {
    const s: MarkMachineState = {
      phase: 'ready',
      mode: 'create',
      dirty: false,
      saving: false,
      persistBusy: false,
      drawing: false,
      editingQuestionId: null,
      ocrDraftCount: 0,
      selectedOcrDraftIdx: 0,
      hasSelection: false,
      undoDepth: 0,
      redoDepth: 0,
      lastError: null,
    }
    const ev: MarkEvent = { type: 'SAVE' }
    const a = markTransition(s, ev)
    const b = markTransition(s, ev)
    expect(s.saving).toBe(false)
    expect(s.phase).toBe('ready')
    expect(a.state.saving).toBe(true)
    expect(b.state).toEqual(a.state)
    expect(a.handled).toBe(true)
    // second transition from the SAME original state is still handled (purity),
    // but from the resulting state it is not:
    expect(markTransition(a.state, ev).handled).toBe(false)
  })
})
