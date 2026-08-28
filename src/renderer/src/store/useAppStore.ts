import { create } from 'zustand'
import { XtreamClient } from '../lib/xtream'
import { parseXmltv, type EpgData } from '../lib/epg'
import {
  loadProfiles,
  saveProfiles,
  loadActiveProfileId,
  saveActiveProfileId,
  loadFavorites,
  saveFavorites,
  loadRecentlyWatched,
  saveRecentlyWatched,
  loadEpisodeProgress,
  saveEpisodeProgress,
  loadSettings,
  saveSettings
} from '../lib/storage'
import type {
  XtreamProfile,
  Category,
  LiveStream,
  VodStream,
  SeriesItem,
  SeriesInfo,
  MediaKind,
  ShortEpgProgram,
  FavoriteEntry,
  RecentlyWatchedEntry,
  EpisodeProgress,
  AppSettings
} from '../lib/types'
import { DEFAULT_SETTINGS, favoriteKey } from '../lib/types'

export type ViewMode = 'live' | 'movies' | 'series' | 'favorites'
export type ConnectionStatus = 'idle' | 'connecting' | 'ready' | 'error'

// Both the main EPG grid and the fullscreen channel-swap bar lazy-load per-row short EPG as
// rows scroll into view — fine at normal browsing speed, but flinging a scrollbar through a
// large category can otherwise fire a burst of simultaneous get_short_epg requests. Module-
// level (not store state) since it's plumbing, not something any component needs to render.
const MAX_CONCURRENT_SHORT_EPG_FETCHES = 4
let activeShortEpgFetches = 0
const shortEpgQueue: Array<() => void> = []
const shortEpgInFlight = new Set<number>()

function runNextShortEpgFetch(): void {
  if (activeShortEpgFetches >= MAX_CONCURRENT_SHORT_EPG_FETCHES) return
  const next = shortEpgQueue.shift()
  if (!next) return
  activeShortEpgFetches++
  next()
}

export interface NowPlaying {
  kind: MediaKind
  streamId: number
  name: string
  url: string
  extension: string
}

interface AppState {
  profiles: XtreamProfile[]
  activeProfile: XtreamProfile | null
  client: XtreamClient | null
  status: ConnectionStatus
  error: string | null
  isOnline: boolean

  viewMode: ViewMode
  categories: Category[]
  selectedCategoryId: string | null
  liveStreams: LiveStream[]
  vodStreams: VodStream[]
  series: SeriesItem[]
  searchTerm: string

  epg: EpgData | null
  epgLoading: boolean
  shortEpgByStream: Record<number, ShortEpgProgram[]>

  nowPlaying: NowPlaying | null
  // Lives in the store (not Player.tsx's own local state) so App.tsx's single centralized
  // Escape handler can include it in the same priority chain as every other overlay —
  // otherwise Player.tsx would need its own separate Escape listener again, which is exactly
  // the uncoordinated-multiple-listeners pattern that caused a real race condition before.
  channelBarOpen: boolean

  openSeries: SeriesItem | null
  seriesInfo: SeriesInfo | null
  seriesInfoLoading: boolean

  previewChannel: LiveStream | null

  favorites: FavoriteEntry[]
  recentlyWatched: RecentlyWatchedEntry[]
  episodeProgress: Record<string, EpisodeProgress>
  settings: AppSettings
  unlockedCategoryIds: string[]
  pinPromptCategoryId: string | null
  pinPromptError: string | null
  settingsOpen: boolean

  init: () => Promise<void>
  addProfile: (profile: Omit<XtreamProfile, 'id'>) => Promise<void>
  removeProfile: (id: string) => Promise<void>
  connect: (profileId: string) => Promise<void>
  disconnect: () => void
  setViewMode: (mode: ViewMode) => Promise<void>
  requestCategory: (categoryId: string | null) => void
  selectCategory: (categoryId: string | null) => Promise<void>
  setSearchTerm: (term: string) => void
  loadEpg: () => Promise<void>
  loadShortEpg: (streamId: number) => Promise<void>
  play: (kind: MediaKind, streamId: number, name: string, extension: string, icon?: string) => void
  playTimeshift: (channel: LiveStream, program: ShortEpgProgram) => void
  stop: () => void
  setChannelBarOpen: (open: boolean) => void

  openSeriesDetail: (item: SeriesItem) => Promise<void>
  closeSeriesDetail: () => void

  openChannelPreview: (channel: LiveStream) => void
  closeChannelPreview: () => void

  toggleFavorite: (entry: FavoriteEntry) => void
  isFavorited: (kind: MediaKind, id: number) => boolean

  updateEpisodeProgress: (key: string, positionSeconds: number, durationSeconds: number) => void

  updateSettings: (patch: Partial<AppSettings>) => void
  setCategoryLocked: (categoryId: string, locked: boolean) => void
  submitPinAttempt: (pin: string) => void
  cancelPinPrompt: () => void
  openSettings: () => void
  closeSettings: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  profiles: [],
  activeProfile: null,
  client: null,
  status: 'idle',
  error: null,
  isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,

  viewMode: 'live',
  categories: [],
  selectedCategoryId: null,
  liveStreams: [],
  vodStreams: [],
  series: [],
  searchTerm: '',

  epg: null,
  epgLoading: false,
  shortEpgByStream: {},

  nowPlaying: null,
  channelBarOpen: false,

  openSeries: null,
  seriesInfo: null,
  seriesInfoLoading: false,

  previewChannel: null,

  favorites: [],
  recentlyWatched: [],
  episodeProgress: {},
  settings: DEFAULT_SETTINGS,
  unlockedCategoryIds: [],
  pinPromptCategoryId: null,
  pinPromptError: null,
  settingsOpen: false,

  init: async () => {
    const [profiles, favorites, recentlyWatched, episodeProgress, settings] = await Promise.all([
      loadProfiles(),
      loadFavorites(),
      loadRecentlyWatched(),
      loadEpisodeProgress(),
      loadSettings()
    ])
    const activeId = await loadActiveProfileId()
    set({ profiles, favorites, recentlyWatched, episodeProgress, settings })

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => set({ isOnline: true }))
      window.addEventListener('offline', () => set({ isOnline: false }))
    }

    const active = profiles.find((p) => p.id === activeId) ?? profiles[0]
    if (active) {
      await get().connect(active.id)
    }
  },

  addProfile: async (profile) => {
    // Retrying "Connect" after a failed attempt re-submits the same form — reuse the
    // matching saved profile instead of stacking up duplicates on every retry.
    const existing = get().profiles.find(
      (p) => p.server === profile.server && p.username === profile.username && p.password === profile.password
    )
    if (existing) {
      await get().connect(existing.id)
      return
    }
    const id = crypto.randomUUID()
    const newProfile: XtreamProfile = { ...profile, id }
    const profiles = [...get().profiles, newProfile]
    set({ profiles })
    await saveProfiles(profiles)
    await get().connect(id)
  },

  removeProfile: async (id) => {
    const profiles = get().profiles.filter((p) => p.id !== id)
    set({ profiles })
    await saveProfiles(profiles)
    if (get().activeProfile?.id === id) {
      get().disconnect()
    }
  },

  connect: async (profileId) => {
    const profile = get().profiles.find((p) => p.id === profileId)
    if (!profile) return
    set({ status: 'connecting', error: null, activeProfile: profile })
    try {
      if (!window.api?.proxy) {
        throw new Error('This app must run inside Electron to reach Xtream servers.')
      }
      // Route every request through the local CORS-proxy (see src/main/index.ts) instead
      // of the real server, since Xtream panels don't send CORS headers for browsers.
      await window.api.proxy.setTarget(profile.server)
      const proxyBase = await window.api.proxy.getBaseUrl()
      const client = new XtreamClient(proxyBase, profile.username, profile.password)
      await client.authenticate()
      set({ client, status: 'ready' })
      await saveActiveProfileId(profileId)
      await get().setViewMode('live')
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : 'Failed to connect' })
    }
  },

  disconnect: () => {
    set({
      client: null,
      activeProfile: null,
      status: 'idle',
      categories: [],
      liveStreams: [],
      vodStreams: [],
      series: [],
      epg: null,
      nowPlaying: null,
      channelBarOpen: false,
      unlockedCategoryIds: []
    })
  },

  setViewMode: async (mode) => {
    if (mode === 'favorites') {
      set({ viewMode: mode, selectedCategoryId: null, searchTerm: '' })
      return
    }
    const { client } = get()
    if (!client) return
    set({
      viewMode: mode,
      selectedCategoryId: null,
      liveStreams: [],
      vodStreams: [],
      series: [],
      searchTerm: ''
    })
    try {
      const categories =
        mode === 'live'
          ? await client.getLiveCategories()
          : mode === 'movies'
            ? await client.getVodCategories()
            : await client.getSeriesCategories()
      set({ categories })
      await get().requestCategory(null)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load categories' })
    }
  },

  // Wraps selectCategory with the parental-lock check: a locked category not yet
  // unlocked this session prompts for the PIN instead of loading its content.
  requestCategory: (categoryId) => {
    const { settings, unlockedCategoryIds, viewMode } = get()
    // Namespaced by section since Xtream doesn't guarantee category_id uniqueness across
    // Live/Movies/Series — see setCategoryLocked and loadSettings' migration.
    const lockKey = categoryId ? `${viewMode}:${categoryId}` : null
    if (lockKey && settings.parentalPin && settings.lockedCategoryIds.includes(lockKey) && !unlockedCategoryIds.includes(lockKey)) {
      set({ pinPromptCategoryId: categoryId, pinPromptError: null })
      return
    }
    get().selectCategory(categoryId)
  },

  selectCategory: async (categoryId) => {
    const { client, viewMode } = get()
    if (!client) return
    set({ selectedCategoryId: categoryId })
    try {
      if (viewMode === 'live') {
        const liveStreams = await client.getLiveStreams(categoryId ?? undefined)
        set({ liveStreams })
        // The EPG grid is now the primary way to browse live channels (there's no
        // separate clickable list next to it), so seed it with the first channel in
        // the category instead of leaving it blank until something is clicked.
        if (liveStreams.length > 0) get().openChannelPreview(liveStreams[0])
      } else if (viewMode === 'movies') {
        set({ vodStreams: await client.getVodStreams(categoryId ?? undefined) })
      } else if (viewMode === 'series') {
        set({ series: await client.getSeries(categoryId ?? undefined) })
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load content' })
    }
  },

  setSearchTerm: (term) => set({ searchTerm: term }),

  loadEpg: async () => {
    const { client, epg, epgLoading } = get()
    if (!client || epg || epgLoading) return
    set({ epgLoading: true })
    try {
      const xml = await client.getFullEpgXml()
      set({ epg: parseXmltv(xml), epgLoading: false })
    } catch {
      // Many Xtream resellers restrict or disable xmltv.php entirely (this is only an
      // enrichment for the inline "now playing" label) — per-channel previews rely on
      // get_short_epg instead, so a failure here shouldn't surface as a user-facing error.
      set({ epgLoading: false })
    }
  },

  loadShortEpg: (streamId) => {
    const { client, shortEpgByStream } = get()
    if (!client || shortEpgByStream[streamId] || shortEpgInFlight.has(streamId)) return Promise.resolve()
    shortEpgInFlight.add(streamId)
    return new Promise((resolve) => {
      shortEpgQueue.push(async () => {
        try {
          const listings = await client.getShortEpg(streamId, 16)
          set({ shortEpgByStream: { ...get().shortEpgByStream, [streamId]: listings } })
        } catch {
          // EPG is best-effort; a missing short guide shouldn't block playback.
        } finally {
          shortEpgInFlight.delete(streamId)
          activeShortEpgFetches--
          resolve()
          runNextShortEpgFetch()
        }
      })
      runNextShortEpgFetch()
    })
  },

  play: (kind, streamId, name, extension, icon = '') => {
    const { client, recentlyWatched } = get()
    if (!client) return
    set({ nowPlaying: { kind, streamId, name, extension, url: client.getStreamUrl(kind, streamId, extension) } })

    const entry: RecentlyWatchedEntry = { kind, streamId, name, icon, extension, watchedAt: Date.now() }
    const withoutDupe = recentlyWatched.filter((e) => !(e.kind === kind && e.streamId === streamId))
    const updated = [entry, ...withoutDupe].slice(0, 30)
    set({ recentlyWatched: updated })
    saveRecentlyWatched(updated)
  },

  playTimeshift: (channel, program) => {
    const { client } = get()
    if (!client) return
    const start = new Date(Number(program.start_timestamp) * 1000)
    const durationMinutes = (Number(program.stop_timestamp) - Number(program.start_timestamp)) / 60
    const url = client.getTimeshiftUrl(channel.stream_id, start, durationMinutes)
    set({
      nowPlaying: { kind: 'live', streamId: channel.stream_id, name: `${channel.name} — ${program.title}`, extension: 'm3u8', url }
    })
  },

  stop: () => set({ nowPlaying: null, channelBarOpen: false }),
  setChannelBarOpen: (open) => set({ channelBarOpen: open }),

  openSeriesDetail: async (item) => {
    const { client } = get()
    if (!client) return
    set({ openSeries: item, seriesInfo: null, seriesInfoLoading: true })
    try {
      const info = await client.getSeriesInfo(item.series_id)
      set({ seriesInfo: info, seriesInfoLoading: false })
    } catch (err) {
      set({ seriesInfoLoading: false, error: err instanceof Error ? err.message : 'Failed to load series' })
    }
  },

  closeSeriesDetail: () => set({ openSeries: null, seriesInfo: null }),

  openChannelPreview: (channel) => {
    set({ previewChannel: channel })
    get().loadShortEpg(channel.stream_id)
  },

  closeChannelPreview: () => set({ previewChannel: null }),

  toggleFavorite: (entry) => {
    const key = favoriteKey(entry)
    const { favorites } = get()
    const exists = favorites.some((f) => favoriteKey(f) === key)
    const updated = exists ? favorites.filter((f) => favoriteKey(f) !== key) : [entry, ...favorites]
    set({ favorites: updated })
    saveFavorites(updated)
  },

  isFavorited: (kind, id) => get().favorites.some((f) => favoriteKey(f) === `${kind}:${id}`),

  updateEpisodeProgress: (key, positionSeconds, durationSeconds) => {
    const updated = {
      ...get().episodeProgress,
      [key]: { positionSeconds, durationSeconds, updatedAt: Date.now() }
    }
    set({ episodeProgress: updated })
    saveEpisodeProgress(updated)
  },

  updateSettings: (patch) => {
    const updated = { ...get().settings, ...patch }
    set({ settings: updated })
    saveSettings(updated)
  },

  setCategoryLocked: (categoryId, locked) => {
    const current = get().settings
    const lockedCategoryIds = locked
      ? [...new Set([...current.lockedCategoryIds, categoryId])]
      : current.lockedCategoryIds.filter((id) => id !== categoryId)
    get().updateSettings({ lockedCategoryIds })
  },

  submitPinAttempt: (pin) => {
    const { pinPromptCategoryId, settings, unlockedCategoryIds, viewMode } = get()
    if (!pinPromptCategoryId) return
    if (pin === settings.parentalPin) {
      // Matches the namespaced key requestCategory checks against — pinPromptCategoryId
      // itself stays bare since selectCategory needs the real Xtream category_id.
      const lockKey = `${viewMode}:${pinPromptCategoryId}`
      set({
        unlockedCategoryIds: [...unlockedCategoryIds, lockKey],
        pinPromptCategoryId: null,
        pinPromptError: null
      })
      get().selectCategory(pinPromptCategoryId)
    } else {
      set({ pinPromptError: 'Incorrect PIN' })
    }
  },

  cancelPinPrompt: () => set({ pinPromptCategoryId: null, pinPromptError: null }),

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false })
}))
