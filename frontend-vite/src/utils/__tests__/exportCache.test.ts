import { describe, it, expect, beforeEach } from 'vitest'
import {
  EXPORT_CACHE_KEYS,
  EXPORT_CACHE_MAX_ENTRIES,
  bumpCacheStat,
  buildFilterExportCacheKey,
  clearPersistedFilterIds,
  describeCacheOverview,
  emptyCacheStats,
  invalidateFilterCache,
  loadCacheStats,
  loadPersistedFilterIds,
  readCacheVersion,
  savePersistedFilterIds,
  writeCacheVersion,
} from '../exportCache'

function memStorage() {
  const mem = new Map<string, string>()
  return {
    mem,
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => {
      mem.set(k, String(v))
    },
    removeItem: (k: string) => {
      mem.delete(k)
    },
  }
}

describe('exportCache / key', () => {
  it('is order-insensitive for multi lists', () => {
    const a = buildFilterExportCacheKey({
      version: 1,
      section: 'A',
      paperMulti: ['2', '1'],
      yearMulti: ['2024', '2023'],
      seasonMulti: ['m'],
      favOnly: true,
      excludeMultiSection: false,
    })
    const b = buildFilterExportCacheKey({
      version: 1,
      section: 'A',
      paperMulti: ['1', '2'],
      yearMulti: ['2023', '2024'],
      seasonMulti: ['m'],
      favOnly: true,
      excludeMultiSection: false,
    })
    expect(a).toBe(b)
  })

  it('changes when version or flags change', () => {
    const base = {
      version: 1,
      section: 'A',
      paperMulti: [],
      yearMulti: [],
      seasonMulti: [],
      favOnly: false,
      excludeMultiSection: false,
    }
    expect(buildFilterExportCacheKey(base)).not.toBe(buildFilterExportCacheKey({ ...base, version: 2 }))
    expect(buildFilterExportCacheKey(base)).not.toBe(buildFilterExportCacheKey({ ...base, favOnly: true }))
  })
})

describe('exportCache / persisted ids', () => {
  let storage: ReturnType<typeof memStorage>

  beforeEach(() => {
    storage = memStorage()
  })

  it('round-trips ids', () => {
    savePersistedFilterIds(storage, 'k1', [1, 2, 3], 1000)
    expect(loadPersistedFilterIds(storage, 'k1', 5000, 1500)).toEqual([1, 2, 3])
  })

  it('expires after ttl', () => {
    savePersistedFilterIds(storage, 'k1', [1], 1000)
    expect(loadPersistedFilterIds(storage, 'k1', 500, 2000)).toBeNull()
  })

  it('prunes to max entries', () => {
    for (let i = 0; i < EXPORT_CACHE_MAX_ENTRIES + 5; i++) {
      savePersistedFilterIds(storage, `k${i}`, [i], 1000 + i)
    }
    const raw = storage.getItem(EXPORT_CACHE_KEYS.byKey)!
    const parsed = JSON.parse(raw)
    expect(Object.keys(parsed).length).toBe(EXPORT_CACHE_MAX_ENTRIES)
    // newest kept
    expect(parsed[`k${EXPORT_CACHE_MAX_ENTRIES + 4}`]).toBeTruthy()
    expect(parsed.k0).toBeUndefined()
  })

  it('clear removes both keys', () => {
    savePersistedFilterIds(storage, 'k', [1], 1)
    storage.setItem(EXPORT_CACHE_KEYS.latest, 'x')
    clearPersistedFilterIds(storage)
    expect(storage.getItem(EXPORT_CACHE_KEYS.byKey)).toBeNull()
    expect(storage.getItem(EXPORT_CACHE_KEYS.latest)).toBeNull()
  })
})

describe('exportCache / version and stats', () => {
  let storage: ReturnType<typeof memStorage>

  beforeEach(() => {
    storage = memStorage()
  })

  it('version defaults to 0 and bumps on invalidate', () => {
    expect(readCacheVersion(storage)).toBe(0)
    writeCacheVersion(storage, 3)
    expect(readCacheVersion(storage)).toBe(3)
    const next = invalidateFilterCache(storage)
    expect(next).toBe(4)
    expect(readCacheVersion(storage)).toBe(4)
    expect(storage.getItem(EXPORT_CACHE_KEYS.byKey)).toBeNull()
  })

  it('bumps stats counters', () => {
    const s1 = bumpCacheStat(storage, 'hit', 10)
    expect(s1.hit).toBe(1)
    expect(s1.lastHitAt).toBe(10)
    const s2 = bumpCacheStat(storage, 'miss', 20)
    expect(s2.miss).toBe(1)
    bumpCacheStat(storage, 'expired')
    bumpCacheStat(storage, 'write', 30)
    const s3 = loadCacheStats(storage)
    expect(s3.expired).toBe(1)
    expect(s3.write).toBe(1)
    expect(s3.lastWriteAt).toBe(30)
    expect(emptyCacheStats().hit).toBe(0)
  })

  it('describes overview of live entries only', () => {
    savePersistedFilterIds(storage, 'a', [1], 1000)
    savePersistedFilterIds(storage, 'b', [2], 2000)
    const o = describeCacheOverview(storage, 5000, 3000)
    expect(o.entryCount).toBe(2)
    expect(o.newestAgeMs).toBe(1000)
    expect(o.oldestAgeMs).toBe(2000)
    const o2 = describeCacheOverview(storage, 500, 3000)
    expect(o2.entryCount).toBe(0)
    expect(o2.newestAgeMs).toBeNull()
  })
})
