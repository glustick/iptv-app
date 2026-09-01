import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAppStore } from './useAppStore'
import { XtreamClient } from '../lib/xtream'
import { DEFAULT_SETTINGS } from '../lib/types'
import type { LiveStream, VodStream, FavoriteEntry, RecentlyWatchedEntry, VpnProfile, XtreamProfile } from '../lib/types'

// Same rationale as storage.test.ts: the vitest environment is plain Node (see
// vitest.config.mts), so useAppStore's own calls into lib/storage.ts (updateSettings,
// toggleFavorite's saveFavorites, etc.) need a localStorage fallback rather than a real
// Electron window.api.store to actually exercise the real code path.
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
  // Reset just the plain-data fields between tests — the store is a single module-level
  // singleton (create() bundles state and actions into one object), so a full replace would
  // wipe out the action functions too; a partial update merges instead.
  useAppStore.setState({
    client: null,
    viewMode: 'live',
    settings: DEFAULT_SETTINGS,
    unlockedCategoryIds: [],
    pinPromptCategoryId: null,
    pinPromptError: null,
    shortEpgByStream: {},
    nowPlaying: null,
    recentlyWatched: [],
    favorites: []
  })
})

describe('locked-category namespacing (requestCategory / setCategoryLocked)', () => {
  it('prompts for a PIN when the current view mode\'s namespaced key is locked', () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, parentalPin: '1234' }, viewMode: 'live' })
    useAppStore.getState().setCategoryLocked('live:12', true)

    useAppStore.getState().requestCategory('12')

    expect(useAppStore.getState().pinPromptCategoryId).toBe('12')
  })

  it('does not prompt for the same raw category ID under a different, unlocked view mode', () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, parentalPin: '1234' }, viewMode: 'movies' })
    useAppStore.getState().setCategoryLocked('live:12', true)

    // Same raw "12", but movies:12 was never locked — only live:12 was.
    useAppStore.getState().requestCategory('12')

    expect(useAppStore.getState().pinPromptCategoryId).toBeNull()
  })

  it('does not re-prompt once the namespaced key has already been unlocked this session', () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, parentalPin: '1234' },
      viewMode: 'live',
      unlockedCategoryIds: ['live:12']
    })
    useAppStore.getState().setCategoryLocked('live:12', true)

    useAppStore.getState().requestCategory('12')

    expect(useAppStore.getState().pinPromptCategoryId).toBeNull()
  })

  it('unlocking a category leaves other locked categories untouched', () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, parentalPin: '1234' } })
    useAppStore.getState().setCategoryLocked('live:12', true)
    useAppStore.getState().setCategoryLocked('live:7', true)
    useAppStore.getState().setCategoryLocked('live:12', false)

    expect(useAppStore.getState().settings.lockedCategoryIds).toEqual(['live:7'])
  })
})

describe('submitPinAttempt', () => {
  beforeEach(() => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, parentalPin: '1234' },
      viewMode: 'live',
      pinPromptCategoryId: '12',
      pinPromptError: null,
      unlockedCategoryIds: []
    })
  })

  it('sets an error and leaves the category locked on an incorrect PIN', () => {
    useAppStore.getState().submitPinAttempt('0000')

    const state = useAppStore.getState()
    expect(state.pinPromptError).toBe('Incorrect PIN')
    expect(state.pinPromptCategoryId).toBe('12')
    expect(state.unlockedCategoryIds).toEqual([])
  })

  it('unlocks the namespaced key and clears the prompt on a correct PIN', () => {
    useAppStore.getState().submitPinAttempt('1234')

    const state = useAppStore.getState()
    expect(state.pinPromptCategoryId).toBeNull()
    expect(state.pinPromptError).toBeNull()
    expect(state.unlockedCategoryIds).toEqual(['live:12'])
  })

  it('is a no-op when there is no pending PIN prompt', () => {
    useAppStore.setState({ pinPromptCategoryId: null })

    expect(() => useAppStore.getState().submitPinAttempt('1234')).not.toThrow()
    expect(useAppStore.getState().unlockedCategoryIds).toEqual([])
  })
})

describe('short-EPG concurrency queue (loadShortEpg)', () => {
  // A controllable client lets the test observe exactly how many fetches are in flight before
  // any of them resolve, rather than racing real async timing.
  function makeControllableClient(): {
    client: XtreamClient
    resolveNext: (streamId: number) => void
    callCount: () => number
  } {
    const client = new XtreamClient('http://example.com', 'user', 'pass')
    const pending = new Map<number, () => void>()
    const calls: number[] = []
    vi.spyOn(client, 'getShortEpg').mockImplementation(
      (streamId: number) =>
        new Promise((resolve) => {
          calls.push(streamId)
          pending.set(streamId, () => resolve([]))
        })
    )
    return {
      client,
      resolveNext: (streamId) => {
        pending.get(streamId)?.()
        pending.delete(streamId)
      },
      callCount: () => calls.length
    }
  }

  it('caps concurrent get_short_epg requests at 4, queueing the rest', async () => {
    const { client, resolveNext, callCount } = makeControllableClient()
    useAppStore.setState({ client })

    // Distinct, high stream IDs so this test can't collide with shortEpgInFlight/shortEpgByStream
    // state possibly left over from another test in this same module instance.
    const streamIds = [90001, 90002, 90003, 90004, 90005, 90006]
    const pendingCalls = streamIds.map((id) => useAppStore.getState().loadShortEpg(id))

    // Synchronous right after issuing all 6 — only the first 4 should have actually reached the
    // mocked client; the rest are sitting in shortEpgQueue waiting for a slot to free up.
    expect(callCount()).toBe(4)

    resolveNext(streamIds[0])
    await Promise.resolve()
    await Promise.resolve()
    expect(callCount()).toBe(5)

    resolveNext(streamIds[1])
    await Promise.resolve()
    await Promise.resolve()
    expect(callCount()).toBe(6)

    // Drain everything so activeShortEpgFetches/shortEpgInFlight don't leak into another test.
    for (const id of streamIds.slice(2)) resolveNext(id)
    await Promise.all(pendingCalls)
  })

  it('does not re-fetch a stream whose short EPG is already loaded', async () => {
    const { client, resolveNext, callCount } = makeControllableClient()
    useAppStore.setState({ client, shortEpgByStream: { 90101: [] } })

    await Promise.resolve(useAppStore.getState().loadShortEpg(90101))

    expect(callCount()).toBe(0)
    void resolveNext
  })
})

describe('tvArchive threading through play()', () => {
  function makeClient(): XtreamClient {
    const client = new XtreamClient('http://example.com', 'user', 'pass')
    vi.spyOn(client, 'getStreamUrl').mockReturnValue('http://example.com/stream')
    return client
  }

  it('carries tvArchive from play() into both nowPlaying and the recently-watched entry', () => {
    useAppStore.setState({ client: makeClient() })

    useAppStore.getState().play('live', 501, 'Channel With Catchup', 'm3u8', 'icon.png', 1)

    const state = useAppStore.getState()
    expect(state.nowPlaying?.tvArchive).toBe(1)
    expect(state.recentlyWatched[0].tvArchive).toBe(1)
  })

  it('defaults tvArchive to 0 when not provided, without disturbing other entries already in recentlyWatched', () => {
    useAppStore.setState({ client: makeClient() })

    useAppStore.getState().play('live', 501, 'Channel With Catchup', 'm3u8', 'icon.png', 1)
    useAppStore.getState().play('live', 502, 'Channel Without Catchup', 'm3u8', 'icon.png')

    const { recentlyWatched } = useAppStore.getState()
    expect(recentlyWatched.find((e) => e.streamId === 502)?.tvArchive).toBe(0)
    expect(recentlyWatched.find((e) => e.streamId === 501)?.tvArchive).toBe(1)
  })

  it('replaces (does not duplicate) an existing recently-watched entry for the same channel', () => {
    useAppStore.setState({ client: makeClient() })

    useAppStore.getState().play('live', 501, 'Channel', 'm3u8', 'icon.png', 0)
    useAppStore.getState().play('live', 501, 'Channel', 'm3u8', 'icon.png', 1)

    const { recentlyWatched } = useAppStore.getState()
    expect(recentlyWatched.filter((e) => e.streamId === 501)).toHaveLength(1)
    expect(recentlyWatched[0].tvArchive).toBe(1)
  })
})

describe('toggleFavorite / isFavorited', () => {
  it('adds then removes the same entry on repeated toggles', () => {
    const entry: FavoriteEntry = { kind: 'live', stream: { stream_id: 42 } as unknown as LiveStream }

    useAppStore.getState().toggleFavorite(entry)
    expect(useAppStore.getState().isFavorited('live', 42)).toBe(true)

    useAppStore.getState().toggleFavorite(entry)
    expect(useAppStore.getState().isFavorited('live', 42)).toBe(false)
  })
})

describe('VPN toggle (toggleVpnTunnel) and lastVpnProfileId', () => {
  const profileA: VpnProfile = { id: 'a', name: 'A', configPath: '/a.ovpn', configName: 'a.ovpn', username: null, password: null }
  const profileB: VpnProfile = { id: 'b', name: 'B', configPath: '/b.ovpn', configName: 'b.ovpn', username: null, password: null }

  beforeEach(() => {
    // window.api is a real contextBridge-frozen object in the packaged app (see Player.tsx's
    // and TopBar.tsx's own VPN dot) — plain Node here, so a fresh mock per test is safe and
    // doesn't risk touching a real OpenVPN process the way overriding it inside an actual
    // Electron renderer would (contextBridge silently ignores that kind of reassignment there).
    ;(globalThis as unknown as { window: { api: { vpn: Record<string, unknown> } } }).window = {
      api: {
        vpn: {
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          removeImportedConfig: vi.fn().mockResolvedValue(undefined)
        }
      }
    }
    useAppStore.setState({ vpnStatus: 'disconnected' })
  })

  it('falls back to the first saved profile when nothing has ever been activated', async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, vpnProfiles: [profileA, profileB] } })

    await useAppStore.getState().toggleVpnTunnel()

    expect(window.api.vpn.connect).toHaveBeenCalledWith(profileA.configPath, null, null)
    expect(useAppStore.getState().settings.activeVpnProfileId).toBe('a')
    expect(useAppStore.getState().settings.lastVpnProfileId).toBe('a')
  })

  it('reconnects to lastVpnProfileId, not just the first profile, once one has been set', async () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, vpnProfiles: [profileA, profileB], lastVpnProfileId: 'b' }
    })

    await useAppStore.getState().toggleVpnTunnel()

    expect(window.api.vpn.connect).toHaveBeenCalledWith(profileB.configPath, null, null)
    expect(useAppStore.getState().settings.activeVpnProfileId).toBe('b')
  })

  it('disconnects (rather than reconnecting) when the tunnel is connected or connecting', async () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, vpnProfiles: [profileA], activeVpnProfileId: 'a', lastVpnProfileId: 'a' },
      vpnStatus: 'connected'
    })

    await useAppStore.getState().toggleVpnTunnel()

    expect(window.api.vpn.disconnect).toHaveBeenCalled()
    expect(window.api.vpn.connect).not.toHaveBeenCalled()

    useAppStore.setState({ vpnStatus: 'connecting' })
    await useAppStore.getState().toggleVpnTunnel()
    expect(window.api.vpn.disconnect).toHaveBeenCalledTimes(2)
  })

  it('preserves lastVpnProfileId across a deactivate, unlike activeVpnProfileId', async () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, vpnProfiles: [profileA], activeVpnProfileId: 'a', lastVpnProfileId: 'a' },
      vpnStatus: 'connected'
    })

    await useAppStore.getState().deactivateVpnProfile()

    expect(useAppStore.getState().settings.activeVpnProfileId).toBeNull()
    expect(useAppStore.getState().settings.lastVpnProfileId).toBe('a')
  })

  it('clears lastVpnProfileId when that exact profile is removed, but not when a different one is', async () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, vpnProfiles: [profileA, profileB], lastVpnProfileId: 'a' }
    })

    await useAppStore.getState().removeVpnProfile('b')
    expect(useAppStore.getState().settings.lastVpnProfileId).toBe('a')

    await useAppStore.getState().removeVpnProfile('a')
    expect(useAppStore.getState().settings.lastVpnProfileId).toBeNull()
  })

  it('does nothing if disconnected with no saved profiles at all', async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, vpnProfiles: [] } })

    await useAppStore.getState().toggleVpnTunnel()

    expect(window.api.vpn.connect).not.toHaveBeenCalled()
  })
})

describe('auto-update actions', () => {
  beforeEach(() => {
    ;(globalThis as unknown as { window: { api: { updater: Record<string, unknown> } } }).window = {
      api: {
        updater: {
          check: vi.fn().mockResolvedValue(undefined),
          download: vi.fn().mockResolvedValue(undefined),
          install: vi.fn().mockResolvedValue(undefined)
        }
      }
    }
    useAppStore.setState({ updateInfo: null, updateDownloadPercent: null, updateDownloaded: false, updateError: null, updateDismissed: false })
  })

  it('checkForUpdates calls window.api.updater.check and clears any previous error', async () => {
    useAppStore.setState({ updateError: 'stale error from a previous attempt' })

    await useAppStore.getState().checkForUpdates()

    expect(window.api.updater.check).toHaveBeenCalled()
    expect(useAppStore.getState().updateError).toBeNull()
  })

  it('downloadUpdate sets updateDownloadPercent to 0 immediately and calls window.api.updater.download', async () => {
    const promise = useAppStore.getState().downloadUpdate()
    expect(useAppStore.getState().updateDownloadPercent).toBe(0)
    await promise

    expect(window.api.updater.download).toHaveBeenCalled()
  })

  it('downloadUpdate records a visible error and resets progress if the download itself fails', async () => {
    ;(window.api.updater.download as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network unreachable'))

    await useAppStore.getState().downloadUpdate()

    expect(useAppStore.getState().updateError).toBe('network unreachable')
    expect(useAppStore.getState().updateDownloadPercent).toBeNull()
  })

  it('installUpdate calls window.api.updater.install', () => {
    useAppStore.getState().installUpdate()

    expect(window.api.updater.install).toHaveBeenCalled()
  })

  it('dismissUpdatePrompt sets updateDismissed', () => {
    useAppStore.getState().dismissUpdatePrompt()

    expect(useAppStore.getState().updateDismissed).toBe(true)
  })
})

describe('recently-watched cap', () => {
  it('play() caps recentlyWatched at 100 entries, keeping the most recent', () => {
    const client = new XtreamClient('http://example.com', 'user', 'pass')
    vi.spyOn(client, 'getStreamUrl').mockReturnValue('http://example.com/stream')
    useAppStore.setState({ client })

    for (let i = 0; i < 105; i++) {
      useAppStore.getState().play('live', i, `Channel ${i}`, 'm3u8', 'icon.png')
    }

    const { recentlyWatched } = useAppStore.getState()
    expect(recentlyWatched).toHaveLength(100)
    expect(recentlyWatched[0].streamId).toBe(104)
    expect(recentlyWatched.find((e) => e.streamId === 0)).toBeUndefined()
  })
})

describe('clearRecentlyWatched', () => {
  it('empties recentlyWatched', () => {
    useAppStore.setState({
      recentlyWatched: [
        { kind: 'live', streamId: 1, name: 'A', icon: '', extension: 'm3u8', tvArchive: 0, watchedAt: Date.now() }
      ]
    })

    useAppStore.getState().clearRecentlyWatched()

    expect(useAppStore.getState().recentlyWatched).toEqual([])
  })
})

describe('refreshRecentlyWatched', () => {
  function makeEntry(overrides: Partial<RecentlyWatchedEntry>): RecentlyWatchedEntry {
    return {
      kind: 'live',
      streamId: 1,
      name: 'Old Name',
      icon: 'old-icon.png',
      extension: 'm3u8',
      tvArchive: 0,
      watchedAt: Date.now(),
      ...overrides
    }
  }

  beforeEach(() => {
    useAppStore.setState({ refreshingRecentlyWatched: false, activeProfile: null })
  })

  it('updates a live entry\'s name/icon/tvArchive from the current catalog', async () => {
    const client = new XtreamClient('http://example.com', 'user', 'pass')
    vi.spyOn(client, 'getLiveStreams').mockResolvedValue([
      { stream_id: 1, name: 'New Name', stream_icon: 'new-icon.png', tv_archive: 1 } as unknown as LiveStream
    ])
    useAppStore.setState({ client, recentlyWatched: [makeEntry({ streamId: 1 })] })

    await useAppStore.getState().refreshRecentlyWatched()

    const entry = useAppStore.getState().recentlyWatched[0]
    expect(entry.name).toBe('New Name')
    expect(entry.icon).toBe('new-icon.png')
    expect(entry.tvArchive).toBe(1)
  })

  it('updates a movie entry the same way, from getVodStreams', async () => {
    const client = new XtreamClient('http://example.com', 'user', 'pass')
    vi.spyOn(client, 'getVodStreams').mockResolvedValue([
      { stream_id: 2, name: 'New Movie Name', stream_icon: 'new-poster.png' } as unknown as VodStream
    ])
    useAppStore.setState({
      client,
      recentlyWatched: [makeEntry({ kind: 'movie', streamId: 2, name: 'Old Movie Name' })]
    })

    await useAppStore.getState().refreshRecentlyWatched()

    const entry = useAppStore.getState().recentlyWatched[0]
    expect(entry.name).toBe('New Movie Name')
    expect(entry.icon).toBe('new-poster.png')
  })

  it('leaves an entry untouched (does not delete it) when not found in the fetched catalog', async () => {
    const client = new XtreamClient('http://example.com', 'user', 'pass')
    vi.spyOn(client, 'getLiveStreams').mockResolvedValue([])
    const original = makeEntry({ streamId: 999, name: 'Possibly Removed Channel' })
    useAppStore.setState({ client, recentlyWatched: [original] })

    await useAppStore.getState().refreshRecentlyWatched()

    expect(useAppStore.getState().recentlyWatched).toEqual([original])
  })

  it('never touches series entries — there is no per-episode catalog to check them against', async () => {
    const client = new XtreamClient('http://example.com', 'user', 'pass')
    const getLive = vi.spyOn(client, 'getLiveStreams').mockResolvedValue([])
    const getVod = vi.spyOn(client, 'getVodStreams').mockResolvedValue([])
    const original = makeEntry({ kind: 'series', streamId: 5, name: 'Show — Episode 1' })
    useAppStore.setState({ client, recentlyWatched: [original] })

    await useAppStore.getState().refreshRecentlyWatched()

    expect(useAppStore.getState().recentlyWatched).toEqual([original])
    expect(getLive).not.toHaveBeenCalled()
    expect(getVod).not.toHaveBeenCalled()
  })

  it('skips the VOD fetch entirely for an m3u profile, leaving movie entries untouched', async () => {
    const client = new XtreamClient('http://example.com', 'user', 'pass')
    const getVod = vi.spyOn(client, 'getVodStreams').mockResolvedValue([])
    const original = makeEntry({ kind: 'movie', streamId: 2, name: 'Movie From A Different Profile' })
    useAppStore.setState({
      client,
      activeProfile: { id: 'p1', name: 'M3U Profile', kind: 'm3u' } as XtreamProfile,
      recentlyWatched: [original]
    })

    await useAppStore.getState().refreshRecentlyWatched()

    expect(getVod).not.toHaveBeenCalled()
    expect(useAppStore.getState().recentlyWatched).toEqual([original])
  })

  it('is a no-op with no client, and does not throw', async () => {
    useAppStore.setState({ client: null, recentlyWatched: [makeEntry({})] })

    await expect(useAppStore.getState().refreshRecentlyWatched()).resolves.toBeUndefined()
  })

  it('sets refreshingRecentlyWatched while the fetch is in flight and clears it after', async () => {
    const client = new XtreamClient('http://example.com', 'user', 'pass')
    let resolveFetch!: (streams: LiveStream[]) => void
    vi.spyOn(client, 'getLiveStreams').mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve
      })
    )
    useAppStore.setState({ client, recentlyWatched: [makeEntry({})] })

    const pending = useAppStore.getState().refreshRecentlyWatched()
    expect(useAppStore.getState().refreshingRecentlyWatched).toBe(true)

    resolveFetch([])
    await pending

    expect(useAppStore.getState().refreshingRecentlyWatched).toBe(false)
  })
})

describe('exportBackup / importBackup', () => {
  let reload: ReturnType<typeof vi.fn>

  beforeEach(() => {
    reload = vi.fn()
    ;(
      globalThis as unknown as {
        window: { api: { backup: Record<string, unknown> }; location: { reload: ReturnType<typeof vi.fn> } }
      }
    ).window = {
      api: {
        backup: {
          export: vi.fn().mockResolvedValue('/Users/test/allisoniptv-backup-2026-01-01.json'),
          import: vi.fn().mockResolvedValue({ imported: true })
        }
      },
      location: { reload }
    }
  })

  it('exportBackup returns ok:true with the chosen path', async () => {
    const result = await useAppStore.getState().exportBackup()

    expect(result).toEqual({ ok: true, path: '/Users/test/allisoniptv-backup-2026-01-01.json' })
  })

  it('exportBackup returns ok:true with no path when the user cancels the save dialog (not a failure)', async () => {
    ;(window.api.backup.export as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    const result = await useAppStore.getState().exportBackup()

    expect(result).toEqual({ ok: true, path: undefined })
  })

  it('exportBackup returns ok:false with the error message on failure', async () => {
    ;(window.api.backup.export as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'))

    const result = await useAppStore.getState().exportBackup()

    expect(result).toEqual({ ok: false, error: 'disk full' })
  })

  it('importBackup reloads the app after a successful import', async () => {
    const result = await useAppStore.getState().importBackup()

    expect(result).toEqual({ ok: true, imported: true })
    expect(reload).toHaveBeenCalled()
  })

  it('importBackup does not reload when the user cancels the open dialog', async () => {
    ;(window.api.backup.import as ReturnType<typeof vi.fn>).mockResolvedValue({ imported: false })

    const result = await useAppStore.getState().importBackup()

    expect(result).toEqual({ ok: true, imported: false })
    expect(reload).not.toHaveBeenCalled()
  })

  it('importBackup returns ok:false with the error message and does not reload on failure', async () => {
    ;(window.api.backup.import as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("not a valid backup file"))

    const result = await useAppStore.getState().importBackup()

    expect(result).toEqual({ ok: false, imported: false, error: 'not a valid backup file' })
    expect(reload).not.toHaveBeenCalled()
  })
})
