import { create } from 'zustand'
import { XtreamClient } from '../lib/xtream'
import { parseXmltv, type EpgData } from '../lib/epg'
import { loadProfiles, saveProfiles, loadActiveProfileId, saveActiveProfileId } from '../lib/storage'
import type {
  XtreamProfile,
  Category,
  LiveStream,
  VodStream,
  SeriesItem,
  SeriesInfo,
  MediaKind,
  ShortEpgProgram
} from '../lib/types'

export type ViewMode = 'live' | 'movies' | 'series'
export type ConnectionStatus = 'idle' | 'connecting' | 'ready' | 'error'

export interface NowPlaying {
  kind: MediaKind
  streamId: number
  name: string
  url: string
}

interface AppState {
  profiles: XtreamProfile[]
  activeProfile: XtreamProfile | null
  client: XtreamClient | null
  status: ConnectionStatus
  error: string | null

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

  openSeries: SeriesItem | null
  seriesInfo: SeriesInfo | null
  seriesInfoLoading: boolean

  previewChannel: LiveStream | null

  init: () => Promise<void>
  addProfile: (profile: Omit<XtreamProfile, 'id'>) => Promise<void>
  removeProfile: (id: string) => Promise<void>
  connect: (profileId: string) => Promise<void>
  disconnect: () => void
  setViewMode: (mode: ViewMode) => Promise<void>
  selectCategory: (categoryId: string | null) => Promise<void>
  setSearchTerm: (term: string) => void
  loadEpg: () => Promise<void>
  loadShortEpg: (streamId: number) => Promise<void>
  play: (kind: MediaKind, streamId: number, name: string, extension: string) => void
  stop: () => void

  openSeriesDetail: (item: SeriesItem) => Promise<void>
  closeSeriesDetail: () => void

  openChannelPreview: (channel: LiveStream) => void
  closeChannelPreview: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  profiles: [],
  activeProfile: null,
  client: null,
  status: 'idle',
  error: null,

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

  openSeries: null,
  seriesInfo: null,
  seriesInfoLoading: false,

  previewChannel: null,

  init: async () => {
    const profiles = await loadProfiles()
    const activeId = await loadActiveProfileId()
    set({ profiles })
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
      nowPlaying: null
    })
  },

  setViewMode: async (mode) => {
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
      await get().selectCategory(null)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load categories' })
    }
  },

  selectCategory: async (categoryId) => {
    const { client, viewMode } = get()
    if (!client) return
    set({ selectedCategoryId: categoryId })
    try {
      if (viewMode === 'live') {
        set({ liveStreams: await client.getLiveStreams(categoryId ?? undefined) })
      } else if (viewMode === 'movies') {
        set({ vodStreams: await client.getVodStreams(categoryId ?? undefined) })
      } else {
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

  loadShortEpg: async (streamId) => {
    const { client, shortEpgByStream } = get()
    if (!client || shortEpgByStream[streamId]) return
    try {
      const listings = await client.getShortEpg(streamId, 8)
      set({ shortEpgByStream: { ...get().shortEpgByStream, [streamId]: listings } })
    } catch {
      // EPG is best-effort; a missing short guide shouldn't block playback.
    }
  },

  play: (kind, streamId, name, extension) => {
    const { client } = get()
    if (!client) return
    set({ nowPlaying: { kind, streamId, name, url: client.getStreamUrl(kind, streamId, extension) } })
  },

  stop: () => set({ nowPlaying: null }),

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

  closeChannelPreview: () => set({ previewChannel: null })
}))
