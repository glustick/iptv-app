import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadSettings,
  saveSettings,
  saveFavorites,
  loadFavorites,
  loadRecentlyWatched,
  saveFavoriteGroups,
  loadFavoriteGroups
} from './storage'
import { DEFAULT_SETTINGS } from './types'
import type { FavoriteEntry, FavoriteGroup } from './types'

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

  it('resets list/object fields persisted with a wrong shape instead of crashing or hiding UI', async () => {
    // Seeded raw (bypassing saveSettings, which would itself trip over the bad vpnProfiles
    // shape) — this simulates a partially-written or externally-corrupted settings file.
    localStorage.setItem(
      'settings',
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        customEpgUrls: 'http://x.xml',
        epgChannelMappings: null,
        vpnProfiles: {},
        hiddenLiveStreamIds: '42',
        liveAudioFixes: []
      })
    )
    const loaded = await loadSettings()
    expect(loaded.customEpgUrls).toEqual([])
    expect(loaded.epgChannelMappings).toEqual([])
    expect(loaded.vpnProfiles).toEqual([])
    expect(loaded.hiddenChannelKeys).toEqual([])
    // A non-object liveAudioFixes has nothing to migrate; the unified memory is left empty.
    expect(loaded.transcodeMemory).toEqual({})
  })

  it('migrates legacy liveAudioFixes entries into transcodeMemory (0.17.0 unification)', async () => {
    localStorage.setItem(
      'settings',
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        liveAudioFixes: {
          '42': { audioIndex: 0, url: 'http://example.com/live/42.m3u8' },
          '7': { audioIndex: 2, url: 'http://example.com/live/7.m3u8' },
          broken: { audioIndex: 'nope' },
          alsobroken: { url: 'no-index' }
        }
      })
    )
    const loaded = await loadSettings()
    // Well-formed entries land as audio outcomes with a fresh confirmedAt (so the prune's
    // oldest-first ordering never evicts them ahead of genuinely newer entries)…
    expect(loaded.transcodeMemory['42']).toMatchObject({
      kind: 'audio', audioIndex: 0, url: 'http://example.com/live/42.m3u8'
    })
    expect(loaded.transcodeMemory['42'].confirmedAt).toBeGreaterThan(0)
    expect(loaded.transcodeMemory['7']).toMatchObject({
      kind: 'audio', audioIndex: 2, url: 'http://example.com/live/7.m3u8'
    })
    // …malformed ones are skipped rather than migrated into junk…
    expect(loaded.transcodeMemory['broken']).toBeUndefined()
    expect(loaded.transcodeMemory['alsobroken']).toBeUndefined()
    // …the legacy field is gone, and an existing transcodeMemory entry for the same key wins
    // over the legacy one (the live outcome already recorded is the more specific truth).
    expect('liveAudioFixes' in loaded).toBe(false)
  })

  it('migration never overwrites an existing transcodeMemory entry for the same key', async () => {
    const now = Date.now()
    localStorage.setItem(
      'settings',
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        liveAudioFixes: { '42': { audioIndex: 0, url: 'http://old.example/live/42.m3u8' } },
        transcodeMemory: {
          '42': { kind: 'rawTs', url: 'http://new.example/live/42.ts', confirmedAt: now }
        }
      })
    )
    const loaded = await loadSettings()
    expect(loaded.transcodeMemory['42']).toMatchObject({ kind: 'rawTs', url: 'http://new.example/live/42.ts' })
  })

  it('keeps well-shaped values untouched by the hardening pass', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, customEpgUrls: ['http://a.xml'], hiddenChannelKeys: ['7'] })
    const loaded = await loadSettings()
    expect(loaded.customEpgUrls).toEqual(['http://a.xml'])
    expect(loaded.hiddenChannelKeys).toEqual(['7'])
  })

  it('merges a partial stored settings object over the current defaults', async () => {
    localStorage.setItem('settings', JSON.stringify({ clockFormat: '24h' }))
    const loaded = await loadSettings()
    expect(loaded.clockFormat).toBe('24h')
    expect(loaded.bufferProfile).toBe('smooth')
    expect(loaded.epgRowDensity).toBe('comfortable')
  })

  it('round-trips a parental PIN as plain text when there is no Electron main process to encrypt it with (hasElectronApi() is false in this test environment, same as a browser/dev-preview context)', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, parentalPin: '1234' })
    const loaded = await loadSettings()
    expect(loaded.parentalPin).toBe('1234')
  })

  it('treats an "enc:"-prefixed PIN as unrecoverable without Electron rather than throwing', async () => {
    localStorage.setItem('settings', JSON.stringify({ parentalPin: 'enc:c29tZWNpcGhlcnRleHQ=' }))
    const loaded = await loadSettings()
    // Unset in memory (fail-open) — and since the hardening, the stored ciphertext survives
    // persistence too (see the undecryptable-secrets block below).
    expect(loaded.parentalPin).toBe('')
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

  it('saves and loads favorite groups through the same fallback store', async () => {
    const groups: FavoriteGroup[] = [{ id: 'g1', name: 'Sports' }]
    await saveFavoriteGroups(groups)
    expect(await loadFavoriteGroups()).toEqual(groups)
  })

  it('loads an empty array of favorite groups when nothing has been saved yet', async () => {
    expect(await loadFavoriteGroups()).toEqual([])
  })
})

// --- Undecryptable secrets survive persistence ----------------------------------------------
//
// The real incident (2026-10-11): a background/smoke launch of the app couldn't answer the
// macOS keychain prompt, every safeStorage decrypt failed, the values loaded as unset — and the
// next settings save wrote those empty values back over the real ciphertexts, wiping them. The
// fix records undecryptable ciphertexts at load and restores them at save unless a replacement
// has been entered. These tests drive the failure path through a window.api stub whose decrypt
// always rejects.
describe('undecryptable secrets survive persistence', () => {
  const CIPHER_PIN = 'enc:pin-ciphertext'
  const CIPHER_KEY = 'enc:api-key-ciphertext'

  function installFailingSafeStorage(): { stored: Map<string, unknown> } {
    const stored = new Map<string, unknown>()
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        store: {
          get: async (key: string) => stored.get(key),
          set: async (key: string, value: unknown) => {
            stored.set(key, value)
          }
        },
        safeStorage: {
          isAvailable: async () => true,
          encrypt: async (plain: string) => `re-encrypted(${plain})`,
          // The keychain denial: every decrypt of stored ciphertext fails.
          decrypt: async () => {
            throw new Error('Decryption is not available')
          }
        }
      }
    }
    return { stored }
  }

  it('keeps the stored ciphertext on disk while the app reads the secret as unset', async () => {
    const { stored } = installFailingSafeStorage()
    stored.set('settings', { ...DEFAULT_SETTINGS, parentalPin: CIPHER_PIN, apiFootballKey: CIPHER_KEY })

    const loaded = await loadSettings()
    expect(loaded.parentalPin).toBe('')
    expect(loaded.apiFootballKey).toBe('')

    // Any unrelated settings change persists everything — this is the write that used to wipe.
    await saveSettings({ ...loaded, sidebarWidth: 321 })

    const onDisk = stored.get('settings') as { parentalPin: string; apiFootballKey: string }
    expect(onDisk.parentalPin).toBe(CIPHER_PIN)
    expect(onDisk.apiFootballKey).toBe(CIPHER_KEY)

    // And a launch that CAN decrypt (a healthy GUI launch) gets the real secrets back: the
    // same stub with a working decrypt reads the surviving ciphertexts.
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        store: {
          get: async (key: string) => stored.get(key),
          set: async (key: string, value: unknown) => {
            stored.set(key, value)
          }
        },
        safeStorage: {
          isAvailable: async () => true,
          encrypt: async (plain: string) => `re-encrypted(${plain})`,
          decrypt: async (base64: string) => `decrypted(${base64})`
        }
      }
    }
    const healthy = await loadSettings()
    expect(healthy.parentalPin).toBe('decrypted(pin-ciphertext)')
    expect(healthy.apiFootballKey).toBe('decrypted(api-key-ciphertext)')
  })

  it('drops the record and re-encrypts when the user enters a replacement', async () => {
    const { stored } = installFailingSafeStorage()
    stored.set('settings', { ...DEFAULT_SETTINGS, apiFootballKey: CIPHER_KEY })
    const loaded = await loadSettings()
    expect(loaded.apiFootballKey).toBe('')

    // The user re-enters the key in Settings.
    await saveSettings({ ...loaded, apiFootballKey: 'my-real-key' })
    const onDisk = stored.get('settings') as { apiFootballKey: string }
    expect(onDisk.apiFootballKey).toBe('enc:re-encrypted(my-real-key)')

    // The old ciphertext is obsolete: the record must not resurrect it on the next save.
    await saveSettings({ ...(await loadSettings()), sidebarWidth: 250 })
    const after = stored.get('settings') as { apiFootballKey: string }
    expect(after.apiFootballKey).toBe('enc:re-encrypted(my-real-key)')
  })

  it('restores undecryptable VPN credentials per profile and forgets removed ones', async () => {
    const { stored } = installFailingSafeStorage()
    stored.set('settings', {
      ...DEFAULT_SETTINGS,
      vpnProfiles: [
        { id: 'vpn-1', name: 'Tunnel', ovpnContent: 'cert-only', username: 'enc:user-cipher', password: 'enc:pass-cipher' },
        { id: 'vpn-2', name: 'Cleared', ovpnContent: 'cert-only', username: null, password: null }
      ]
    })
    const loaded = await loadSettings()
    expect(loaded.vpnProfiles[0].username).toBeNull()
    expect(loaded.vpnProfiles[0].password).toBeNull()

    await saveSettings({ ...loaded, sidebarWidth: 300 })
    const onDisk = stored.get('settings') as { vpnProfiles: Array<{ id: string; username: string | null; password: string | null }> }
    expect(onDisk.vpnProfiles[0].username).toBe('enc:user-cipher')
    expect(onDisk.vpnProfiles[0].password).toBe('enc:pass-cipher')
    expect(onDisk.vpnProfiles[1].username).toBeNull()
  })
})
