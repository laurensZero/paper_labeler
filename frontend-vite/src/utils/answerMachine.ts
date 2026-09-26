/**
 * Pure answer-labeling state machine. No Vue, no IO.
 *
 * All transitions go through a single reduce (`reduceAnswer`).
 * Callers own side effects and must tag async responses with the `seq`
 * issued by the machine so stale OPEN/LOAD results are discarded.
 */

export type AnswerMode = 'normal' | 'replacing'

export type AnswerPhase =
  | 'idle'
  | 'opening'
  | 'ready'
  | 'saving'
  | 'replaceReturning'

/** Canonical phase+mode+dirty name used by tests and UI gates. */
export type AnswerStateName =
  | 'idle'
  | 'opening'
  | 'ready.clean'
  | 'ready.dirty'
  | 'ready.replacing.dirty'
  | 'saving'
  | 'replaceReturning'

export interface AnswerMachineState {
  phase: AnswerPhase
  mode: AnswerMode
  dirty: boolean
  /** Monotonic token for OPEN/LOAD; latest issued wins. */
  seq: number
  /** Token of the in-flight OPEN/LOAD request, if any. */
  requestSeq: number | null
  requestKind: 'open' | 'load' | null
  /** Question index targeted by the in-flight LOAD_Q. */
  loadIndex: number | null
  /** Stable string ids of soft-deleted existing boxes (never array indices). */
  removedBoxIds: ReadonlySet<string>
  selectedBoxId: string | null
  replaceQuestionId: number | null
}

export type AnswerEventType =
  | 'OPEN'
  | 'OPEN_OK'
  | 'OPEN_FAIL'
  | 'LOAD_Q'
  | 'LOAD_OK'
  | 'LOAD_FAIL'
  | 'EDIT'
  | 'SELECT'
  | 'CLEAR'
  | 'UNDO'
  | 'REDO'
  | 'SAVE'
  | 'SAVE_OK'
  | 'SAVE_FAIL'
  | 'NAV_NEXT'
  | 'NAV_PREV'
  | 'NAV_JUMP'
  | 'REPLACE_ENTER'
  | 'REPLACE_EXIT'
  | 'BACK'

export type AnswerEvent =
  | { type: 'OPEN' }
  | { type: 'OPEN_OK'; seq: number }
  | { type: 'OPEN_FAIL'; seq: number }
  | { type: 'LOAD_Q'; index: number; seq?: number }
  | { type: 'LOAD_OK'; seq: number }
  | { type: 'LOAD_FAIL'; seq: number }
  | { type: 'EDIT'; removeBoxId?: string; restoreBoxId?: string }
  | { type: 'SELECT'; boxId: string | null }
  | { type: 'CLEAR' }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'SAVE' }
  | { type: 'SAVE_OK' }
  | { type: 'SAVE_FAIL' }
  | { type: 'NAV_NEXT' }
  | { type: 'NAV_PREV' }
  | { type: 'NAV_JUMP'; index: number }
  | { type: 'REPLACE_ENTER'; questionId: number }
  | { type: 'REPLACE_EXIT' }
  | { type: 'BACK' }

export function createInitialAnswerState(): AnswerMachineState {
  return {
    phase: 'idle',
    mode: 'normal',
    dirty: false,
    seq: 0,
    requestSeq: null,
    requestKind: null,
    loadIndex: null,
    removedBoxIds: new Set<string>(),
    selectedBoxId: null,
    replaceQuestionId: null,
  }
}

export function resolveStateName(
  state: Pick<AnswerMachineState, 'phase' | 'mode' | 'dirty'>,
): AnswerStateName {
  if (state.phase !== 'ready') return state.phase
  // Invariant: replace mode is always dirty (save is required to persist/clear).
  if (state.mode === 'replacing') return 'ready.replacing.dirty'
  return state.dirty ? 'ready.dirty' : 'ready.clean'
}

function withRemoved(state: AnswerMachineState, ids: ReadonlySet<string>): AnswerMachineState {
  return { ...state, removedBoxIds: ids }
}

function clearedEditFields(state: AnswerMachineState): Pick<AnswerMachineState, 'dirty' | 'removedBoxIds' | 'selectedBoxId'> {
  return {
    dirty: state.mode === 'replacing',
    removedBoxIds: new Set<string>(),
    selectedBoxId: null,
  }
}

function isStaleSeq(state: AnswerMachineState, seq: number, against: 'seq' | 'requestSeq'): boolean {
  const ref = against === 'seq' ? state.seq : state.requestSeq
  return ref == null || seq !== ref
}

/**
 * Single transition function. Returns the next state, or null when the
 * event is ignored (illegal transition, saving lock, or stale response).
 */
export function reduceAnswer(state: AnswerMachineState, event: AnswerEvent): AnswerMachineState | null {
  const phase = state.phase
  const isSaving = phase === 'saving'
  const isReady = phase === 'ready'

  switch (event.type) {
    case 'OPEN': {
      if (isSaving || phase === 'replaceReturning') return null
      const seq = state.seq + 1
      return {
        ...state,
        phase: 'opening',
        // Preserve replace context when re-opening mid-replace.
        mode: state.mode,
        dirty: state.mode === 'replacing',
        seq,
        requestSeq: seq,
        requestKind: 'open',
        loadIndex: null,
        removedBoxIds: new Set<string>(),
        selectedBoxId: null,
      }
    }

    case 'OPEN_OK': {
      if (phase !== 'opening' || isStaleSeq(state, event.seq, 'seq')) return null
      return {
        ...state,
        phase: 'ready',
        dirty: state.mode === 'replacing',
        requestSeq: null,
        requestKind: null,
        loadIndex: null,
      }
    }

    case 'OPEN_FAIL': {
      if (phase !== 'opening' || isStaleSeq(state, event.seq, 'seq')) return null
      return {
        ...createInitialAnswerState(),
        seq: state.seq,
      }
    }

    case 'LOAD_Q': {
      if (isSaving || phase === 'idle' || phase === 'replaceReturning') return null
      // Explicit seq must join the active request; otherwise it is stale.
      if (event.seq != null && event.seq !== state.seq && event.seq !== state.requestSeq) return null
      const nextSeq = event.seq != null ? event.seq : state.seq + 1
      return {
        ...state,
        seq: Math.max(state.seq, nextSeq),
        requestSeq: nextSeq,
        requestKind: 'load',
        loadIndex: event.index,
        ...clearedEditFields(state),
      }
    }

    case 'LOAD_OK': {
      if (isStaleSeq(state, event.seq, 'requestSeq')) return null
      return {
        ...state,
        requestSeq: null,
        requestKind: null,
        loadIndex: null,
        ...clearedEditFields(state),
      }
    }

    case 'LOAD_FAIL': {
      if (isStaleSeq(state, event.seq, 'requestSeq')) return null
      return {
        ...state,
        requestSeq: null,
        requestKind: null,
        loadIndex: null,
      }
    }

    case 'EDIT': {
      if (isSaving || !isReady) return null
      let removed = state.removedBoxIds
      if (event.removeBoxId != null && event.removeBoxId !== '') {
        const next = new Set(removed)
        next.add(event.removeBoxId)
        removed = next
      }
      if (event.restoreBoxId != null && event.restoreBoxId !== '') {
        const next = new Set(removed)
        next.delete(event.restoreBoxId)
        removed = next
      }
      return { ...withRemoved(state, removed), dirty: true }
    }

    case 'SELECT': {
      if (isSaving || (!isReady && phase !== 'opening')) return null
      return { ...state, selectedBoxId: event.boxId }
    }

    case 'CLEAR': {
      // Clear is a real mutation: mark dirty. Never silently leave replace.
      if (isSaving || !isReady) return null
      return {
        ...state,
        dirty: true,
        selectedBoxId: null,
      }
    }

    case 'UNDO':
    case 'REDO': {
      if (isSaving || !isReady) return null
      return { ...state, dirty: true }
    }

    case 'SAVE': {
      // Double-click: only the first SAVE enters saving.
      if (!isReady) return null
      return {
        ...state,
        phase: 'saving',
        requestSeq: null,
        requestKind: null,
      }
    }

    case 'SAVE_OK': {
      if (phase !== 'saving') return null
      if (state.mode === 'replacing') {
        return {
          ...state,
          phase: 'replaceReturning',
          dirty: false,
          removedBoxIds: new Set<string>(),
          selectedBoxId: null,
          requestSeq: null,
          requestKind: null,
        }
      }
      return {
        ...state,
        phase: 'ready',
        dirty: false,
        removedBoxIds: new Set<string>(),
        selectedBoxId: null,
        requestSeq: null,
        requestKind: null,
      }
    }

    case 'SAVE_FAIL': {
      if (phase !== 'saving') return null
      return {
        ...state,
        phase: 'ready',
        dirty: true,
        requestSeq: null,
        requestKind: null,
      }
    }

    case 'NAV_NEXT':
    case 'NAV_PREV': {
      if (isSaving || (!isReady && phase !== 'opening')) return null
      return state
    }

    case 'NAV_JUMP': {
      if (isSaving || (!isReady && phase !== 'opening')) return null
      return { ...state, loadIndex: event.index }
    }

    case 'REPLACE_ENTER': {
      if (isSaving || phase === 'replaceReturning') return null
      return {
        ...state,
        mode: 'replacing',
        dirty: true,
        replaceQuestionId: event.questionId,
      }
    }

    case 'REPLACE_EXIT': {
      if (isSaving) return null
      return {
        ...state,
        mode: 'normal',
        replaceQuestionId: null,
      }
    }

    case 'BACK': {
      if (isSaving) return null
      return {
        ...createInitialAnswerState(),
        seq: state.seq,
      }
    }

    default: {
      // Exhaustiveness guard
      const _never: never = event
      void _never
      return null
    }
  }
}

export interface AnswerMachine {
  getState(): AnswerMachineState
  getStateName(): AnswerStateName
  /** Dispatch one event. Returns true when accepted, false when ignored/stale. */
  send(event: AnswerEvent): boolean
  /** True when the given seq is still the machine's latest request token. */
  isCurrentSeq(seq: number): boolean
  reset(): void
}

export function createAnswerMachine(initial?: Partial<AnswerMachineState>): AnswerMachine {
  let state: AnswerMachineState = { ...createInitialAnswerState(), ...initial }
  if (initial?.removedBoxIds) {
    state = { ...state, removedBoxIds: new Set(initial.removedBoxIds) }
  }

  return {
    getState() {
      return state
    },
    getStateName() {
      return resolveStateName(state)
    },
    send(event: AnswerEvent) {
      const next = reduceAnswer(state, event)
      if (next == null) return false
      state = next
      return true
    },
    isCurrentSeq(seq: number) {
      return state.seq === seq
    },
    reset() {
      state = createInitialAnswerState()
    },
  }
}

/**
 * Build up a machine until it reports `target`, using only legal events.
 * Throws when the target cannot be reached (test helper).
 */
export function primeAnswerMachine(target: AnswerStateName, seed?: Partial<AnswerMachineState>): AnswerMachine {
  const machine = createAnswerMachine(seed)

  const reachReady = (mode: AnswerMode, dirty: boolean) => {
    if (mode === 'replacing') machine.send({ type: 'REPLACE_ENTER', questionId: seed?.replaceQuestionId ?? 1 })
    if (!machine.send({ type: 'OPEN' })) throw new Error(`primeAnswerMachine: OPEN rejected for ${target}`)
    const seq = machine.getState().seq
    if (!machine.send({ type: 'LOAD_Q', index: 0, seq })) throw new Error(`primeAnswerMachine: LOAD_Q rejected for ${target}`)
    if (!machine.send({ type: 'LOAD_OK', seq })) throw new Error(`primeAnswerMachine: LOAD_OK rejected for ${target}`)
    if (!machine.send({ type: 'OPEN_OK', seq })) throw new Error(`primeAnswerMachine: OPEN_OK rejected for ${target}`)
    if (dirty && mode === 'normal') {
      if (!machine.send({ type: 'EDIT' })) throw new Error(`primeAnswerMachine: EDIT rejected for ${target}`)
    }
  }

  switch (target) {
    case 'idle':
      break
    case 'opening':
      if (!machine.send({ type: 'OPEN' })) throw new Error('primeAnswerMachine: OPEN rejected')
      break
    case 'ready.clean':
      reachReady('normal', false)
      break
    case 'ready.dirty':
      reachReady('normal', true)
      break
    case 'ready.replacing.dirty':
      reachReady('replacing', true)
      break
    case 'saving': {
      reachReady('normal', true)
      if (!machine.send({ type: 'SAVE' })) throw new Error('primeAnswerMachine: SAVE rejected')
      break
    }
    case 'replaceReturning': {
      reachReady('replacing', true)
      if (!machine.send({ type: 'SAVE' })) throw new Error('primeAnswerMachine: SAVE rejected')
      if (!machine.send({ type: 'SAVE_OK' })) throw new Error('primeAnswerMachine: SAVE_OK rejected')
      break
    }
    default: {
      const _never: never = target
      throw new Error(`primeAnswerMachine: unknown target ${String(_never)}`)
    }
  }

  const name = machine.getStateName()
  if (name !== target) {
    throw new Error(`primeAnswerMachine: reached ${name}, expected ${target}`)
  }
  return machine
}

/**
 * Assert a (state × event) transition for tests.
 * `expected` is the resulting state name, or 'ignored' when the event
 * must be dropped.
 */
export function assertTransition(
  from: AnswerStateName,
  event: AnswerEvent,
  expected: AnswerStateName | 'ignored',
): void {
  const machine = primeAnswerMachine(from)
  const before = machine.getStateName()
  if (before !== from) {
    throw new Error(`assertTransition: primed ${before}, expected ${from}`)
  }
  const accepted = machine.send(event)
  const after = machine.getStateName()
  const actual: AnswerStateName | 'ignored' = accepted ? after : 'ignored'
  if (actual !== expected) {
    throw new Error(`assertTransition: ${from} + ${event.type} => ${actual}, expected ${expected}`)
  }
}
