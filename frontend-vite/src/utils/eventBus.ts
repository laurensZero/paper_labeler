type Listener<T = unknown> = (payload: T) => void

/**
 * Lightweight typed event bus for cross-store communication.
 * Decouples stores that currently call each other directly.
 *
 * Usage:
 *   // Define events
 *   interface AppEvents {
 *     'paper:changed': { paperId: number }
 *     'question:saved': { questionId: number }
 *   }
 *
 *   // Emit
 *   eventBus.emit('paper:changed', { paperId: 42 })
 *
 *   // Listen
 *   const off = eventBus.on('paper:changed', ({ paperId }) => { ... })
 *   off() // unsubscribe
 */
class EventBus {
  private listeners = new Map<string, Set<Listener>>()

  on<T = unknown>(event: string, fn: Listener<T>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(fn as Listener)
    return () => {
      this.listeners.get(event)?.delete(fn as Listener)
      if (this.listeners.get(event)?.size === 0) this.listeners.delete(event)
    }
  }

  once<T = unknown>(event: string, fn: Listener<T>): () => void {
    const wrapper: Listener<T> = (payload) => {
      off()
      fn(payload)
    }
    const off = this.on(event, wrapper)
    return off
  }

  emit<T = unknown>(event: string, payload?: T): void {
    const fns = this.listeners.get(event)
    if (!fns) return
    for (const fn of fns) {
      try { fn(payload) } catch (e) { console.error(`[eventBus] Error in listener for "${event}":`, e) }
    }
  }

  off(event: string, fn?: Listener): void {
    if (!fn) {
      this.listeners.delete(event)
      return
    }
    this.listeners.get(event)?.delete(fn)
    if (this.listeners.get(event)?.size === 0) this.listeners.delete(event)
  }

  /** Remove all listeners (useful for testing). */
  clear(): void {
    this.listeners.clear()
  }
}

export const eventBus = new EventBus()
