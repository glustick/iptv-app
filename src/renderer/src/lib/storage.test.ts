import { describe, it, expect, beforeEach } from 'vitest'
import { loadSettings, saveSettings, saveFavorites, loadFavorites, loadRecentlyWatched } from './storage'
import { DEFAULT_SETTINGS } from './types'
import type { FavoriteEntry } from './types'

// The vitest environment is plain Node (see vitest.config.mts), which has neither `window` nor
// `localStorage` — storage.ts's hasElectronApi() check is what makes it fall back to
// localStorage in that case, so this stub is what actually lets these tests exercise the real
// code path (not electron's window.api.store) without needing a full Electron/IPC mock.
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage()
})

describe('loadSettings', () => {
  it('returns DEFAULT_SETTINGS when nothing is stored', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('drops legacy bare (un-namespaced) locked-category IDs but keeps namespaced ones', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, lockedCategoryIds: ['12', 'live:12', 'movies:7', '7'] })
    const loaded = await loadSettings()
    expect(loaded.lockedCategoryIds).toEqual(['live:12', 'movies:7'])
  })

  it('merges a partial stored settings object over the current defaults', async () => {
    localStorage.setItem('settings', JSON.stringify({ clockFormat: '24h' }))
    const loaded = await loadSettings()
    expect(loaded.clockFormat).toBe('24h')
    expect(loaded.bufferProfile).toBe('smooth')
    expect(loaded.epgRowDensity).toBe('comfortable')
  })
})

describe('favorites / recently-watched round trip', () => {
  it('saves and loads favorites through the same fallback store', async () => {
    const favorites: FavoriteEntry[] = [{ kind: 'movie', stream: { stream_id: 1 } as never }]
    await saveFavorites(favorites)
    expect(await loadFavorites()).toEqual(favorites)
  })

  it('loads an empty array when nothing has been saved yet', async () => {
    expect(await loadRecentlyWatched()).toEqual([])
  })
})
