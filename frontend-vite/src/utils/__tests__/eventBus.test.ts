import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '../eventBus'

describe('eventBus', () => {
  beforeEach(() => eventBus.clear())

  it('calls listener on emit', () => {
    const fn = vi.fn()
    eventBus.on('test', fn)
    eventBus.emit('test', 'payload')
    expect(fn).toHaveBeenCalledWith('payload')
  })

  it('returns unsubscribe function', () => {
    const fn = vi.fn()
    const off = eventBus.on('test', fn)
    off()
    eventBus.emit('test')
    expect(fn).not.toHaveBeenCalled()
  })

  it('supports multiple listeners', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    eventBus.on('test', fn1)
    eventBus.on('test', fn2)
    eventBus.emit('test', 42)
    expect(fn1).toHaveBeenCalledWith(42)
    expect(fn2).toHaveBeenCalledWith(42)
  })

  it('once fires only once', () => {
    const fn = vi.fn()
    eventBus.once('test', fn)
    eventBus.emit('test', 1)
    eventBus.emit('test', 2)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(1)
  })

  it('off removes specific listener', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    eventBus.on('test', fn1)
    eventBus.on('test', fn2)
    eventBus.off('test', fn1)
    eventBus.emit('test')
    expect(fn1).not.toHaveBeenCalled()
    expect(fn2).toHaveBeenCalled()
  })

  it('off without fn removes all listeners for event', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    eventBus.on('test', fn1)
    eventBus.on('test', fn2)
    eventBus.off('test')
    eventBus.emit('test')
    expect(fn1).not.toHaveBeenCalled()
    expect(fn2).not.toHaveBeenCalled()
  })

  it('clear removes all listeners', () => {
    eventOn('a', vi.fn())
    eventOn('b', vi.fn())
    eventBus.clear()
    // No error on emit — just no listeners
    eventBus.emit('a')
    eventBus.emit('b')
  })

  it('does not throw if listener throws', () => {
    eventBus.on('test', () => { throw new Error('boom') })
    expect(() => eventBus.emit('test')).not.toThrow()
  })
})

function eventOn(event: string, fn: (payload: unknown) => void) {
  eventBus.on(event, fn)
}
