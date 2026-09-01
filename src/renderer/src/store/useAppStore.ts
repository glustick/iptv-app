import { create } from 'zustand'
import { XtreamClient } from '../lib/xtream'
import { M3uClient } from '../lib/m3uClient'
import type { IptvClient } from '../lib/iptvClient'
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
  AppSettings,
  VpnStatus,
  VpnProfile
} from '../lib/types'
import { DEFAULT_SETTINGS, favoriteKey } from '../lib/types'
import { shouldWarnOnVpnDisconnect } from '../lib/vpnStatus'

export type ViewMode = 'live' | 'movies' | 'series' | 'favorites'
export type ConnectionStatus = 'idle' | 'connecting' | 'ready' | 'error'

// Both the main EPG grid and the fullscreen channel-swap bar lazy-load per-row short EPG as
// rows scroll into view — fine at normal browsing speed, but flinging a scrollbar through a
// large category can otherwise fire a burst of simultaneous get_short_epg requests. Module-
// level (not store state) since it's plumbing, not something any component needs to render.
const MAX_CONCURRENT_SHORT_EPG_FETCHES = 4
let activeShortEpgFetches = 0
// `| Promise<void>` reflects reality (every entry pushed below is actually async) rather than
// being a workaround — runNextShortEpgFetch() calling one is deliberately fire-and-forget, since
// each entry's own try/finally (see loadShortEpg) already handles its completion and chains the
// next queued fetch itself.
const shortEpgQueue: Array<() => void | Promise<void>> = []
const shortEpgInFlight = new Set<number>()

function runNextShortEpgFetch(): void {
  if (activeShortEpgFetches >= MAX_CONCURRENT_SHORT_EPG_FETCHES) return
  const next = shortEpgQueue.shift()
  if (!next) return
  activeShortEpgFetches++
  void next()
}

export interface NowPlaying {
  kind: MediaKind
  streamId: number
  name: string
  url: string
  extension: string
  // Only meaningful for kind === 'live'; carried through from whichever full LiveStream record
  // play() was called with, so the channel bar can offer real catch-up for a channel reached via
  // Favorites or Recently Watched, not just ones in the currently-browsed EPG grid category.
  tvArchive: number
  // Carried through the same way as tvArchive above — every live play() call site already has
  // the full LiveStream record's stream_icon on hand, so the player's edge-hover info panel
  // (Player.tsx) can show it without depending on the currently-browsed category's liveStreams
  // list, which may not even contain this channel (e.g. reached via Favorites or search).
  icon: string
}

interface AppState {
  profiles: XtreamProfile[]
  activeProfile: XtreamProfile | null
  client: IptvClient | null
  status: ConnectionStatus
  error: string | null
  isOnline: boolean
  // From authenticate()'s own user_info.max_connections (already fetched at login, no extra
  // request) — an account capped at a single connection puts Live TV's and VOD's audio-fix
  // transcode fallbacks (see useTranscodeFallback.ts) in the same failure class: ffmpeg opening
  // a second connection to remux audio has nothing to share the account's one slot with
  // whatever's already playing. Surfaced in Player.tsx so a slow or failed transcode says why,
  // instead of just a flat timeout/error message that looks identical to any other cause.
  singleConnectionAccount: boolean

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
  aboutOpen: boolean

  vpnStatus: VpnStatus
  vpnErrorMessage: string | null
  // Set only while a connected tunnel drops unexpectedly (never for a deliberate Deactivate or
  // profile switch, which tear down the old tunnel on purpose) — surfaced as a dismissible
  // warning wherever the user is, including inside a fullscreen player. null when there's
  // nothing to warn about.
  vpnDisconnectWarning: string | null
  // Distinguishes an intentional teardown (Deactivate, or activateVpnProfile switching away
  // from a different profile) from a genuine unexpected drop — both look identical from the
  // outside as a "connected" -> "disconnected" transition, so intent has to be tracked
  // explicitly rather than inferred from the status change alone.
  vpnDisconnectingIntentionally: boolean
  // Set whenever the main-process proxy sees a redirect land on a host other than the one the
  // active tunnel's route-up script actually routes (see vpn:stream-route-warning in
  // src/main/index.ts) — a real, live sign that some of this connection's traffic may be
  // bypassing the VPN. null when nothing like that has been seen yet.
  vpnStreamRouteWarning: string | null

  // A newer version found by the main process's autoUpdater (see update:available in
  // src/main/index.ts) — version alone until it's actually finished downloading, at which point
  // updateDownloaded flips true and this same field's version is what's offered to install.
  // null whenever there's nothing to prompt about.
  updateInfo: { version: string } | null
  // Non-null only while a user-initiated download (see downloadUpdate) is actually in flight —
  // there's no "downloading" state otherwise, since autoDownload is off (see main/index.ts).
  updateDownloadPercent: number | null
  updateDownloaded: boolean
  // Only ever set from a failure during a download the user explicitly asked for — see the
  // onError wiring in init() for why a background/launch-time check failure never reaches this.
  updateError: string | null
  // "Later" on the available-prompt sets this for the rest of the running session; a fresh
  // update:available event (the next launch, or a manual re-check) resets it, so dismissing
  // once doesn't silence the prompt forever.
  updateDismissed: boolean

  init: () => Promise<void>
  addProfile: (profile: Omit<XtreamProfile, 'id'>) => Promise<void>
  removeProfile: (id: string) => Promise<void>
  connect: (profileId: string) => Promise<void>
  retryConnection: () => Promise<void>
  disconnect: () => void
  setViewMode: (mode: ViewMode) => Promise<void>
  requestCategory: (categoryId: string | null) => void
  selectCategory: (categoryId: string | null) => Promise<void>
  setSearchTerm: (term: string) => void
  loadEpg: () => Promise<void>
  loadShortEpg: (streamId: number) => Promise<void>
  play: (
    kind: MediaKind,
    streamId: number,
    name: string,
    extension: string,
    icon?: string,
    tvArchive?: number
  ) => void
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
  openAbout: () => void
  closeAbout: () => void

  addVpnProfile: (profile: Omit<VpnProfile, 'id'>) => Promise<void>
  updateVpnProfile: (id: string, patch: Partial<Omit<VpnProfile, 'id'>>) => Promise<void>
  removeVpnProfile: (id: string) => Promise<void>
  activateVpnProfile: (id: string) => Promise<void>
  deactivateVpnProfile: () => Promise<void>
  toggleVpnTunnel: () => Promise<void>
  dismissVpnDisconnectWarning: () => void
  dismissVpnStreamRouteWarning: () => void

  checkForUpdates: () => Promise<void>
  downloadUpdate: () => Promise<void>
  installUpdate: () => void
  dismissUpdatePrompt: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  profiles: [],
  activeProfile: null,
  client: null,
  status: 'idle',
  error: null,
  isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
  singleConnectionAccount: false,

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
  aboutOpen: false,

  vpnStatus: 'disconnected',
  vpnErrorMessage: null,
  vpnDisconnectWarning: null,
  vpnDisconnectingIntentionally: false,
  vpnStreamRouteWarning: null,

  updateInfo: null,
  updateDownloadPercent: null,
  updateDownloaded: false,
  updateError: null,
  updateDismissed: false,

  // Wrapped in its own try/catch (unlike most of this store's other async actions, which rely
  // on the caller to handle rejection) because App.tsx calls this fire-and-forget from a mount
  // effect — a useEffect callback can't itself be async, so there's no caller-side await to
  // reject into. Without this, a storage read failing here (before connect()'s own try/catch
  // is ever reached) would leave the app silently stuck on whatever the initial screen is,
  // with nothing but a console error to say why.
  init: async () => {
    try {
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

      // Pushed from main (see src/main/index.ts's vpn:status-changed) rather than polled, since
      // OpenVPN's own management-interface connection is what actually knows the tunnel's state
      // in real time — polling would mean either missing transitions between polls or hammering
      // an IPC round-trip just to notice a state that already changed.
      window.api?.vpn?.onStatusChange((payload) => {
        const newStatus = payload.status as VpnStatus
        const { vpnStatus: prevStatus, vpnDisconnectingIntentionally } = get()
        const droppedUnexpectedly = shouldWarnOnVpnDisconnect(prevStatus, newStatus, vpnDisconnectingIntentionally)
        set({
          vpnStatus: newStatus,
          vpnErrorMessage: payload.errorMessage,
          ...(droppedUnexpectedly && {
            vpnDisconnectWarning:
              "The VPN has disconnected — this app's connection is no longer tunneled. Reactivate it from Settings if you need it back."
          })
        })
      })

      // See vpn:stream-route-warning in src/main/index.ts — pushed the same way as vpn:status-
      // changed, since the main process is what actually sees each proxied request's redirect
      // chain and can tell whether a hop landed outside the tunneled host.
      window.api?.vpn?.onStreamRouteWarning((payload) => {
        set({ vpnStreamRouteWarning: payload.message })
      })

      // updateAvailable resets updateDismissed too — a version found on a later check (the next
      // launch, or a manual "Check for Updates") should prompt again even if the user dismissed
      // an earlier one, rather than staying silenced forever from one "Later" click.
      window.api?.updater?.onAvailable((payload) => {
        set({ updateInfo: payload, updateDismissed: false, updateError: null })
      })
      window.api?.updater?.onProgress((payload) => {
        set({ updateDownloadPercent: payload.percent })
      })
      // Also resets updateDismissed, same reasoning as onAvailable above — "restart to install"
      // is a more consequential prompt than the "want to download this at all" one a user might
      // have dismissed earlier, so it resurfaces regardless of that earlier dismissal. From here
      // on, dismissing THIS prompt (see UpdatePrompt.tsx's plain "Later" button) behaves like a
      // real toggle again — there's no further step this needs to defer to.
      window.api?.updater?.onDownloaded((payload) => {
        set({ updateInfo: payload, updateDownloaded: true, updateDownloadPercent: null, updateDismissed: false })
      })
      // Only ever shown if it happens while the user is actively waiting on a download they
      // asked for (see downloadUpdate) — a background/launch-time check failing is common and
      // benign (offline, an unsigned build with nothing to actually apply an update — see
      // ROADMAP.md) and stays silent (console-logged in the main process) rather than alarming
      // someone with an error for a check they never asked for.
      window.api?.updater?.onError((payload) => {
        set({ updateError: payload.message, updateDownloadPercent: null })
      })

      const active = profiles.find((p) => p.id === activeId) ?? profiles[0]
      if (active) {
        await get().connect(active.id)
      }
    } catch (err) {
      console.error('[init] failed to load local app state:', err)
      set({ status: 'error', error: err instanceof Error ? err.message : 'Failed to start the app' })
    }
  },

  addProfile: async (profile) => {
    // Retrying "Connect" after a failed attempt re-submits the same form — reuse the
    // matching saved profile instead of stacking up duplicates on every retry.
    const existing = get().profiles.find((p) =>
      profile.kind === 'm3u'
        ? p.kind === 'm3u' && p.m3uUrl === profile.m3uUrl && p.epgUrl === profile.epgUrl
        : p.kind !== 'm3u' && p.server === profile.server && p.username === profile.username && p.password === profile.password
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
      const proxyBase = await window.api.proxy.getBaseUrl()
      let client: IptvClient
      if (profile.kind === 'm3u') {
        // M3uClient routes every request (playlist, EPG, and every channel's own stream URL)
        // through the proxy's /__fetch/ passthrough itself — unlike Xtream, a playlist can
        // reference a different host per channel, so there's no single base for setTarget's
        // path-relative proxying to resolve against.
        client = new M3uClient(proxyBase, profile.m3uUrl ?? '', profile.epgUrl ?? null)
      } else {
        // Route every request through the local CORS-proxy (see src/main/index.ts) instead
        // of the real server, since Xtream panels don't send CORS headers for browsers.
        await window.api.proxy.setTarget(profile.server ?? '')
        client = new XtreamClient(proxyBase, profile.username ?? '', profile.password ?? '')
      }
      const auth = await client.authenticate()
      set({ client, status: 'ready', singleConnectionAccount: auth.user_info.max_connections === '1' })
      await saveActiveProfileId(profileId)
      await get().setViewMode('live')
      // Deliberately does NOT auto-reconnect the VPN here, even if a profile was left active
      // last session — connecting spawns an OS elevation prompt, and that must only ever happen
      // from an explicit Activate click, never as a side effect of the app simply launching (or
      // of switching Xtream profiles). A profile marked active in settings is a saved *choice*
      // for next time the user clicks Activate, not a standing instruction to auto-elevate.
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : 'Failed to connect' })
    }
  },

  // Re-runs the exact same connect flow (re-authenticates, rebuilds the proxy target, reloads
  // Live TV) against whichever profile was last active — the one thing a broken connection
  // (e.g. a proxy 502) previously required quitting and relaunching the whole app to recover
  // from, since nothing in the UI re-triggered this on demand.
  retryConnection: async () => {
    const { activeProfile } = get()
    if (activeProfile) await get().connect(activeProfile.id)
  },

  disconnect: () => {
    set({
      client: null,
      activeProfile: null,
      status: 'idle',
      singleConnectionAccount: false,
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
    // selectCategory catches its own errors internally (sets `error` in the store).
    void get().selectCategory(categoryId)
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
          // 48 isn't a real cap on this provider — a spot check with limit=200 still only
          // returned ~26 items (its own natural "rest of today" window), so asking for more
          // than that just lets whatever the provider actually has through instead of an
          // artificial 16-item truncation that was cutting off real, already-available
          // programming well before the provider's own window ran out.
          const listings = await client.getShortEpg(streamId, 48)
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

  play: (kind, streamId, name, extension, icon = '', tvArchive = 0) => {
    const { client, recentlyWatched } = get()
    if (!client) return
    set({
      nowPlaying: {
        kind,
        streamId,
        name,
        extension,
        tvArchive,
        icon,
        url: client.getStreamUrl(kind, streamId, extension)
      }
    })

    const entry: RecentlyWatchedEntry = { kind, streamId, name, icon, extension, tvArchive, watchedAt: Date.now() }
    const withoutDupe = recentlyWatched.filter((e) => !(e.kind === kind && e.streamId === streamId))
    const updated = [entry, ...withoutDupe].slice(0, 30)
    set({ recentlyWatched: updated })
    saveRecentlyWatched(updated).catch((err) => console.error('[store] failed to save recently-watched:', err))
  },

  playTimeshift: (channel, program) => {
    const { client } = get()
    if (!client) return
    const start = new Date(Number(program.start_timestamp) * 1000)
    const durationMinutes = (Number(program.stop_timestamp) - Number(program.start_timestamp)) / 60
    const url = client.getTimeshiftUrl(channel.stream_id, start, durationMinutes)
    set({
      nowPlaying: {
        kind: 'live',
        streamId: channel.stream_id,
        name: `${channel.name} — ${program.title}`,
        extension: 'm3u8',
        tvArchive: channel.tv_archive,
        icon: channel.stream_icon,
        url
      }
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
    // loadShortEpg catches its own errors internally (EPG is best-effort) and always resolves.
    void get().loadShortEpg(channel.stream_id)
  },

  closeChannelPreview: () => set({ previewChannel: null }),

  toggleFavorite: (entry) => {
    const key = favoriteKey(entry)
    const { favorites } = get()
    const exists = favorites.some((f) => favoriteKey(f) === key)
    const updated = exists ? favorites.filter((f) => favoriteKey(f) !== key) : [entry, ...favorites]
    set({ favorites: updated })
    saveFavorites(updated).catch((err) => console.error('[store] failed to save favorites:', err))
  },

  isFavorited: (kind, id) => get().favorites.some((f) => favoriteKey(f) === `${kind}:${id}`),

  updateEpisodeProgress: (key, positionSeconds, durationSeconds) => {
    const updated = {
      ...get().episodeProgress,
      [key]: { positionSeconds, durationSeconds, updatedAt: Date.now() }
    }
    set({ episodeProgress: updated })
    saveEpisodeProgress(updated).catch((err) => console.error('[store] failed to save episode progress:', err))
  },

  updateSettings: (patch) => {
    const updated = { ...get().settings, ...patch }
    set({ settings: updated })
    saveSettings(updated).catch((err) => console.error('[store] failed to save settings:', err))
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
      // selectCategory catches its own errors internally (sets `error` in the store).
      void get().selectCategory(pinPromptCategoryId)
    } else {
      set({ pinPromptError: 'Incorrect PIN' })
    }
  },

  cancelPinPrompt: () => set({ pinPromptCategoryId: null, pinPromptError: null }),

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  openAbout: () => set({ aboutOpen: true }),
  closeAbout: () => set({ aboutOpen: false }),

  addVpnProfile: async (profile) => {
    const newProfile: VpnProfile = { ...profile, id: crypto.randomUUID() }
    get().updateSettings({ vpnProfiles: [...get().settings.vpnProfiles, newProfile] })
  },

  updateVpnProfile: async (id, patch) => {
    const vpnProfiles = get().settings.vpnProfiles.map((p) => (p.id === id ? { ...p, ...patch } : p))
    get().updateSettings({ vpnProfiles })
  },

  removeVpnProfile: async (id) => {
    if (get().settings.activeVpnProfileId === id) {
      await get().deactivateVpnProfile()
    }
    const profile = get().settings.vpnProfiles.find((p) => p.id === id)
    get().updateSettings({
      vpnProfiles: get().settings.vpnProfiles.filter((p) => p.id !== id),
      // Otherwise the VPN dot's "reconnect to the last configuration" click would keep pointing
      // at a profile that no longer exists.
      lastVpnProfileId: get().settings.lastVpnProfileId === id ? null : get().settings.lastVpnProfileId
    })
    // No-ops for a profile added before configs were imported on add (configPath still points
    // at wherever the user originally picked it, which this deliberately never touches).
    if (profile) void window.api.vpn.removeImportedConfig(profile.configPath)
  },

  // Only one tunnel can ever actually be connected — this app only ever spawns a single openvpn
  // process (see src/main/index.ts) — so activating a different profile than whatever's
  // currently up means tearing that one down first, not layering a second on top of it.
  activateVpnProfile: async (id) => {
    const profile = get().settings.vpnProfiles.find((p) => p.id === id)
    if (!profile) return
    const currentActiveId = get().settings.activeVpnProfileId
    if (currentActiveId && currentActiveId !== id) {
      set({ vpnDisconnectingIntentionally: true })
      await window.api.vpn.disconnect()
      set({ vpnDisconnectingIntentionally: false })
    }
    // lastVpnProfileId is set here too (not just activeVpnProfileId), and — unlike
    // activeVpnProfileId — deactivateVpnProfile below never clears it, since it exists
    // specifically to survive deactivation for the VPN dot's toggle-back-on click.
    get().updateSettings({ activeVpnProfileId: id, lastVpnProfileId: id })
    try {
      await window.api.vpn.connect(profile.configPath, profile.username, profile.password)
    } catch (err) {
      set({ vpnStatus: 'error', vpnErrorMessage: err instanceof Error ? err.message : 'Failed to connect' })
    }
  },

  deactivateVpnProfile: async () => {
    set({ vpnDisconnectingIntentionally: true })
    await window.api.vpn.disconnect()
    set({ vpnDisconnectingIntentionally: false })
    get().updateSettings({ activeVpnProfileId: null })
  },

  // Backs the VPN status dot's click-to-toggle (TopBar.tsx, Player.tsx): connected or actively
  // connecting reads as "on" and disconnects; anything else (disconnected, error, or genuinely
  // no VPN configured yet) reads as "off" and (re)connects to whichever profile was last active,
  // falling back to the first saved profile if none ever has been.
  toggleVpnTunnel: async () => {
    const { vpnStatus, settings } = get()
    if (vpnStatus === 'connected' || vpnStatus === 'connecting') {
      await get().deactivateVpnProfile()
      return
    }
    const targetId = settings.lastVpnProfileId ?? settings.activeVpnProfileId ?? settings.vpnProfiles[0]?.id
    if (!targetId) return
    await get().activateVpnProfile(targetId)
  },

  dismissVpnDisconnectWarning: () => set({ vpnDisconnectWarning: null }),
  dismissVpnStreamRouteWarning: () => set({ vpnStreamRouteWarning: null }),

  // Manual re-check (an "Check for Updates" button, not just the launch-time one in
  // src/main/index.ts) — update:available/update:not-available both resolve this promise, but
  // only the former actually pushes a payload back through the onAvailable listener above.
  checkForUpdates: async () => {
    set({ updateError: null })
    await window.api.updater.check()
  },

  downloadUpdate: async () => {
    set({ updateDownloadPercent: 0, updateError: null })
    try {
      await window.api.updater.download()
    } catch (err) {
      set({ updateError: err instanceof Error ? err.message : 'Failed to download update', updateDownloadPercent: null })
    }
  },

  // quitAndInstall() (invoked by the main process on the other end of this) tears the whole app
  // down itself — nothing to await or update state for afterward.
  installUpdate: () => {
    void window.api.updater.install()
  },

  dismissUpdatePrompt: () => set({ updateDismissed: true })
}))
