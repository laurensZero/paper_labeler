/**
 * Pure mark-labelling state machine. No Vue, no IO.
 *
 * Lifecycle:  idle → opening → ready(mode) ⇄ saving → ready
 * Flags:      dirty / saving / persistBusy / drawing
 *
 * Invariants
 * - SAVE while saving/persistBusy is ignored (double-click safe).
 * - SELECT / UNDO / REDO are ignored while a draw gesture is active.
 * - SET_MODE clears OCR draft state (count + selected index).
 * - OCR_SELECT_DRAFT clamps into [0, ocrDraftCount-1] (0 when empty).
 * - dirty only becomes true after a gesture commit (EDIT_DRAW_END changed).
 */

export type MarkMode = 'create' | 'edit' | 'ocr'
export type MarkPhase = 'idle' | 'opening' | 'ready' | 'saving'

export interface MarkMachineState {
  phase: MarkPhase
  mode: MarkMode
  dirty: boolean
  saving: boolean
  persistBusy: boolean
  drawing: boolean
  editingQuestionId: number | null
  ocrDraftCount: number
  selectedOcrDraftIdx: number
  hasSelection: boolean
  undoDepth: number
  redoDepth: number
  lastError: string | null
}

export type MarkEvent =
  | { type: 'OPEN' }
  | {
      type: 'OPEN_OK'
      mode?: MarkMode
      editingQuestionId?: number | null
      dirty?: boolean
      ocrDraftCount?: number
      boxCount?: number
    }
  | { type: 'OPEN_FAIL'; error?: string }
  | {
      type: 'SET_MODE'
      mode: MarkMode
      editingQuestionId?: number | null
      dirty?: boolean
    }
  | { type: 'EDIT_DRAW_START' }
  | { type: 'EDIT_DRAW_END'; changed?: boolean; hasSelection?: boolean }
  | { type: 'SELECT'; hasSelection?: boolean }
  | { type: 'DELETE_BOX'; hasSelection?: boolean }
  | { type: 'CLEAR_BOXES' }
  | {
      type: 'UNDO'
      dirty?: boolean
      hasSelection?: boolean
      undoDepth?: number
      redoDepth?: number
    }
  | {
      type: 'REDO'
      dirty?: boolean
      hasSelection?: boolean
      undoDepth?: number
      redoDepth?: number
    }
  | { type: 'SET_SECTIONS' }
  | { type: 'OCR_SUGGEST'; draftCount: number; dirty?: boolean; mode?: MarkMode }
  | { type: 'OCR_SELECT_DRAFT'; index: number; draftCount?: number }
  | { type: 'SAVE' }
  | {
      type: 'SAVE_OK'
      mode?: MarkMode
      editingQuestionId?: number | null
      dirty?: boolean
    }
  | { type: 'SAVE_FAIL'; error?: string }
  | { type: 'PERSIST_BEGIN' }
  | { type: 'PERSIST_END' }
  | { type: 'CLOSE' }

export type MarkTransition = {
  state: MarkMachineState
  handled: boolean
}

export interface MarkMachine {
  readonly state: MarkMachineState
  send(event: MarkEvent): boolean
  canSend(event: MarkEvent): boolean
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  const n = Math.trunc(value)
  if (max < min) return min
  return Math.min(Math.max(n, min), max)
}

function cloneState(state: MarkMachineState): MarkMachineState {
  return { ...state }
}

function emptyOcrSelection(state: MarkMachineState): void {
  state.ocrDraftCount = 0
  state.selectedOcrDraftIdx = 0
}

/** Pure transition. Returns next state + whether the event was applied. */
export function markTransition(state: MarkMachineState, event: MarkEvent): MarkTransition {
  const next = cloneState(state)

  switch (event.type) {
    case 'OPEN': {
      if (next.phase === 'saving') return { state: next, handled: false }
      next.phase = 'opening'
      next.lastError = null
      return { state: next, handled: true }
    }

    case 'OPEN_OK': {
      if (next.phase !== 'opening') return { state: next, handled: false }
      next.phase = 'ready'
      next.mode = event.mode ?? next.mode
      next.editingQuestionId =
        event.editingQuestionId !== undefined ? event.editingQuestionId : next.editingQuestionId
      next.dirty = event.dirty ?? false
      next.saving = false
      next.persistBusy = false
      next.drawing = false
      next.hasSelection = false
      if (event.ocrDraftCount != null) {
        next.ocrDraftCount = Math.max(0, Math.trunc(event.ocrDraftCount))
        next.selectedOcrDraftIdx = 0
      }
      next.lastError = null
      return { state: next, handled: true }
    }

    case 'OPEN_FAIL': {
      if (next.phase !== 'opening') return { state: next, handled: false }
      next.phase = 'idle'
      next.lastError = event.error ?? 'open failed'
      next.dirty = false
      next.saving = false
      next.drawing = false
      emptyOcrSelection(next)
      return { state: next, handled: true }
    }

    case 'SET_MODE': {
      if (next.phase === 'saving' || next.phase === 'opening') return { state: next, handled: false }
      if (next.phase === 'idle') next.phase = 'ready'
      next.mode = event.mode
      next.editingQuestionId =
        event.mode === 'edit'
          ? (event.editingQuestionId ?? next.editingQuestionId)
          : (event.editingQuestionId !== undefined ? event.editingQuestionId : null)
      // mode switch clears OCR draft state and any in-flight gesture
      emptyOcrSelection(next)
      next.drawing = false
      next.hasSelection = false
      if (event.dirty !== undefined) next.dirty = event.dirty
      next.lastError = null
      return { state: next, handled: true }
    }

    case 'EDIT_DRAW_START': {
      if (next.phase !== 'ready') return { state: next, handled: false }
      if (next.drawing) return { state: next, handled: false }
      next.drawing = true
      next.hasSelection = false
      return { state: next, handled: true }
    }

    case 'EDIT_DRAW_END': {
      if (!next.drawing && event.changed !== true) {
        // idempotent end (e.g. commit after already-ended gesture)
        next.drawing = false
        return { state: next, handled: true }
      }
      next.drawing = false
      if (event.changed) next.dirty = true
      if (event.hasSelection !== undefined) next.hasSelection = event.hasSelection
      return { state: next, handled: true }
    }

    case 'SELECT': {
      // mutually exclusive with an active draw gesture
      if (next.drawing) return { state: next, handled: false }
      if (next.phase !== 'ready') return { state: next, handled: false }
      next.hasSelection = event.hasSelection ?? true
      return { state: next, handled: true }
    }

    case 'DELETE_BOX': {
      if (next.phase !== 'ready' && next.phase !== 'saving') return { state: next, handled: false }
      next.dirty = true
      next.hasSelection = event.hasSelection ?? false
      return { state: next, handled: true }
    }

    case 'CLEAR_BOXES': {
      if (next.phase !== 'ready' && next.phase !== 'saving') return { state: next, handled: false }
      next.dirty = true
      next.hasSelection = false
      emptyOcrSelection(next)
      return { state: next, handled: true }
    }

    case 'UNDO': {
      if (next.drawing) return { state: next, handled: false }
      if (next.saving || next.persistBusy) return { state: next, handled: false }
      if (next.phase !== 'ready') return { state: next, handled: false }
      if (event.dirty !== undefined) next.dirty = event.dirty
      if (event.hasSelection !== undefined) next.hasSelection = event.hasSelection
      if (event.undoDepth !== undefined) next.undoDepth = Math.max(0, Math.trunc(event.undoDepth))
      if (event.redoDepth !== undefined) next.redoDepth = Math.max(0, Math.trunc(event.redoDepth))
      return { state: next, handled: true }
    }

    case 'REDO': {
      if (next.drawing) return { state: next, handled: false }
      if (next.saving || next.persistBusy) return { state: next, handled: false }
      if (next.phase !== 'ready') return { state: next, handled: false }
      if (event.dirty !== undefined) next.dirty = event.dirty
      if (event.hasSelection !== undefined) next.hasSelection = event.hasSelection
      if (event.undoDepth !== undefined) next.undoDepth = Math.max(0, Math.trunc(event.undoDepth))
      if (event.redoDepth !== undefined) next.redoDepth = Math.max(0, Math.trunc(event.redoDepth))
      return { state: next, handled: true }
    }

    case 'SET_SECTIONS': {
      if (next.phase !== 'ready') return { state: next, handled: false }
      next.dirty = true
      return { state: next, handled: true }
    }

    case 'OCR_SUGGEST': {
      if (next.phase === 'saving') return { state: next, handled: false }
      if (next.phase === 'idle') next.phase = 'ready'
      next.mode = event.mode ?? 'ocr'
      next.ocrDraftCount = Math.max(0, Math.trunc(event.draftCount))
      next.selectedOcrDraftIdx = 0
      next.editingQuestionId = null
      next.drawing = false
      next.hasSelection = false
      next.dirty = event.dirty ?? true
      next.lastError = null
      return { state: next, handled: true }
    }

    case 'OCR_SELECT_DRAFT': {
      if (next.phase !== 'ready') return { state: next, handled: false }
      if (next.drawing) return { state: next, handled: false }
      if (event.draftCount != null) {
        next.ocrDraftCount = Math.max(0, Math.trunc(event.draftCount))
      }
      const maxIdx = Math.max(0, next.ocrDraftCount - 1)
      next.selectedOcrDraftIdx = clampInt(event.index, 0, maxIdx)
      return { state: next, handled: true }
    }

    case 'SAVE': {
      // ignore duplicate SAVE while saving or any persist IO is in flight
      if (next.saving || next.persistBusy) return { state: next, handled: false }
      if (next.phase !== 'ready') return { state: next, handled: false }
      if (next.drawing) return { state: next, handled: false }
      next.phase = 'saving'
      next.saving = true
      next.persistBusy = true
      next.lastError = null
      return { state: next, handled: true }
    }

    case 'SAVE_OK': {
      if (!next.saving && next.phase !== 'saving') return { state: next, handled: false }
      next.phase = 'ready'
      next.saving = false
      next.persistBusy = false
      next.dirty = event.dirty ?? false
      next.drawing = false
      if (event.mode !== undefined) next.mode = event.mode
      if (event.editingQuestionId !== undefined) next.editingQuestionId = event.editingQuestionId
      next.lastError = null
      return { state: next, handled: true }
    }

    case 'SAVE_FAIL': {
      if (!next.saving && next.phase !== 'saving') return { state: next, handled: false }
      next.phase = 'ready'
      next.saving = false
      next.persistBusy = false
      // dirty intentionally kept — failed save must not look clean
      next.lastError = event.error ?? 'save failed'
      return { state: next, handled: true }
    }

    case 'PERSIST_BEGIN': {
      if (next.persistBusy) return { state: next, handled: false }
      if (next.phase !== 'ready') return { state: next, handled: false }
      next.persistBusy = true
      return { state: next, handled: true }
    }

    case 'PERSIST_END': {
      if (!next.persistBusy) return { state: next, handled: false }
      // do not clear flags owned by an in-flight SAVE
      if (!next.saving) {
        next.persistBusy = false
        next.phase = next.phase === 'saving' ? 'ready' : next.phase
      }
      return { state: next, handled: true }
    }

    case 'CLOSE': {
      next.phase = 'idle'
      next.mode = 'create'
      next.dirty = false
      next.saving = false
      next.persistBusy = false
      next.drawing = false
      next.editingQuestionId = null
      next.hasSelection = false
      next.undoDepth = 0
      next.redoDepth = 0
      next.lastError = null
      emptyOcrSelection(next)
      return { state: next, handled: true }
    }

    default: {
      const _exhaustive: never = event
      void _exhaustive
      return { state: next, handled: false }
    }
  }
}

const DEFAULT_STATE: MarkMachineState = {
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

export function createMarkMachine(initial?: Partial<MarkMachineState>): MarkMachine {
  let state: MarkMachineState = { ...DEFAULT_STATE, ...initial }
  return {
    get state() {
      return state
    },
    send(event: MarkEvent): boolean {
      const result = markTransition(state, event)
      state = result.state
      return result.handled
    },
    canSend(event: MarkEvent): boolean {
      return markTransition(state, event).handled
    },
  }
}
