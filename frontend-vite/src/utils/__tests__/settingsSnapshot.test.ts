import { describe, it, expect, beforeEach, vi } from 'vitest'

const mem = new Map<string, string>()

function mockStorage() {
  const store = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => {
      mem.set(k, String(v))
    },
    removeItem: (k: string) => {
      mem.delete(k)
    },
    clear: () => mem.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true })
}

// localStorage must exist before settings/i18n modules load
mockStorage()
vi.mock('@/i18n', () => ({
  i18n: {
    global: { t: (k: string) => k },
  },
}))

describe('settings snapshot export/import', () => {
  beforeEach(async () => {
    mem.clear()
    mockStorage()
    const { setActivePinia, createPinia } = await import('pinia')
    setActivePinia(createPinia())
  })

  it('exports only known keys', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    localStorage.setItem('setting:ocrAutoEnabled', '1')
    localStorage.setItem('setting:locale', 'zh-CN')
    localStorage.setItem('theme', 'dark')
    localStorage.setItem('evil:key', 'should-not-export')
    const snap = useSettingsStore().exportSettingsSnapshot()
    expect(snap['setting:ocrAutoEnabled']).toBe('1')
    expect(snap['setting:locale']).toBe('zh-CN')
    expect(snap['theme']).toBe('dark')
    expect(snap['evil:key']).toBeUndefined()
  })

  it('imports only allowlisted keys and reloads store state', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()
    const imported = store.importSettingsSnapshot({
      'setting:ocrAutoEnabled': '1',
      'setting:ocrMinHeightPx': '88',
      'cieImport:recentSubjects': JSON.stringify([{ code: '9709', name: '数学' }]),
      'setting:cloudToken': 'tok',
      'not:allowed': 'x',
    })
    expect(imported).toContain('setting:ocrAutoEnabled')
    expect(imported).toContain('setting:cloudToken')
    expect(imported).not.toContain('not:allowed')
    expect(store.ocrAutoEnabled).toBe(true)
    expect(store.ocrMinHeightPx).toBe(88)
    expect(store.cloudToken).toBe('tok')
    expect(localStorage.getItem('not:allowed')).toBeNull()
  })

  it('round-trips export -> wipe -> import', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()
    localStorage.setItem('setting:alignLeftEnabled', '0')
    localStorage.setItem('cieImport:recentYears', JSON.stringify(['2023', '2024']))
    const snap = store.exportSettingsSnapshot()
    mem.clear()
    expect(localStorage.getItem('setting:alignLeftEnabled')).toBeNull()
    store.importSettingsSnapshot(snap)
    expect(localStorage.getItem('setting:alignLeftEnabled')).toBe('0')
    expect(JSON.parse(localStorage.getItem('cieImport:recentYears')!)).toEqual(['2023', '2024'])
    expect(store.alignLeftEnabled).toBe(false)
  })

  it('cloud token save/clear persists', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()
    store.saveCloudToken('abc')
    expect(localStorage.getItem('setting:cloudToken')).toBe('abc')
    store.saveCloudToken('')
    expect(localStorage.getItem('setting:cloudToken')).toBeNull()
    expect(store.cloudToken).toBe('')
  })

  it('import tolerates garbage payload', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()
    expect(store.importSettingsSnapshot(null)).toEqual([])
    expect(store.importSettingsSnapshot(undefined)).toEqual([])
    expect(store.importSettingsSnapshot('nope' as any)).toEqual([])
  })
})
