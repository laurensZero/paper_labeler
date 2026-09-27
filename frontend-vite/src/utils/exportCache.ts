/** Pure filter-export id cache helpers (storage injected). */

export const EXPORT_CACHE_TTL_MS = 6 * 60 * 60 * 1000
export const EXPORT_CACHE_MAX_ENTRIES = 12

export const EXPORT_CACHE_KEYS = {
  byKey: 'cache:exportFilterIdsByKey',
  latest: 'cache:exportFilterIdsLatest',
  stats: 'cache:exportFilterIdsStats',
  version: 'cache:exportFilterCacheVersion',
} as const

export interface ExportCacheStats {
  hit: number
  miss: number
  expired: number
  write: number
  lastHitAt: number
  lastMissAt: number
  lastWriteAt: number
}

export interface ExportCacheEntry {
  ids: number[]
  ts: number
}

export interface ExportCacheStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function emptyCacheStats(): ExportCacheStats {
  return { hit: 0, miss: 0, expired: 0, write: 0, lastHitAt: 0, lastMissAt: 0, lastWriteAt: 0 }
}

export function buildFilterExportCacheKey(payload: {
  version: number
  section: string
  paperMulti: string[]
  yearMulti: string[]
  seasonMulti: string[]
  favOnly: boolean
  excludeMultiSection: boolean
}): string {
  const body = {
    version: payload.version,
    section: payload.section || '',
    paperMulti: [...(payload.paperMulti || [])].sort(),
    yearMulti: [...(payload.yearMulti || [])].sort(),
    seasonMulti: [...(payload.seasonMulti || [])].sort(),
    favOnly: !!payload.favOnly,
    excludeMultiSection: !!payload.excludeMultiSection,
  }
  try {
    return JSON.stringify(body)
  } catch {
    return ''
  }
}

export function loadCacheStats(storage: ExportCacheStorage): ExportCacheStats {
  try {
    const raw = storage.getItem(EXPORT_CACHE_KEYS.stats)
    if (!raw) return emptyCacheStats()
    const parsed = JSON.parse(raw)
    return { ...emptyCacheStats(), ...parsed }
  } catch {
    return emptyCacheStats()
  }
}

export function bumpCacheStat(
  storage: ExportCacheStorage,
  kind: keyof ExportCacheStats,
  now = Date.now(),
): ExportCacheStats {
  const s = loadCacheStats(storage)
  if (kind === 'hit') {
    s.hit += 1
    s.lastHitAt = now
  } else if (kind === 'miss') {
    s.miss += 1
    s.lastMissAt = now
  } else if (kind === 'expired') {
    s.expired += 1
  } else if (kind === 'write') {
    s.write += 1
    s.lastWriteAt = now
  }
  try {
    storage.setItem(EXPORT_CACHE_KEYS.stats, JSON.stringify(s))
  } catch {
    /* ignore */
  }
  return s
}

export function readCacheVersion(storage: ExportCacheStorage): number {
  try {
    const raw = storage.getItem(EXPORT_CACHE_KEYS.version)
    if (raw == null) return 0
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
  } catch {
    return 0
  }
}

export function writeCacheVersion(storage: ExportCacheStorage, version: number): number {
  const v = Math.max(0, Math.floor(Number(version) || 0))
  try {
    storage.setItem(EXPORT_CACHE_KEYS.version, String(v))
  } catch {
    /* ignore */
  }
  return v
}

export function loadPersistedFilterIds(
  storage: ExportCacheStorage,
  cacheKey: string,
  ttlMs = EXPORT_CACHE_TTL_MS,
  now = Date.now(),
): number[] | null {
  if (!cacheKey) return null
  try {
    const raw = storage.getItem(EXPORT_CACHE_KEYS.byKey)
    const parsed = raw ? JSON.parse(raw) || {} : {}
    const item = parsed[cacheKey]
    if (!item || !Array.isArray(item.ids)) return null
    const ts = Number(item.ts || 0)
    if (!ts || now - ts > ttlMs) return null
    return item.ids.map((x: unknown) => Number(x)).filter((x: number) => Number.isFinite(x))
  } catch {
    return null
  }
}

export function savePersistedFilterIds(
  storage: ExportCacheStorage,
  cacheKey: string,
  ids: number[],
  now = Date.now(),
): void {
  if (!cacheKey) return
  try {
    const raw = storage.getItem(EXPORT_CACHE_KEYS.byKey)
    const parsed = raw ? JSON.parse(raw) || {} : {}
    parsed[cacheKey] = { ids: [...ids], ts: now }
    const entries = Object.entries(parsed as Record<string, ExportCacheEntry>).sort(
      (a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0),
    )
    const pruned = Object.fromEntries(entries.slice(0, EXPORT_CACHE_MAX_ENTRIES))
    storage.setItem(EXPORT_CACHE_KEYS.byKey, JSON.stringify(pruned))
  } catch {
    /* ignore */
  }
}

export function clearPersistedFilterIds(storage: ExportCacheStorage): void {
  try {
    storage.removeItem(EXPORT_CACHE_KEYS.byKey)
    storage.removeItem(EXPORT_CACHE_KEYS.latest)
  } catch {
    /* ignore */
  }
}

export function invalidateFilterCache(storage: ExportCacheStorage): number {
  clearPersistedFilterIds(storage)
  return writeCacheVersion(storage, readCacheVersion(storage) + 1)
}

export function describeCacheOverview(
  storage: ExportCacheStorage,
  ttlMs = EXPORT_CACHE_TTL_MS,
  now = Date.now(),
): {
  entryCount: number
  newestAgeMs: number | null
  oldestAgeMs: number | null
  ttlMs: number
} {
  let entryCount = 0
  let newestAgeMs: number | null = null
  let oldestAgeMs: number | null = null
  try {
    const raw = storage.getItem(EXPORT_CACHE_KEYS.byKey)
    const parsed = raw ? JSON.parse(raw) || {} : {}
    const ages: number[] = []
    for (const [, item] of Object.entries(parsed as Record<string, ExportCacheEntry>)) {
      if (!item || !Array.isArray(item.ids)) continue
      const ts = Number(item.ts || 0)
      if (!ts || now - ts > ttlMs) continue
      entryCount += 1
      ages.push(now - ts)
    }
    if (ages.length) {
      newestAgeMs = Math.min(...ages)
      oldestAgeMs = Math.max(...ages)
    }
  } catch {
    /* ignore */
  }
  return { entryCount, newestAgeMs, oldestAgeMs, ttlMs }
}
