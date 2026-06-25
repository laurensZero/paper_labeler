import { describe, it, expect, beforeEach, vi } from 'vitest'
import { safeStorage } from '../storage'

// Mock localStorage
const store: Record<string, string> = {}
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value }),
  removeItem: vi.fn((key: string) => { delete store[key] }),
  clear: vi.fn(() => { for (const k in store) delete store[k] }),
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock })

describe('safeStorage', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
  })

  describe('get/set (string)', () => {
    it('returns null for missing key', () => {
      expect(safeStorage.get('missing')).toBeNull()
    })
    it('reads back a stored string', () => {
      safeStorage.set('key', 'value')
      expect(safeStorage.get('key')).toBe('value')
    })
  })

  describe('getJSON/setJSON', () => {
    it('returns fallback for missing key', () => {
      expect(safeStorage.getJSON('missing', 42)).toBe(42)
    })
    it('round-trips a JSON object', () => {
      const obj = { a: 1, b: [2, 3] }
      safeStorage.setJSON('obj', obj)
      expect(safeStorage.getJSON('obj', null)).toEqual(obj)
    })
    it('returns fallback on invalid JSON', () => {
      store['bad'] = 'not-json'
      expect(safeStorage.getJSON('bad', 'fallback')).toBe('fallback')
    })
  })

  describe('remove', () => {
    it('removes a key', () => {
      safeStorage.set('k', 'v')
      safeStorage.remove('k')
      expect(safeStorage.get('k')).toBeNull()
    })
  })

  describe('error handling', () => {
    it('get returns null on error', () => {
      localStorageMock.getItem.mockImplementationOnce(() => { throw new Error('fail') })
      expect(safeStorage.get('x')).toBeNull()
    })
    it('set does not throw on error', () => {
      localStorageMock.setItem.mockImplementationOnce(() => { throw new Error('quota') })
      expect(() => safeStorage.set('x', 'y')).not.toThrow()
    })
    it('getJSON returns fallback on error', () => {
      localStorageMock.getItem.mockImplementationOnce(() => { throw new Error('fail') })
      expect(safeStorage.getJSON('x', 'fb')).toBe('fb')
    })
  })
})
