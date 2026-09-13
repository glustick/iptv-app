import { create } from 'zustand'
import { XtreamClient } from '../lib/xtream'
import { M3uClient } from '../lib/m3uClient'
import type { IptvClient } from '../lib/iptvClient'
import {
  parseXmltv,
  matchXmltvChannels,
  mergeShortEpg,
  xmltvProgrammesToShort,
  decodeMaybeGzipBytes,
  type EpgData
} from '../lib/epg'
import {
  loadProfiles,
  saveProfiles,
  loadActiveProfileId,
  saveActiveProfileId,
  loadFavorites,
  saveFavorites,
  loadFavoriteGroups,
  saveFavoriteGroups,
  loadRecentlyWatched,
  saveRecentlyWatched,
  loadEpisodeProgress,
  saveEpisodeProgress,
  loadEpgReminders,
  saveEpgReminders,
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
  FavoriteGroup,
  RecentlyWatchedEntry,
  EpisodeProgress,
  AppSettings,
  EpgChannelMapping,
  VpnStatus,
  VpnProfile,
  MultiViewLayout
} from '../lib/types'
import { DEFAULT_SETTINGS, favoriteKey } from '../lib/types'
import { shouldWarnOnVpnDisconnect } from '../lib/vpnStatus'
import { createReminder, reminderId, splitDueReminders, type EpgReminder } from '../lib/reminders'

export type ViewMode = 'live' | 'movies' | 'series' | 'favorites' | 'history' | 'multiview'
export type ConnectionStatus = 'idle' | 'connecting' | 'ready' | 'error'

// Both the main EPG grid and the fullscreen channel-swap bar lazy-load per-row short EPG as
// rows scroll into view — fine at normal browsing speed, but flinging a scrollbar through a
// large category can otherwise fire a burst of simultaneous get_short_epg requests. Module-
// level (not store state) since it's plumbing, not something any component needs to render.
// Sized for a small horizontal strip originally (0.5.0); now that History (0.7.32) is a
// full-page tab in its own right, a low cap would feel sparse for anyone watching a lot in a
// day — raised well past that.
const RECENTLY_WATCHED_LIMIT = 100
const MAX_CONCURRENT_SHORT_EPG_FETCHES = 4
// A cached short-EPG entry is considered fresh for this long even if it still spans "now" —
// providers update their guides (late additions, schedule changes) continuously, and this is
// also what picks up the next day's listings once the provider publishes them. Entries that no
// longer span "now" (data exhausted, or the app crossed midnight on a "rest of today" provider
// window) are refetchable regardless of this TTL — that's the case that used to blank out every
// channel for the rest of a long-running session.
const SHORT_EPG_TTL_MS = 15 * 60 * 1000
// A channel whose get_short_epg just failed waits this long before another attempt, so a
// dead/erroring channel can't be hammered by rows remounting on every scroll — but unlike the
// old behavior (failure = shimmer forever, or worse, empty cached forever), it does get
// retried.
const SHORT_EPG_FAILURE_COOLDOWN_MS = 60 * 1000
let activeShortEpgFetches = 0
// `| Promise<void>` reflects reality (every entry pushed below is actually async) rather than
// being a workaround — runNextShortEpgFetch() calling one is deliberately fire-and-forget, since
// each entry's own try/finally (see loadShortEpg) already handles its completion and chains the
// next queued fetch itself.
const shortEpgQueue: Array<() => void | Promise<void>> = []
const shortEpgInFlight = new Set<number>()
const shortEpgFailedAt = new Map<number, number>()

function runNextShortEpgFetch(): void {
  if (activeShortEpgFetches >= MAX_CONCURRENT_SHORT_EPG_FETCHES) return
  const next = shortEpgQueue.shift()
  if (!next) return
  activeShortEpgFetches++
  void next()
}

/** One row of the per-source EPG match report shown in Settings — see applyEpgPool. */
export interface EpgSourceMatchStats {
  source: string
  available: boolean
  loadedChannels: number
  matched: number
  byId: number
  byName: number
  byManual: number
  unmatchedNames: string[]
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
  // The FULL live catalog (not just the currently-browsed category liveStreams above holds),
  // fetched once and cached — findChannelByNumber needs to search by a channel's provider-
  // assigned `num` regardless of which category it's actually in, and liveStreams alone can't
  // answer that. null until the first lookup; reset on connect()/disconnect() so a profile
  // switch can't resolve a typed number against a stale, different provider's lineup.
  numericChannelCatalog: LiveStream[] | null

  // Every parsed full-XMLTV guide available this session, in priority order: the provider's own
  // xmltv.php guide first (when the provider allows it), then each user-added third-party source
  // (settings.customEpgUrls) in order. Used to fill gaps the per-channel get_short_epg window
  // can't — see loadEpgSources/applyEpgPool. Empty when no guide is available or fetchable.
  epgSources: EpgData[]
  // Label for each entry in epgSources, index-aligned: the provider guide's display name or
  // the custom URL it was fetched from — what applyEpgPool's match report calls each source.
  epgSourceLabels: string[]
  // true/false once an Xtream connect has tried the provider's own xmltv.php guide; null on
  // M3U profiles (their playlist guide never enters the pool as a separate source).
  providerGuideAvailable: boolean | null
  epgSourcesStatus: 'idle' | 'loading' | 'ready'
  // Per-source matching report for Settings — what each guide matched against the
  // currently-loaded channels, by which join method, and which names found no counterpart.
  epgSourceMatchStats: EpgSourceMatchStats[]
  // Why a user-added EPG source contributed nothing, keyed by its URL ("" = it didn't) — wrong
  // format, HTTP error, etc. Provider-guide failures are deliberately not tracked here; see
  // loadEpgSources' own comment for why.
  epgSourceIssues: Record<string, string>
  shortEpgByStream: Record<number, ShortEpgProgram[]>
  // When each stream's shortEpgByStream entry was last refreshed from the provider (not set for
  // entries prefilled from a guide pool — those want the provider's fresher data as soon as
  // their row loads). Drives SHORT_EPG_TTL_MS staleness in loadShortEpg.
  shortEpgFetchedAt: Record<number, number>
  // The local proxy's base URL, captured at connect() — fetching a user-added third-party EPG
  // URL needs the proxy's /__fetch/ passthrough (same reason every other cross-origin request
  // here goes through it), and nothing else exposes it to the store.
  proxyBase: string | null

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

  // Live TV only — one hls.js instance per filled slot, each a genuinely separate connection to
  // the provider (see the gating note on singleConnectionAccount below, and MultiView.tsx's own
  // comment for why this can only ever be verified end-to-end against synthetic local streams on
  // this account). Sized to settings.multiViewLayout; index i is that grid position's channel,
  // or null if empty. Deliberately kept here rather than as MultiView.tsx's own local state so
  // switching away and back to the tab (which unmounts/remounts the tiles, tearing down and
  // re-establishing each connection) restores the same assignments rather than starting empty.
  multiViewSlots: (LiveStream | null)[]
  // Which slot (if any) the channel picker overlay is currently choosing a channel for; null
  // when the picker isn't open.
  multiViewPickingSlot: number | null
  showHiddenLiveChannels: boolean

  favorites: FavoriteEntry[]
  favoriteGroups: FavoriteGroup[]
  recentlyWatched: RecentlyWatchedEntry[]
  // True only while refreshRecentlyWatched's catalog fetch is in flight — lets the History
  // tab's Refresh button show a busy state and avoid firing a second overlapping refresh.
  refreshingRecentlyWatched: boolean
  episodeProgress: Record<string, EpisodeProgress>
  epgReminders: EpgReminder[]
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
  // Fetches (once) and searches the full live catalog by a channel's provider-assigned `num` —
  // for the numeric channel-entry shortcut (type a number, jump straight to that channel),
  // which has to work regardless of which category is currently being browsed. Returns null if
  // there's no client, or no channel with that number.
  findChannelByNumber: (num: number) => Promise<LiveStream | null>
  // Fetches every full-XMLTV guide available (provider's own + user-added third-party sources),
  // then prefills the short-EPG cache from them (see applyEpgPool). Best-effort by design: a
  // provider that blocks xmltv.php, or an unreachable custom URL, degrades to exactly the old
  // per-channel behavior rather than erroring the app.
  loadEpgSources: () => Promise<void>
  // Re-applies the guide pool (epgSources) to every currently-loaded live channel that doesn't
  // yet have provider-fetched data — runs after a pool loads and after each category's
  // liveStreams arrive, since matching needs the channel list.
  applyEpgPool: () => void
  addCustomEpgUrl: (url: string) => void
  removeCustomEpgUrl: (url: string) => void
  // Manual guide-channel → app-channel links (Settings ▸ EPG sources ▸ Map channels) —
  // persisted in settings.epgChannelMappings and applied on the next applyEpgPool.
  addEpgChannelMapping: (mapping: EpgChannelMapping) => void
  removeEpgChannelMapping: (sourceUrl: string, streamId: number) => void
  // Loads the full live catalog into numericChannelCatalog when it isn't cached yet — the
  // mapping picker searches every channel the provider has, not just the currently-browsed
  // category's liveStreams.
  ensureChannelCatalog: () => Promise<void>
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

  // Resizes multiViewSlots to match (existing assignments in still-valid indices survive;
  // extra slots beyond the new, smaller size are dropped) and persists the choice.
  setMultiViewLayout: (layout: MultiViewLayout) => void
  // Opens the channel picker for this slot. Callers are expected to have already checked
  // singleConnectionAccount themselves (see MultiView.tsx) — this action doesn't re-derive or
  // enforce that gating itself, so it's not duplicated between the store and the one place that
  // needs to explain *why* a slot can't be filled right now.
  startPickingMultiViewSlot: (slotIndex: number) => void
  cancelPickingMultiViewSlot: () => void
  assignMultiViewChannel: (slotIndex: number, channel: LiveStream) => void
  clearMultiViewSlot: (slotIndex: number) => void
  toggleHiddenLiveChannel: (streamId: number) => void
  setShowHiddenLiveChannels: (show: boolean) => void
  // Records (or, via forgetLiveAudioFix, clears) that a live channel needs the ffmpeg AAC-remux
  // audio fallback, so the next open skips detection and engages the remux immediately — see
  // the liveAudioFixes field's own comment in lib/types.ts for the shape and why the URL is
  // stored alongside the track index.
  rememberLiveAudioFix: (streamId: number, audioIndex: number, url: string) => void
  forgetLiveAudioFix: (streamId: number) => void

  toggleFavorite: (entry: FavoriteEntry) => void
  isFavorited: (kind: MediaKind, id: number) => boolean
  // Assigns (or clears, via null) which group an already-favorited entry belongs to — a no-op
  // if the key isn't actually favorited, since there's nothing to assign a group to.
  setFavoriteGroup: (key: string, groupId: string | null) => void
  addFavoriteGroup: (name: string) => void
  renameFavoriteGroup: (id: string, name: string) => void
  // Removes the group itself but never the favorites in it — they fall back to ungrouped
  // (groupId: null), the same as any favorite that was never assigned a group at all.
  deleteFavoriteGroup: (id: string) => void
  clearRecentlyWatched: () => void
  refreshRecentlyWatched: () => Promise<void>

  updateEpisodeProgress: (key: string, positionSeconds: number, durationSeconds: number) => void
  toggleEpgReminder: (streamId: number, channelName: string, program: ShortEpgProgram) => void
  isEpgReminderSet: (streamId: number, programId: string) => boolean
  checkEpgReminders: () => Promise<void>

  updateSettings: (patch: Partial<AppSettings>) => void
  setCategoryLocked: (categoryId: string, locked: boolean) => void
  submitPinAttempt: (pin: string) => void
  cancelPinPrompt: () => void
  openSettings: () => void
  closeSettings: () => void
  // Resolves rather than throws either way (ok: false carries the error message) — Settings
  // renders these results directly rather than needing its own try/catch around every call.
  exportBackup: () => Promise<{ ok: boolean; path?: string; error?: string }>
  // Reloads the whole renderer on a successful import (see the implementation's own comment for
  // why) — the caller only ever sees this return for a cancel or a genuine failure.
  importBackup: () => Promise<{ ok: boolean; imported: boolean; error?: string }>
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
  numericChannelCatalog: null,

  epgSources: [],
  epgSourceLabels: [],
  providerGuideAvailable: null,
  epgSourcesStatus: 'idle',
  epgSourceIssues: {},
  epgSourceMatchStats: [],
  shortEpgByStream: {},
  shortEpgFetchedAt: {},
  proxyBase: null,

  nowPlaying: null,
  channelBarOpen: false,

  openSeries: null,
  seriesInfo: null,
  seriesInfoLoading: false,

  previewChannel: null,

  // Resized to match settings.multiViewLayout once init() has actually loaded settings (see
  // there) — DEFAULT_SETTINGS.multiViewLayout (2) is just this field's own initial shape before
  // that, consistent with every other field here that's properly populated by init().
  multiViewSlots: Array(DEFAULT_SETTINGS.multiViewLayout).fill(null),
  multiViewPickingSlot: null,
  showHiddenLiveChannels: false,

  favorites: [],
  favoriteGroups: [],
  recentlyWatched: [],
  refreshingRecentlyWatched: false,
  episodeProgress: {},
  epgReminders: [],
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
      const [profiles, favorites, favoriteGroups, recentlyWatched, episodeProgress, epgReminders, settings] = await Promise.all([
        loadProfiles(),
        loadFavorites(),
        loadFavoriteGroups(),
        loadRecentlyWatched(),
        loadEpisodeProgress(),
        loadEpgReminders(),
        loadSettings()
      ])
      const activeId = await loadActiveProfileId()
      set({
        profiles,
        favorites,
        favoriteGroups,
        recentlyWatched,
        episodeProgress,
        epgReminders,
        settings,
        multiViewSlots: Array(settings.multiViewLayout).fill(null)
      })

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

      // Check for an update before auto-connecting, not just as a background courtesy check
      // that happens to land at some point after. The listeners above are already registered
      // by this point, so a genuine update-available event can't be lost to the race the old
      // main-process-triggered check had (see src/main/index.ts). Bounded to a few seconds so
      // an unreachable GitHub Releases API can't turn into the exact silent-hang feeling just
      // fixed for the connect flow itself (see LoginScreen.tsx's connectElapsedSeconds) — if
      // the check is still running when the timeout fires, connecting proceeds anyway and the
      // prompt can still pop up later if the check eventually does resolve.
      await Promise.race([
        get()
          .checkForUpdates()
          .catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 5000))
      ])

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
      set({
        client,
        status: 'ready',
        singleConnectionAccount: auth.user_info.max_connections === '1',
        // A new connection means a (possibly different) provider's catalog — last profile's
        // cached numeric lookup would otherwise resolve a typed channel number against the
        // wrong account's lineup.
        numericChannelCatalog: null,
        // Same wrong-provider story for EPG: stream IDs are only unique within one provider,
        // so cached listings from the previous profile are not just stale but potentially for a
        // completely different channel that happens to share the id.
        shortEpgByStream: {},
        shortEpgFetchedAt: {},
        epgSources: [],
        epgSourceLabels: [],
        providerGuideAvailable: null,
        epgSourcesStatus: 'idle',
        epgSourceIssues: {},
        epgSourceMatchStats: [],
        proxyBase
      })
      shortEpgFailedAt.clear()
      await saveActiveProfileId(profileId)
      await get().setViewMode('live')
      // Full-guide sources are strictly an enrichment layered on top of the per-channel short
      // EPG the grid already uses — load them in the background rather than gating the UI on
      // what may be a several-MB XMLTV download (or a provider that blocks it outright).
      void get().loadEpgSources()
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
    shortEpgFailedAt.clear()
    set({
      client: null,
      activeProfile: null,
      status: 'idle',
      singleConnectionAccount: false,
      categories: [],
      liveStreams: [],
      vodStreams: [],
      series: [],
      // Every piece of EPG state is provider-scoped — see connect()'s own comment about
      // stream-id collisions across profiles for why these can't survive a disconnect.
      epgSources: [],
      epgSourceLabels: [],
      providerGuideAvailable: null,
      epgSourcesStatus: 'idle',
      epgSourceIssues: {},
      epgSourceMatchStats: [],
      shortEpgByStream: {},
      shortEpgFetchedAt: {},
      proxyBase: null,
      nowPlaying: null,
      channelBarOpen: false,
      unlockedCategoryIds: [],
      numericChannelCatalog: null
    })
  },

  setViewMode: async (mode) => {
    // Favorites and History are both derived purely from local state (no category fetch,
    // no Sidebar) — same short-circuit as each other.
    if (mode === 'favorites' || mode === 'history') {
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
      // Multi-View's channel picker browses Live TV channels the exact same way the Live TV
      // tab itself does (same Sidebar, same liveStreams), so it needs the same category fetch.
      const categories =
        mode === 'live' || mode === 'multiview'
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
    // Live/Movies/Series — see setCategoryLocked and loadSettings' migration. Multi-View's
    // channel picker browses the exact same Live TV categories as the 'live' tab itself (see
    // setViewMode) — mapping it onto the same 'live' namespace here is what keeps a category
    // locked under Live TV actually locked when reached this way too, instead of silently
    // bypassable via a second, never-locked namespace of its own.
    const lockSection = viewMode === 'multiview' ? 'live' : viewMode
    const lockKey = categoryId ? `${lockSection}:${categoryId}` : null
    if (lockKey && settings.parentalPin && settings.lockedCategoryIds.includes(lockKey) && !unlockedCategoryIds.includes(lockKey)) {
      set({ pinPromptCategoryId: categoryId, pinPromptError: null })
      return
    }
    // selectCategory catches its own errors internally (sets `error` in the store).
    void get().selectCategory(categoryId)
  },

  findChannelByNumber: async (num) => {
    const { client } = get()
    if (!client) return null
    let catalog = get().numericChannelCatalog
    if (!catalog) {
      catalog = await client.getLiveStreams()
      set({ numericChannelCatalog: catalog })
    }
    return catalog.find((c) => c.num === num) ?? null
  },

  selectCategory: async (categoryId) => {
    const { client, viewMode } = get()
    if (!client) return
    set({ selectedCategoryId: categoryId })
    try {
      if (viewMode === 'live' || viewMode === 'multiview') {
        const liveStreams = await client.getLiveStreams(categoryId ?? undefined)
        set({ liveStreams })
        // Matching a guide pool to channels needs the channel list (see applyEpgPool) — a
        // newly-loaded category can contain channels the pool has data for that were never
        // visible when the pool loaded.
        get().applyEpgPool()
        // The EPG grid is now the primary way to browse live channels (there's no
        // separate clickable list next to it), so seed it with the first channel in
        // the category instead of leaving it blank until something is clicked. Harmless
        // for Multi-View too — nothing renders previewChannel there (EpgGridPanel isn't
        // mounted in that mode), so this just primes state nothing currently reads.
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

  loadEpgSources: async () => {
    const { client, activeProfile, proxyBase, settings } = get()
    if (!client) return
    set({ epgSourcesStatus: 'loading' })
    const sources: EpgData[] = []
    // Aligned index-for-index with `sources` — applyEpgPool's match report needs to know which
    // label each loaded guide goes with (and whether entry 0 is the provider's own guide).
    const labels: string[] = []
    let providerGuideAvailable: boolean | null = null
    // Per-custom-source diagnostics, surfaced in Settings — a source the user explicitly added
    // must fail visibly (wrong format, HTTP error) instead of silently contributing nothing.
    // The provider's own guide is deliberately exempt: most resellers simply block xmltv.php,
    // and warning about that every single session would be noise, not signal.
    const issues: Record<string, string> = {}
    // 1. The provider's own full guide. M3U profiles skip it: their playlist's guide is already
    //    what M3uClient.getShortEpg serves per channel, so pooling it again would only duplicate
    //    data under a second matching pass.
    if (activeProfile?.kind !== 'm3u') {
      try {
        sources.push(parseXmltv(await client.getFullEpgXml()))
        labels.push('Provider guide (xmltv.php)')
        providerGuideAvailable = true
      } catch {
        providerGuideAvailable = false
        // Many Xtream resellers restrict or disable xmltv.php entirely (this app's own test
        // account 403s on it) — the whole point of the sources below is that this failing no
        // longer means "today's window is all you get."
      }
    }
    // 2. User-added third-party guides (any XMLTV URL — plain XML or the .xml.gz form many
    //    guide providers serve, decompressed transparently), fetched through the same
    //    /__fetch/ passthrough every other cross-origin request uses. Sources load
    //    sequentially — a slow one shouldn't hold the earlier ones' data hostage.
    for (const url of settings.customEpgUrls) {
      try {
        if (!proxyBase) throw new Error('Proxy base URL not available')
        const res = await fetch(`${proxyBase}/__fetch/${encodeURIComponent(url)}`)
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        const parsed = parseXmltv(await decodeMaybeGzipBytes(await res.arrayBuffer()))
        // A document with no channels or no programmes can't contribute anything (matching
        // needs both) — far and away the most common cause is a plain-text or PDF schedule in
        // a slot meant for a machine-readable XMLTV guide, so say exactly that.
        if (parsed.channels.size === 0 || parsed.programmesByChannel.size === 0) {
          issues[url] =
            "Loaded, but didn't look like an XMLTV guide (no channels or programmes found). Plain-text or PDF schedules can't be parsed — if this source really is a guide, use its XML or .xml.gz form."
        } else {
          sources.push(parsed)
          labels.push(url)
        }
      } catch (err) {
        issues[url] = `Couldn't load: ${err instanceof Error ? err.message : String(err)}`
        console.error(`[epg] failed to load custom EPG source ${url}:`, err)
      }
    }
    set({ epgSources: sources, epgSourceLabels: labels, providerGuideAvailable, epgSourcesStatus: 'ready', epgSourceIssues: issues })
    get().applyEpgPool()
  },

  applyEpgPool: () => {
    const { epgSources, epgSourceLabels, providerGuideAvailable, liveStreams, shortEpgByStream, shortEpgFetchedAt, settings } = get()
    // First source (in loadEpgSources' priority order) with programmes for a channel wins —
    // the provider's own guide outranks a third party's, and earlier custom URLs outrank later
    // ones.
    const pool = new Map<number, ShortEpgProgram[]>()
    // Per-source matching report for Settings — what a source actually did against the
    // currently-loaded channels, including how much of its matching rests on the weaker
    // name join and which channel names found no counterpart at all.
    const stats: EpgSourceMatchStats[] = []
    if (providerGuideAvailable === false) {
      stats.push({ source: 'Provider guide (xmltv.php)', available: false, loadedChannels: liveStreams.length, matched: 0, byId: 0, byName: 0, byManual: 0, unmatchedNames: [] })
    }
    epgSources.forEach((source, index) => {
      // Manual mappings are keyed to the custom source's own URL (the provider guide is not
      // manually mappable — see EpgChannelMapping), so look them up by this entry's label.
      const sourceUrl = epgSourceLabels[index]
      const manual = new Map(
        settings.epgChannelMappings.filter((m) => m.sourceUrl === sourceUrl).map((m) => [m.streamId, m.guideChannelId])
      )
      const matches = matchXmltvChannels(liveStreams, source, manual)
      let byId = 0
      let byName = 0
      let byManual = 0
      const unmatchedNames: string[] = []
      for (const stream of liveStreams) {
        const match = matches.get(stream.stream_id)
        const programmes = match ? source.programmesByChannel.get(match.channelId) : undefined
        if (match && programmes?.length) {
          if (match.method === 'id') byId += 1
          else if (match.method === 'manual') byManual += 1
          else byName += 1
        } else {
          // Cap the list — against a large category this is diagnostic material, not a roster.
          if (unmatchedNames.length < 30) unmatchedNames.push(stream.name)
        }
      }
      const label = index === 0 && providerGuideAvailable === true ? 'Provider guide (xmltv.php)' : epgSourceLabels[index] ?? `Source ${index + 1}`
      stats.push({
        source: label,
        available: true,
        loadedChannels: liveStreams.length,
        matched: byId + byName + byManual,
        byId,
        byName,
        byManual,
        unmatchedNames
      })
      for (const [streamId, match] of matches) {
        if (pool.has(streamId)) continue
        const programmes = source.programmesByChannel.get(match.channelId)
        if (programmes?.length) pool.set(streamId, xmltvProgrammesToShort(programmes, match.channelId))
      }
    })
    set({ epgSourceMatchStats: stats })
    if (epgSources.length === 0 || liveStreams.length === 0) return
    if (pool.size === 0) return
    const nextShort = { ...shortEpgByStream }
    let changed = false
    for (const [streamId, programmes] of pool) {
      // Never overwrite provider-fetched data (fetchedAt set) — the pool only PREFILLS: channels
      // with nothing yet, or channels whose only data so far is an older prefill from this same
      // pool (fetchedAt unset). loadShortEpg will still fetch the provider's fresher per-channel
      // data for these when their row loads, then merge over the prefill.
      if (shortEpgFetchedAt[streamId]) continue
      if (nextShort[streamId] === programmes) continue
      nextShort[streamId] = programmes
      changed = true
    }
    if (changed) set({ shortEpgByStream: nextShort })
  },

  addCustomEpgUrl: (url) => {
    const trimmed = url.trim()
    if (!trimmed) return
    const current = get().settings.customEpgUrls
    if (current.includes(trimmed)) return
    get().updateSettings({ customEpgUrls: [...current, trimmed] })
    // Apply immediately rather than waiting for the next connect — adding a source is an
    // explicit "make my guide better" action, and the whole fetch is best-effort anyway.
    if (get().client) void get().loadEpgSources()
  },

  removeCustomEpgUrl: (url) => {
    const current = get().settings.customEpgUrls
    if (!current.includes(url)) return
    get().updateSettings({ customEpgUrls: current.filter((u) => u !== url) })
    if (get().client) void get().loadEpgSources()
  },

  // One stream maps to one guide channel per source — re-adding replaces that stream's
  // previous mapping rather than stacking a duplicate. Removing a source (removeCustomEpgUrl)
  // leaves its mappings in settings harmlessly: they only ever join against a guide parsed
  // from that URL, so an orphaned mapping can't mis-fire — but pruning it here would need a
  // second updateSettings round-trip mid-edit for no user-visible gain.
  addEpgChannelMapping: (mapping) => {
    if (!mapping.sourceUrl.trim() || !mapping.guideChannelId) return
    const rest = get().settings.epgChannelMappings.filter(
      (m) => !(m.sourceUrl === mapping.sourceUrl && m.streamId === mapping.streamId)
    )
    get().updateSettings({ epgChannelMappings: [...rest, mapping] })
    // The guides themselves are already loaded — reapplying the pool is enough for the grid
    // and the match report to reflect the new mapping immediately.
    get().applyEpgPool()
  },

  removeEpgChannelMapping: (sourceUrl, streamId) => {
    const current = get().settings.epgChannelMappings
    if (!current.some((m) => m.sourceUrl === sourceUrl && m.streamId === streamId)) return
    get().updateSettings({ epgChannelMappings: current.filter((m) => !(m.sourceUrl === sourceUrl && m.streamId === streamId)) })
    get().applyEpgPool()
  },

  ensureChannelCatalog: async () => {
    const { client } = get()
    if (!client || get().numericChannelCatalog) return
    try {
      const catalog = await client.getLiveStreams()
      set({ numericChannelCatalog: catalog })
    } catch (err) {
      // The mapping picker degrades to the currently-browsed category when the full catalog
      // can't load (offline blip, provider hiccup) — mapping is a convenience layer, not
      // worth an error surface of its own.
      console.error('[store] failed to load the full channel catalog for EPG mapping:', err)
    }
  },

  loadShortEpg: (streamId) => {
    const { client, shortEpgByStream, shortEpgFetchedAt } = get()
    if (!client) return Promise.resolve()
    if (shortEpgInFlight.has(streamId)) return Promise.resolve()
    // A cache entry is only a reason NOT to fetch when it's provider-fetched (fetchedAt set),
    // still fresh within SHORT_EPG_TTL_MS, and either still covers "now" or was an honest
    // empty answer — an entry whose last programme has already ended (the "rest of today"
    // window running out, or the app simply staying open past midnight) is refetchable no
    // matter how recently it was fetched, which is what fixes the old "every channel blank
    // until restart" behavior. Entries prefilled from a guide pool have no fetchedAt, so they
    // never suppress the provider fetch.
    const cached = shortEpgByStream[streamId]
    const fetchedAt = shortEpgFetchedAt[streamId] ?? 0
    const spansNow =
      cached !== undefined && cached.some((p) => Number(p.stop_timestamp) * 1000 > Date.now())
    if (fetchedAt && Date.now() - fetchedAt < SHORT_EPG_TTL_MS && (spansNow || cached?.length === 0)) {
      return Promise.resolve()
    }
    // Recently failed — wait out the cooldown rather than hammering a channel the provider is
    // currently failing for, but (unlike before) do come back and retry after it.
    const failedAt = shortEpgFailedAt.get(streamId) ?? 0
    if (Date.now() - failedAt < SHORT_EPG_FAILURE_COOLDOWN_MS) return Promise.resolve()
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
          shortEpgFailedAt.delete(streamId)
          // Merge with whatever's already cached for this channel — typically a guide-pool
          // prefill (see applyEpgPool): provider entries win their slots, the pool's later
          // days/gap-fillers survive around them.
          const merged = mergeShortEpg(listings, shortEpgByStream[streamId] ?? [])
          set({
            shortEpgByStream: { ...get().shortEpgByStream, [streamId]: merged },
            shortEpgFetchedAt: { ...get().shortEpgFetchedAt, [streamId]: Date.now() }
          })
        } catch {
          shortEpgFailedAt.set(streamId, Date.now())
          // If nothing has ever loaded for this channel, cache an honest empty rather than
          // leaving the row's loading shimmer up forever — [] renders as "No programme data"
          // and stays retryable after the cooldown above.
          if (get().shortEpgByStream[streamId] === undefined) {
            set({ shortEpgByStream: { ...get().shortEpgByStream, [streamId]: [] } })
          }
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
    const updated = [entry, ...withoutDupe].slice(0, RECENTLY_WATCHED_LIMIT)
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

  setMultiViewLayout: (layout) => {
    const { multiViewSlots } = get()
    const resized = Array.from({ length: layout }, (_, i) => multiViewSlots[i] ?? null)
    set({ multiViewSlots: resized })
    get().updateSettings({ multiViewLayout: layout })
  },

  startPickingMultiViewSlot: (slotIndex) => set({ multiViewPickingSlot: slotIndex }),
  cancelPickingMultiViewSlot: () => set({ multiViewPickingSlot: null }),

  assignMultiViewChannel: (slotIndex, channel) => {
    const slots = [...get().multiViewSlots]
    slots[slotIndex] = channel
    set({ multiViewSlots: slots, multiViewPickingSlot: null })
  },

  clearMultiViewSlot: (slotIndex) => {
    const slots = [...get().multiViewSlots]
    slots[slotIndex] = null
    set({ multiViewSlots: slots })
  },

  toggleHiddenLiveChannel: (streamId) => {
    const hidden = get().settings.hiddenLiveStreamIds
    const hiddenLiveStreamIds = hidden.includes(streamId) ? hidden.filter((id) => id !== streamId) : [...hidden, streamId]
    get().updateSettings({ hiddenLiveStreamIds })
  },

  setShowHiddenLiveChannels: (show) => set({ showHiddenLiveChannels: show }),

  rememberLiveAudioFix: (streamId, audioIndex, url) => {
    const liveAudioFixes = { ...get().settings.liveAudioFixes, [String(streamId)]: { audioIndex, url } }
    get().updateSettings({ liveAudioFixes })
  },

  forgetLiveAudioFix: (streamId) => {
    const current = get().settings.liveAudioFixes
    if (!(String(streamId) in current)) return
    const liveAudioFixes = { ...current }
    delete liveAudioFixes[String(streamId)]
    get().updateSettings({ liveAudioFixes })
  },

  toggleFavorite: (entry) => {
    const key = favoriteKey(entry)
    const { favorites } = get()
    const exists = favorites.some((f) => favoriteKey(f) === key)
    const updated = exists ? favorites.filter((f) => favoriteKey(f) !== key) : [entry, ...favorites]
    set({ favorites: updated })
    saveFavorites(updated).catch((err) => console.error('[store] failed to save favorites:', err))
  },

  isFavorited: (kind, id) => get().favorites.some((f) => favoriteKey(f) === `${kind}:${id}`),

  setFavoriteGroup: (key, groupId) => {
    const { favorites } = get()
    if (!favorites.some((f) => favoriteKey(f) === key)) return
    const updated = favorites.map((f) => (favoriteKey(f) === key ? { ...f, groupId } : f))
    set({ favorites: updated })
    saveFavorites(updated).catch((err) => console.error('[store] failed to save favorites:', err))
  },

  addFavoriteGroup: (name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const updated = [...get().favoriteGroups, { id: crypto.randomUUID(), name: trimmed }]
    set({ favoriteGroups: updated })
    saveFavoriteGroups(updated).catch((err) => console.error('[store] failed to save favorite groups:', err))
  },

  renameFavoriteGroup: (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const updated = get().favoriteGroups.map((g) => (g.id === id ? { ...g, name: trimmed } : g))
    set({ favoriteGroups: updated })
    saveFavoriteGroups(updated).catch((err) => console.error('[store] failed to save favorite groups:', err))
  },

  deleteFavoriteGroup: (id) => {
    const updatedGroups = get().favoriteGroups.filter((g) => g.id !== id)
    // Ungroups its members rather than removing them — deleting a *group* shouldn't delete the
    // favorites that happened to be in it, the same way removing a folder's label wouldn't
    // delete its contents.
    const updatedFavorites = get().favorites.map((f) => (f.groupId === id ? { ...f, groupId: null } : f))
    set({ favoriteGroups: updatedGroups, favorites: updatedFavorites })
    saveFavoriteGroups(updatedGroups).catch((err) => console.error('[store] failed to save favorite groups:', err))
    saveFavorites(updatedFavorites).catch((err) => console.error('[store] failed to save favorites:', err))
  },

  clearRecentlyWatched: () => {
    set({ recentlyWatched: [] })
    saveRecentlyWatched([]).catch((err) => console.error('[store] failed to save recently-watched:', err))
  },

  // Best-effort refresh of stale name/icon info: an entry captures whatever the channel/movie
  // was called at watch time, so a provider-side rename (or the channel/title disappearing
  // from the lineup entirely) leaves it showing outdated info indefinitely otherwise. Manual
  // (a button in the History tab), not automatic-on-open — this fetches the *entire* live/VOD
  // catalog to cross-reference against, which on a large account (a real test account here runs
  // ~24k live channels) is too heavy to redo unprompted every time the tab is opened.
  //
  // Deliberately update-only, never delete: an entry not found in the freshly-fetched catalog
  // is ambiguous (genuinely removed by the provider, or just not visible right now — favorites
  // and recently-watched are both stored globally, not per-profile, so a multi-profile setup
  // could easily have an entry from a *different* provider than the one currently connected)
  // and this codebase already accepts "recently watched" as a stable historical record rather
  // than a live-validated one elsewhere (see the Quick wins note on this same limitation). Only
  // updating what's confirmed still there keeps this safe to run without a new way to silently
  // lose history entries that are still perfectly valid.
  //
  // Series entries are skipped entirely and left untouched — playTimeshift and series playback
  // both store the *episode's* id as streamId (see RecentlyWatchedEntry), not a series_id, and
  // there's no catalog endpoint that lists episodes directly to check one against.
  refreshRecentlyWatched: async () => {
    const { client, recentlyWatched, activeProfile, refreshingRecentlyWatched } = get()
    if (!client || refreshingRecentlyWatched) return
    const hasLive = recentlyWatched.some((e) => e.kind === 'live')
    // An M3U playlist profile never has real VOD/series catalogs (see m3uClient.ts) — its
    // getVodStreams() always resolves empty, which would otherwise read as "every movie entry
    // was removed" rather than "this profile type doesn't have movies at all."
    const hasMovie = activeProfile?.kind !== 'm3u' && recentlyWatched.some((e) => e.kind === 'movie')
    if (!hasLive && !hasMovie) return

    set({ refreshingRecentlyWatched: true })
    try {
      const [liveStreams, vodStreams] = await Promise.all([
        hasLive ? client.getLiveStreams() : Promise.resolve<LiveStream[]>([]),
        hasMovie ? client.getVodStreams() : Promise.resolve<VodStream[]>([])
      ])
      const liveById = new Map(liveStreams.map((s) => [s.stream_id, s]))
      const vodById = new Map(vodStreams.map((s) => [s.stream_id, s]))

      const updated = recentlyWatched.map((entry) => {
        if (entry.kind === 'live' && hasLive) {
          const current = liveById.get(entry.streamId)
          if (current) return { ...entry, name: current.name, icon: current.stream_icon, tvArchive: current.tv_archive }
        } else if (entry.kind === 'movie' && hasMovie) {
          const current = vodById.get(entry.streamId)
          if (current) return { ...entry, name: current.name, icon: current.stream_icon }
        }
        return entry
      })
      set({ recentlyWatched: updated })
      saveRecentlyWatched(updated).catch((err) => console.error('[store] failed to save recently-watched:', err))
    } catch (err) {
      console.error('[store] failed to refresh recently-watched:', err)
    } finally {
      set({ refreshingRecentlyWatched: false })
    }
  },

  updateEpisodeProgress: (key, positionSeconds, durationSeconds) => {
    const updated = {
      ...get().episodeProgress,
      [key]: { positionSeconds, durationSeconds, updatedAt: Date.now() }
    }
    set({ episodeProgress: updated })
    saveEpisodeProgress(updated).catch((err) => console.error('[store] failed to save episode progress:', err))
  },

  toggleEpgReminder: (streamId, channelName, program) => {
    const id = reminderId(streamId, program.id)
    const reminders = get().epgReminders.some((reminder) => reminder.id === id)
      ? get().epgReminders.filter((reminder) => reminder.id !== id)
      : [...get().epgReminders, createReminder(streamId, channelName, program)]
    set({ epgReminders: reminders })
    void saveEpgReminders(reminders)
  },

  isEpgReminderSet: (streamId, programId) => get().epgReminders.some((reminder) => reminder.id === reminderId(streamId, programId)),

  checkEpgReminders: async () => {
    const now = Date.now()
    const { due, active } = splitDueReminders(get().epgReminders, now)
    if (active.length !== get().epgReminders.length) {
      set({ epgReminders: active })
      await saveEpgReminders(active)
    }
    if (due.length === 0 || typeof window === 'undefined' || !window.api?.notifications) return
    const notifiedAt = Date.now()
    const dueIds = new Set(due.map((reminder) => reminder.id))
    const updated = active.map((reminder) => (dueIds.has(reminder.id) ? { ...reminder, notifiedAt } : reminder))
    set({ epgReminders: updated })
    await saveEpgReminders(updated)
    await Promise.all(
      due.map((reminder) =>
        window.api.notifications.show('Programme reminder', `${reminder.programTitle} starts soon on ${reminder.channelName}`)
      )
    )
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

  exportBackup: async () => {
    try {
      // A cancelled save dialog resolves with null, same as import's own cancel case below —
      // that's not a failure, just nothing to report, so it stays ok: true with no path rather
      // than being conflated with a genuine write error.
      const path = await window.api.backup.export()
      return { ok: true, path: path ?? undefined }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  // A successful import overwrites profiles/favorites/history/settings underneath every part of
  // the already-initialized store — trying to patch each of those in-memory fields individually
  // to match would mean re-deriving everything init() already knows how to do from a cold start
  // (reconnecting the active profile, reloading categories, re-checking the parental PIN's
  // encryption, ...). Reloading the whole renderer is what actually gets that for free: the next
  // load's own init() reads the newly-imported values exactly the way a fresh launch would.
  importBackup: async () => {
    try {
      const { imported } = await window.api.backup.import()
      if (imported) window.location.reload()
      return { ok: true, imported }
    } catch (err) {
      return { ok: false, imported: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

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
