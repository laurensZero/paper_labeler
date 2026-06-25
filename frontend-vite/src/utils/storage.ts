/**
 * Type-safe localStorage wrapper with automatic JSON serialization
 * and consistent try/catch handling for quota / SSR / private-mode errors.
 */
export const safeStorage = {
  /** Read a string value. Returns null if key is missing or read fails. */
  get(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },

  /** Read and JSON-parse a value. Returns fallback if key is missing or parse fails. */
  getJSON<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key)
      if (raw == null) return fallback
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  },

  /** Write a string value. Silently ignores write errors. */
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {}
  },

  /** JSON-stringify and write a value. Silently ignores write errors. */
  setJSON(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {}
  },

  /** Remove a key. Silently ignores errors. */
  remove(key: string): void {
    try {
      localStorage.removeItem(key)
    } catch {}
  },
}
