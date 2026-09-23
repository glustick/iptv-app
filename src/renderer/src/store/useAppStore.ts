import { create } from 'zustand'
import { XtreamClient } from '../lib/xtream'
import { M3uClient } from '../lib/m3uClient'
import type { IptvClient } from '../lib/iptvClient'
import {
  parseXmltvProgressive,
  matchXmltvChannels,
  mergeShortEpg,
  xmltvProgrammesToShort,
  decodeMaybeGzipBytes,
  buildGuideIndex,
  planBulkSuggestionApply,
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
  CustomCategory,
  CustomCategoryKind,
  EpgChannelMapping,
  VpnStatus,
  VpnProfile,
  MultiViewLayout
} from '../lib/types'
import { MAX_GUIDE_XML_CHARS } from '../lib/xmltvSections'
import { channelKey, channelKeyCandidates } from '../lib/channelIdentity'
import {
  analyzeMediaPlaylist,
  classifyChannelHealth,
  type ChannelHealth,
  type MediaPlaylistAnalysis
} from '../lib/channelHealth'
import { DEFAULT_SETTINGS, favoriteKey } from '../lib/types'
import { addStreamIds, kindOf, moveItem, removeStreamId } from '../lib/customCategories'
import { shouldWarnOnVpnDisconnect } from '../lib/vpnStatus'
import { createReminder, reminderId, splitDueReminders, type EpgReminder } from '../lib/reminders'

/** One connected playlist: the saved profile it came from, its own client, and its own status. */
export interface PlaylistConnection {
  profileId: string
  name: string
  client: IptvClient
  /** Per-playlist, so one failing account can be shown as failing without hiding the healthy one. */
  error: string | null
  /** This playlist's own category list — the sidebar groups them by playlist. */
  categories: Category[]
}

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
// Monotonic token for loadEpgSources runs: adding/removing a source while a several-MB guide
// download is still in flight starts a newer run, and only the newest run may commit its
// results — letting a stale run finish would RESURRECT sources the user just removed (they'd
// stay active in the guide and match report while unlisted and undeletable in Settings).
let epgSourcesLoadSeq = 0

/**
 * Runs the bulk-suggestion planner in chunks, yielding to the event loop between them, and merges
 * the per-chunk results. The planner is pure and per-channel independent, so chunking changes
 * nothing about the outcome — it changes whether the window survives it. Measured on a catalogue
 * the size of the real provider's (27.8k channels against a 5k-channel guide) the single-pass
 * version takes ~5 seconds, which is a visibly frozen window; chunked, the same work runs while
 * the UI keeps painting. The chunk size is a compromise between yielding often enough to stay
 * responsive and rarely enough that the yields aren't the cost.
 */
async function planBulkSuggestionApplyChunked(
  catalog: LiveStream[],
  index: ReturnType<typeof buildGuideIndex>,
  manual: Map<number, string>,
  threshold: number
): Promise<ReturnType<typeof planBulkSuggestionApply>> {
  const CHUNK = 2000
  const total = { applied: [] as ReturnType<typeof planBulkSuggestionApply>['applied'], considered: 0, alreadyMapped: 0, belowThreshold: 0 }
  for (let offset = 0; offset < catalog.length; offset += CHUNK) {
    const part = planBulkSuggestionApply(catalog.slice(offset, offset + CHUNK), index, manual, threshold)
    total.applied.push(...part.applied)
    total.considered += part.considered
    total.alreadyMapped += part.alreadyMapped
    total.belowThreshold += part.belowThreshold
    // Hand the frame back so the window keeps painting and the button can show progress.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return total
}
const shortEpgInFlight = new Set<number>()
const shortEpgFailedAt = new Map<number, number>()

// Channel-health probing (see probeChannelHealth): one small manifest request per channel, so a
// whole category's worth of rows mounting at once must not become a burst — the same queueing
// idea as the short-EPG fetches above, with a lower cap because these are ad-hoc per-channel GETs
// against the provider rather than a documented, bulk-friendly API.
const MAX_CONCURRENT_HEALTH_PROBES = 2
const HEALTH_PROBE_TIMEOUT_MS = 10_000
// A probe that failed for a *transport* reason (timeout, HTTP error) says nothing about the
// channel itself — unlike a body that was fetched and found to be unusable. Those are retried
// after this cooldown instead of being recorded as a verdict, so a passing network blip can't
// brand a channel for the rest of the session.
const HEALTH_PROBE_FAILURE_COOLDOWN_MS = 5 * 60 * 1000
let activeHealthProbes = 0
// `| Promise<void>` for the same reason the short-EPG queue carries it: each entry's own
// try/finally settles it and chains the next one, so runNextHealthProbe() never awaits.
const healthProbeQueue: Array<() => void | Promise<void>> = []
const healthProbeInFlight = new Set<number>()
// Channels already given a verdict this session. Deliberately module-level, like the short-EPG
// bookkeeping above, because it is plumbing rather than anything a component renders — and it is
// cleared on connect/disconnect, since stream ids are provider-scoped and a previous provider's
// verdicts would be about a different channel entirely.
const healthProbeSettled = new Set<number>()
const healthProbeFailedAt = new Map<number, number>()

/**
 * Sends a diagnostic line to the main process's lifecycle log, if there is a bridge to send it
 * through. Guarded rather than optional-chained: `window` is *undefined* (not merely missing a
 * property) when this store is exercised outside a renderer — its own tests run in plain Node — and
 * an unguarded reference throws a ReferenceError that takes the caller down with it.
 */
function logGuideTiming(message: string): void {
  if (typeof window === 'undefined') return
  try {
    void window.api?.app?.logGuideTiming?.(message)
  } catch {
    // Diagnostics must never be able to break the thing they are describing.
  }
}

function runNextHealthProbe(): void {
  if (activeHealthProbes >= MAX_CONCURRENT_HEALTH_PROBES) return
  const next = healthProbeQueue.shift()
  if (!next) return
  activeHealthProbes++
  void next()
}

function runNextShortEpgFetch(): void {
  if (activeShortEpgFetches >= MAX_CONCURRENT_SHORT_EPG_FETCHES) return
  const next = shortEpgQueue.shift()
  if (!next) return
  activeShortEpgFetches++
  void next()
}

/** Settings display label for the provider's own xmltv.php guide. Also how that guide's pool
 * entry is told apart from user-added URL sources — a custom source's label IS its URL, which
 * can't collide with this literal in any realistic setup. */
export const PROVIDER_GUIDE_LABEL = 'Provider guide (xmltv.php)'

/** One probed channel's feed health — see lib/channelHealth.ts and probeChannelHealth. */
export interface ChannelHealthEntry {
  health: ChannelHealth
  /** Total playlist length when the feed is a fixed loop; null when unknown or not applicable. */
  durationSeconds: number | null
  checkedAt: number
}

/** One row of the per-source EPG match report shown in Settings — see applyEpgPool. */
export interface EpgSourceMatchStats {
  source: string
  // false = this source contributed nothing this session — reason says exactly why (failed
  // download, wrong format, provider blocks its own guide). The report references EVERY
  // configured source: loaded ones get match counts, failed ones get their reason — a source
  // absent from the report entirely would read as "not configured" to the user.
  available: boolean
  reason: string | null
  loadedChannels: number
  matched: number
  byId: number
  byName: number
  byFuzzy: number
  byManual: number
  unmatchedNames: string[]
}

export interface NowPlaying {
  kind: MediaKind
  streamId: number
  // Which playlist this playback came from. Needed to key per-channel state correctly — the
  // remembered audio fix — when two providers number their channels independently (the same id on
  // two playlists is two different channels; see lib/channelIdentity).
  playbackPlaylistId?: string | null
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
  // Every connected playlist, in display order — the first is also `client`/`activeProfile` above,
  // which stay in place so the single-provider surfaces (VOD, series, the guide pool) keep working
  // unchanged. Each entry's client routes through the proxy's per-request passthrough (see
  // lib/xtream.ts), which is what lets more than one account be live at once.
  playlists: PlaylistConnection[]
  // The playlist whose channels keep their bare `stream_id` as their identity in everything stored
  // per channel — see lib/channelIdentity.ts. The first connected one.
  primaryPlaylistId: string | null
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
  // Full movies/series catalogs, cached the same way and for the same reason as
  // numericChannelCatalog above — custom categories of those kinds resolve their stored ids
  // against these rather than against the currently-browsed provider category's own list.
  vodCatalog: VodStream[] | null
  seriesCatalog: SeriesItem[] | null

  // Every parsed full-XMLTV guide available this session, in priority order: the provider's own
  // xmltv.php guide first (when the provider allows it), then each user-added third-party source
  // (settings.customEpgUrls) in order. Used to fill gaps the per-channel get_short_epg window
  // can't — see loadEpgSources/applyEpgPool. Empty when no guide is available or fetchable.
  epgSources: EpgData[]
  // Label for each entry in epgSources, index-aligned: the provider guide's display name or
  // the custom URL it was fetched from — what applyEpgPool's match report calls each source.
  epgSourceLabels: string[]
  // Which guide source actually supplied each live channel's pooled listings, keyed by streamId —
  // the FIRST source in priority order that has programmes for it (see applyEpgPool). Surfaced in
  // the channel preview so "why does this channel have listings and that one doesn't" has an
  // answer on screen instead of only in the match report. Reset with the rest of the EPG state.
  epgSourceByStream: Record<number, string>
  // true/false once an Xtream connect has tried the provider's own xmltv.php guide; null on
  // M3U profiles (their playlist guide never enters the pool as a separate source).
  providerGuideAvailable: boolean | null
  epgSourcesStatus: 'idle' | 'loading' | 'ready'
  // Section progress while a large guide is parsed (see parseXmltvProgressive): null when nothing is
  // being parsed, so the UI can show "section 7 of 12" instead of an inert "Loading…" — which is also
  // how a user can see that the window is still alive during a load that used to freeze it.
  epgLoadProgress: { done: number; total: number } | null
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
  // Per-channel feed health, probed lazily as rows scroll into view (probeChannelHealth) —
  // 'loop' is a channel whose playlist is already finished, i.e. a fixed clip rather than a
  // live feed; see lib/channelHealth.ts for why that is the signal and how it is read.
  channelHealthByStream: Record<number, ChannelHealthEntry>
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
  // Whether channels known not to be live are listed alongside the rest. On by default: the
  // badge already tells the truth about them, and silently hiding channels a provider is
  // serving (badly) would look like the app is missing content. The toggle is what a user
  // reaches for once they've decided they don't want to scroll past them.
  showNotLiveChannels: boolean
  // Which user-made category the sidebar has selected (see CustomCategory) — null whenever a
  // provider category (or All) is selected instead. Kept separate from selectedCategoryId
  // because a custom category has no provider category_id: setting that field to a custom id
  // would make the sidebar's own highlight logic and the Multi-View picker's select disagree.
  selectedCustomCategoryId: string | null
  customCategoriesOpen: boolean

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
  // The dedicated "Guide & EPG" surface (0.7.92) — the EPG configuration used to live inside
  // the Settings modal, which had grown a single long scroll where the guide pool, the mapping
  // editor and the match report sat between the PIN and the VPN profiles. A separate flag rather
  // than a section id on Settings keeps the two surfaces independent, so each can be opened,
  // closed and Escape-handled on its own (see lib/overlays.ts for the priority chain).
  guideOpen: boolean
  // Set by a channel row's context menu ("EPG match…") to aim the Guide & EPG surface at one
  // channel: GuideSettingsPage consumes it on open and opens that channel's mapping editor with
  // the channel preselected (see openEpgMatch). null when nothing is being matched.
  epgMatchTarget: { streamId: number; streamName: string } | null
  // Derived in the overlays layer from epgMatchTarget !== null; the close action simply clears
  // the target, so the two can never disagree about whether the panel is open.
  channelMatchOpen: boolean
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
  updateInfo: { version: string; releaseNotes: string | null } | null
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
  // Connects/disconnects one playlist. Adding re-connects; dropping tears that account's client
  // down — see AppSettings.enabledPlaylistIds for why hiding is modelled as "not connected".
  setPlaylistEnabled: (profileId: string, enabled: boolean) => Promise<void>
  // Which playlist's categories the sidebar is showing, and whose channels the grid lists.
  selectedPlaylistId: string | null
  selectPlaylist: (profileId: string) => void
  // Whether a channel is hidden — resolved through lib/channelIdentity so the same id on two
  // playlists is two different channels.
  isChannelHidden: (playlistId: string | null | undefined, streamId: number) => boolean
  requestCategory: (categoryId: string | null, playlistId?: string | null) => void
  selectCategory: (categoryId: string | null, playlistId?: string | null) => Promise<void>
  // "My Categories" (see CustomCategory): user-made Live TV groupings shown above the provider's
  // own categories. Creating/renaming/removing and adding/reordering channels all persist into
  // settings.customCategories, and a change to the SELECTED category is reflected in the grid
  // immediately without a refetch.
  openCustomCategories: () => void
  closeCustomCategories: () => void
  createCustomCategory: (name: string, kind?: CustomCategoryKind) => string
  renameCustomCategory: (id: string, name: string) => void
  deleteCustomCategory: (id: string) => void
  addChannelsToCustomCategory: (id: string, streamIds: number[]) => void
  removeChannelFromCustomCategory: (id: string, streamId: number) => void
  reorderCustomCategoryChannels: (id: string, fromIndex: number, toIndex: number) => void
  // Reorders the categories themselves — their sequence in settings IS their order in the sidebar.
  reorderCustomCategories: (fromIndex: number, toIndex: number) => void
  requestCustomCategory: (id: string) => void
  // Rebuilds liveStreams for a custom category from the cached catalog (no-op unless it's the
  // one currently selected) — see its implementation for why every edit path calls it.
  refreshCustomCategoryStreams: (id: string) => void
  // Loads (once per session) the catalog a custom category of this kind resolves against — the
  // live channel catalog, or the movies/series catalogs. Same "no category filter = whole
  // catalog" call the live one already uses, and the same cache-until-reconnect lifetime.
  ensureCustomCategoryCatalog: (kind: CustomCategoryKind) => Promise<void>
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
  // Bulk-applies high-confidence suggestions for one source's unmatched channels (Guide & EPG ▸
  // Map channels) — creates ordinary manual mappings, so every one stays individually
  // reviewable and removable afterwards. Returns what it did for the editor to report.
  applySuggestedMappings: (sourceUrl: string, threshold: number) => Promise<{ applied: number; stillUnmatched: number }>
  // The same bulk apply, run across every user-added source in priority order: per source, only
  // channels nothing has resolved yet (and nothing has been mapped for by an earlier source in
  // this same run). Returns what each source contributed, since "which source did that" is the
  // only useful thing to report for a cross-source action.
  applySuggestedMappingsAcrossSources: (threshold: number) => Promise<{
    applied: number
    perSource: Array<{ source: string; applied: number }>
  }>
  addCustomEpgUrl: (url: string) => void
  removeCustomEpgUrl: (url: string) => void
  // Reorders the user's EPG sources — their sequence in settings IS their priority: the provider's
  // own guide is always tried first, then custom sources top to bottom, and the first source with
  // programmes for a channel wins it.
  reorderCustomEpgUrls: (fromIndex: number, toIndex: number) => void
  // Manual guide-channel → app-channel links (Guide & EPG ▸ Map channels) —
  // persisted in settings.epgChannelMappings and applied on the next applyEpgPool.
  addEpgChannelMapping: (mapping: EpgChannelMapping) => void
  // Switches a guide source's listings off (or back on) without removing it — "show/hide its
  // guide". Persisted in settings and honoured by applyEpgPool.
  setEpgSourceHidden: (url: string, hidden: boolean) => void
  // Backs the per-channel match panel's Escape/click-outside (see ChannelMatchModal).
  closeChannelMatch: () => void
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
    tvArchive?: number,
    playlistId?: string | null
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
  toggleHiddenLiveChannel: (streamId: number, playlistId?: string | null) => void
  setShowHiddenLiveChannels: (show: boolean) => void
  // Probes one channel's own playlist for feed health (see lib/channelHealth.ts). Resolves when
  // the queued probe actually ran; a channel already judged this session, or already in flight,
  // resolves immediately.
  probeChannelHealth: (streamId: number) => Promise<void>
  setShowNotLiveChannels: (show: boolean) => void
  // Records (or, via forgetLiveAudioFix, clears) that a live channel needs the ffmpeg AAC-remux
  // audio fallback, so the next open skips detection and engages the remux immediately — see
  // the liveAudioFixes field's own comment in lib/types.ts for the shape and why the URL is
  // stored alongside the track index.
  rememberLiveAudioFix: (streamId: number, audioIndex: number, url: string, playlistId?: string | null) => void
  forgetLiveAudioFix: (streamId: number, playlistId?: string | null) => void

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
  // Opening either surface closes the other — they are siblings, never stacked, so there is
  // always exactly one Escape target between them.
  openGuide: () => void
  closeGuide: () => void
  // Opens the guide aimed at one channel — see epgMatchTarget. Clears the target if the guide
  // is merely opened normally instead.
  openEpgMatch: (streamId: number, streamName: string) => void
  clearEpgMatchTarget: () => void
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
  // Backs the "Reconnect VPN" action on the stream-route warning banner — see VpnWarnings.tsx.
  reconnectVpnTunnel: () => Promise<void>

  checkForUpdates: () => Promise<void>
  downloadUpdate: () => Promise<void>
  installUpdate: () => void
  dismissUpdatePrompt: () => void
}

/**
 * Builds a client for one saved profile.
 *
 * `viaPassthrough` is what makes multiple Xtream accounts possible at once: the proxy's Xtream path
 * holds a single target base (set with proxy.setTarget), so two accounts sharing it would race each
 * other, whereas the /__fetch/ passthrough carries its own destination per request. The primary
 * playlist deliberately keeps the original path — it is the one every existing surface and test
 * exercises, and there is no reason to move it.
 */
function makePlaylistClient(
  profile: XtreamProfile,
  proxyBase: string,
  viaPassthrough: boolean
): IptvClient {
  if (profile.kind === 'm3u') {
    // M3uClient has always routed through the passthrough — a playlist can reference a different
    // host per channel, so there is no single base for setTarget to resolve against.
    return new M3uClient(proxyBase, profile.m3uUrl ?? '', profile.epgUrl ?? null)
  }
  return new XtreamClient(
    profile.server ?? '',
    profile.username ?? '',
    profile.password ?? '',
    viaPassthrough ? proxyBase : null
  )
}

export const useAppStore = create<AppState>((set, get) => ({
  profiles: [],
  activeProfile: null,
  client: null,
  playlists: [],
  selectedPlaylistId: null,
  primaryPlaylistId: null,
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
  vodCatalog: null,
  seriesCatalog: null,

  epgSources: [],
  epgSourceLabels: [],
  epgSourceByStream: {},
  providerGuideAvailable: null,
  epgSourcesStatus: 'idle',
  epgLoadProgress: null,
  epgSourceIssues: {},
  epgSourceMatchStats: [],
  shortEpgByStream: {},
  shortEpgFetchedAt: {},
  channelHealthByStream: {},
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
  showNotLiveChannels: true,
  selectedCustomCategoryId: null,
  customCategoriesOpen: false,

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
  guideOpen: false,
  epgMatchTarget: null,
  channelMatchOpen: false,
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
        // The downloaded event carries only the version — keep the notes the "available" event
        // already brought in, or the prompt would lose its "what's new" between the two states.
        set({
          updateInfo: { version: payload.version, releaseNotes: get().updateInfo?.releaseNotes ?? null },
          updateDownloaded: true,
          updateDownloadPercent: null,
          updateDismissed: false
        })
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
      if (profile.kind !== 'm3u') {
        // Route every request through the local CORS-proxy (see src/main/index.ts) instead of the
        // real server, since Xtream panels don't send CORS headers for browsers. This is the
        // *primary* playlist's path — see makePlaylistClient for why the others differ.
        await window.api.proxy.setTarget(profile.server ?? '')
      }
      const client = makePlaylistClient(profile, proxyBase, false)
      const auth = await client.authenticate()

      // Additional playlists: whatever else is enabled, in the user's saved order (the profile
      // being connected goes first, so it is the primary). One failing account must not take the
      // others down with it — a flaky provider is the whole reason this feature exists — so each
      // is connected independently and its failure is recorded against it.
      const connections: PlaylistConnection[] = [
        { profileId: profile.id, name: profile.name, client, error: null, categories: [] }
      ]
      for (const id of get().settings.enabledPlaylistIds) {
        if (id === profile.id) continue
        const extra = get().profiles.find((candidate) => candidate.id === id)
        if (!extra) continue
        const extraClient = makePlaylistClient(extra, proxyBase, true)
        try {
          await extraClient.authenticate()
          connections.push({ profileId: id, name: extra.name, client: extraClient, error: null, categories: [] })
        } catch (err) {
          connections.push({
            profileId: id,
            name: extra.name,
            client: extraClient,
            error: err instanceof Error ? err.message : 'Failed to connect',
            categories: []
          })
        }
      }

      // Each playlist's own categories, fetched now so the sidebar can group them without the user
      // having to select a playlist first. Failures leave an empty list rather than blocking.
      await Promise.all(
        connections.map(async (connection) => {
          if (connection.error) return
          try {
            const cats = await connection.client.getLiveCategories()
            connection.categories = cats.map((c) => ({ ...c, playlistId: connection.profileId }))
          } catch {
            // Left empty; the sidebar shows the playlist with no categories rather than a crash.
          }
        })
      )
      set({
        client,
        playlists: connections,
        selectedPlaylistId: profile.id,
        primaryPlaylistId: connections[0]?.profileId ?? null,
        status: 'ready',
        singleConnectionAccount: auth.user_info.max_connections === '1',
        // A new connection means a (possibly different) provider's catalog — last profile's
        // cached numeric lookup would otherwise resolve a typed channel number against the
        // wrong account's lineup.
        numericChannelCatalog: null,
        vodCatalog: null,
        seriesCatalog: null,
        // Same wrong-provider story for EPG: stream IDs are only unique within one provider,
        // so cached listings from the previous profile are not just stale but potentially for a
        // completely different channel that happens to share the id.
        shortEpgByStream: {},
        shortEpgFetchedAt: {},
        channelHealthByStream: {},
        epgSources: [],
        epgSourceLabels: [],
        epgSourceByStream: {},
        providerGuideAvailable: null,
        epgSourcesStatus: 'idle',
        epgLoadProgress: null,
        epgSourceIssues: {},
        epgSourceMatchStats: [],
        proxyBase
      })
      shortEpgFailedAt.clear()
      healthProbeSettled.clear()
      healthProbeFailedAt.clear()
      healthProbeInFlight.clear()
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
    healthProbeSettled.clear()
    healthProbeFailedAt.clear()
    healthProbeInFlight.clear()
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
      epgSourceByStream: {},
      providerGuideAvailable: null,
      epgSourcesStatus: 'idle',
      epgLoadProgress: null,
      epgSourceIssues: {},
      epgSourceMatchStats: [],
      shortEpgByStream: {},
      shortEpgFetchedAt: {},
      channelHealthByStream: {},
      proxyBase: null,
      nowPlaying: null,
      channelBarOpen: false,
      unlockedCategoryIds: [],
      numericChannelCatalog: null,
      vodCatalog: null,
      seriesCatalog: null,
      selectedCustomCategoryId: null
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
      selectedCustomCategoryId: null,
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
  selectPlaylist: (profileId) => {
    if (!get().playlists.some((playlist) => playlist.profileId === profileId)) return
    set({ selectedPlaylistId: profileId, selectedCustomCategoryId: null, searchTerm: '' })
    // Show that playlist's whole line-up: its "All" (a null category) is the default entry.
    get().requestCategory(null, profileId)
  },

  setPlaylistEnabled: async (profileId, enabled) => {
    const current = get().settings.enabledPlaylistIds
    const next = enabled
      ? current.includes(profileId)
        ? current
        : [...current, profileId]
      : current.filter((id) => id !== profileId)
    if (next === current) return
    get().updateSettings({ enabledPlaylistIds: next })
    if (next.length === 0) {
      // Hiding every playlist leaves nothing to browse — the login screen is the honest state.
      get().disconnect()
      return
    }
    // Reconnecting is what actually loads a newly-shown playlist's catalogue (and what stops a
    // hidden one being carried), so the toggle goes through the connect flow rather than just
    // filtering what is rendered.
    const active = get().activeProfile?.id
    await get().connect(active && next.includes(active) ? active : next[0])
  },

  requestCategory: (categoryId, playlistId) => {
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
    void get().selectCategory(categoryId, playlistId)
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

  selectCategory: async (categoryId, playlistId) => {
    const { playlists, viewMode } = get()
    // Which account's catalogue this selection browses: the one asked for, else the one the sidebar
    // is showing, else the first. With a single playlist connected this resolves to exactly the
    // client this action used before, so the single-provider path is unchanged.
    const chosen =
      (playlistId ? playlists.find((playlist) => playlist.profileId === playlistId) : undefined) ??
      playlists.find((playlist) => playlist.profileId === get().selectedPlaylistId) ??
      playlists[0] ??
      null
    const client = chosen?.client ?? get().client
    if (!client) return
    set({
      selectedCategoryId: categoryId,
      selectedCustomCategoryId: null,
      ...(playlistId ? { selectedPlaylistId: playlistId } : {})
    })
    try {
      if (viewMode === 'live' || viewMode === 'multiview') {
        const fetched = await client.getLiveStreams(categoryId ?? undefined)
        // Tagged with the playlist they came from, but only when there is more than one: with a
        // single playlist the tag would be noise, and the rows keep the shape they always had.
        const liveStreams =
          chosen && playlists.length > 1
            ? fetched.map((stream) => ({ ...stream, playlistId: chosen.profileId, playlistName: chosen.name }))
            : fetched
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
    const seq = ++epgSourcesLoadSeq
    set({ epgSourcesStatus: 'loading', epgLoadProgress: null })
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
        // The provider's own guide is the one that gets big — 16.3MB gzipped / 107.4MB of XML on
        // this app's own provider, measured 2026-09-22 — so it is parsed in sections, reporting
        // progress, with the event loop getting a turn between them (see parseXmltvProgressive).
        // That is what stops the window freezing while it loads. The size check is a safety net
        // against a pathological document, and sits far above any real guide (MAX_GUIDE_XML_CHARS).
        const fetchStartedAt = Date.now()
        const providerXml = await client.getFullEpgXml()
        const fetchedAt = Date.now()
        if (providerXml.length > MAX_GUIDE_XML_CHARS) {
          throw new Error(
            `guide is ${Math.round(providerXml.length / 1048576)}MB — beyond the ${Math.round(MAX_GUIDE_XML_CHARS / 1048576)}MB safety limit`
          )
        }
        const parsedProvider = await parseXmltvProgressive(providerXml, {
          onProgress: (done, total) => {
            // A newer load owns the status once its token has been issued (see the seq guard).
            if (seq === epgSourcesLoadSeq) set({ epgLoadProgress: { done, total } })
          }
        })
        logGuideTiming(
          `guide load (provider): fetched ${(providerXml.length / 1048576).toFixed(1)}MB of XML in ` +
            `${((fetchedAt - fetchStartedAt) / 1000).toFixed(1)}s, parsed in ${((Date.now() - fetchedAt) / 1000).toFixed(1)}s`
        )
        sources.push(parsedProvider)
        labels.push(PROVIDER_GUIDE_LABEL)
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
        const text = await decodeMaybeGzipBytes(await res.arrayBuffer())
        if (text.length > MAX_GUIDE_XML_CHARS) {
          throw new Error(
            `guide is ${Math.round(text.length / 1048576)}MB — beyond the ${Math.round(MAX_GUIDE_XML_CHARS / 1048576)}MB safety limit`
          )
        }
        const customFetchAt = Date.now()
        const parsed = await parseXmltvProgressive(text, {
          onProgress: (done, total) => {
            if (seq === epgSourcesLoadSeq) set({ epgLoadProgress: { done, total } })
          }
        })
        logGuideTiming(
          `guide load (${url.slice(0, 60)}): ${(text.length / 1048576).toFixed(1)}MB of XML, parsed in ` +
            `${((Date.now() - customFetchAt) / 1000).toFixed(1)}s`
        )
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
    // A newer run superseded this one (a source was added/removed mid-download) — its own
    // completion commits the fresher state; committing here would re-add removed sources.
    if (seq !== epgSourcesLoadSeq) return
    set({
      epgSources: sources,
      epgSourceLabels: labels,
      providerGuideAvailable,
      epgSourcesStatus: 'ready',
      epgSourceIssues: issues,
      epgLoadProgress: null
    })
    get().applyEpgPool()
  },

  applyEpgPool: () => {
    const { epgSources, epgSourceLabels, providerGuideAvailable, epgSourceIssues, liveStreams, shortEpgByStream, shortEpgFetchedAt, settings } = get()
    // First source (in loadEpgSources' priority order) with programmes for a channel wins —
    // the provider's own guide outranks a third party's, and earlier custom URLs outrank later
    // ones.
    const pool = new Map<number, ShortEpgProgram[]>()
    // Provenance for the preview panel: which source won each channel (first in priority order
    // with programmes for it — the same rule that decides the pool entry right below).
    const sourceByStream: Record<number, string> = {}
    // Per-source matching report for Settings — what a source actually did against the
    // currently-loaded channels, including how much of its matching rests on the weaker
    // name join and which channel names found no counterpart at all.
    const stats: EpgSourceMatchStats[] = []
    if (providerGuideAvailable === false) {
      stats.push({ source: PROVIDER_GUIDE_LABEL, available: false, reason: 'blocked or disabled by this provider', loadedChannels: liveStreams.length, matched: 0, byId: 0, byName: 0, byFuzzy: 0, byManual: 0, unmatchedNames: [] })
    }
    epgSources.forEach((source, index) => {
      // Manual mappings are keyed to the custom source's own URL (the provider guide is not
      // manually mappable — see EpgChannelMapping), so look them up by this entry's label.
      const sourceUrl = epgSourceLabels[index]
      // A hidden source is still *loaded* (so switching it back on is instant) but supplies
      // nothing: it contributes no pool entries and reports a row explaining why it matched zero,
      // rather than looking like a source that failed.
      if (settings.hiddenEpgSourceUrls.includes(sourceUrl)) {
        stats.push({
          source: sourceUrl,
          available: true,
          reason: 'hidden — its guide is switched off',
          loadedChannels: liveStreams.length,
          matched: 0,
          byId: 0,
          byName: 0,
          byFuzzy: 0,
          byManual: 0,
          unmatchedNames: []
        })
        return
      }
      const manual = new Map(
        settings.epgChannelMappings.filter((m) => m.sourceUrl === sourceUrl).map((m) => [m.streamId, m.guideChannelId])
      )
      const matches = matchXmltvChannels(liveStreams, source, manual)
      let byId = 0
      let byName = 0
      let byFuzzy = 0
      let byManual = 0
      const unmatchedNames: string[] = []
      for (const stream of liveStreams) {
        const match = matches.get(stream.stream_id)
        const programmes = match ? source.programmesByChannel.get(match.channelId) : undefined
        if (match && programmes?.length) {
          if (match.method === 'id') byId += 1
          else if (match.method === 'manual') byManual += 1
          else if (match.method === 'fuzzy') byFuzzy += 1
          else byName += 1
        } else {
          // Cap the list — against a large category this is diagnostic material, not a roster.
          if (unmatchedNames.length < 30) unmatchedNames.push(stream.name)
        }
      }
      const label = index === 0 && providerGuideAvailable === true ? PROVIDER_GUIDE_LABEL : epgSourceLabels[index] ?? `Source ${index + 1}`
      stats.push({
        source: label,
        available: true,
        reason: null,
        loadedChannels: liveStreams.length,
        matched: byId + byName + byFuzzy + byManual,
        byId,
        byName,
        byFuzzy,
        byManual,
        unmatchedNames
      })
      for (const [streamId, match] of matches) {
        if (pool.has(streamId)) continue
        const programmes = source.programmesByChannel.get(match.channelId)
        if (programmes?.length) {
          pool.set(streamId, xmltvProgrammesToShort(programmes, match.channelId))
          sourceByStream[streamId] = label
        }
      }
    })
    // Sources that failed to load never enter epgSources, so the loop above never sees them —
    // give each one its own row carrying the exact load diagnostic, so the report accounts for
    // every configured source instead of letting a failure look like the source doesn't exist.
    for (const [url, reason] of Object.entries(epgSourceIssues)) {
      stats.push({
        source: url,
        available: false,
        reason,
        loadedChannels: liveStreams.length,
        matched: 0,
        byId: 0,
        byName: 0,
        byFuzzy: 0,
        byManual: 0,
        unmatchedNames: []
      })
    }
    set({ epgSourceMatchStats: stats, epgSourceByStream: sourceByStream })
    if (epgSources.length === 0 || liveStreams.length === 0) return
    if (pool.size === 0) return
    const nextShort = { ...shortEpgByStream }
    let changed = false
    for (const [streamId, programmes] of pool) {
      // The pool only PREFILLS: it yields to any non-empty cached list (the provider's own
      // listings, or an earlier prefill) and loadShortEpg merges provider entries over it later.
      //
      // Guarding on `shortEpgFetchedAt` instead — "a fetch has happened, so leave this channel
      // alone" — was a real bug, found by driving the packaged app against the synthetic provider.
      // The grid fetches per-channel listings as soon as a row renders, which is normally BEFORE a
      // multi-megabyte guide finishes downloading, and for precisely the channels the pool exists
      // for the provider returns nothing, so that fetch caches an EMPTY array. The guide then
      // matched the channel, saw a completed fetch, and skipped it: the match report counted the
      // channel as matched while its row showed "No programme data" indefinitely.
      const existing = nextShort[streamId]
      if (existing === programmes) continue
      // Provider data — a fetch happened AND actually returned listings — is never overwritten.
      // Note the two halves: an empty cached list is NOT provider data, it's the "the provider has
      // nothing for this channel" case the pool exists for, and it must still be filled. And a
      // list with no fetchedAt stamp is a previous pool prefill, which a reprioritisation is
      // allowed to replace (a fetch that returned nothing leaves the pool's own data stamped, so a
      // reprioritisation settles on the next connect instead of churning what's on screen).
      if (shortEpgFetchedAt[streamId] && existing && existing.length > 0) continue
      nextShort[streamId] = programmes
      changed = true
    }
    if (changed) set({ shortEpgByStream: nextShort })
  },

  applySuggestedMappings: async (sourceUrl, threshold) => {
    // The full catalogue is fetched lazily (the mapping editor and My Categories both trigger it),
    // so a bulk apply can be the first thing a user asks for — in which case it used to find no
    // catalogue, plan nothing, and report the misleading "no channel scored X%" rather than doing
    // the work. Load it here instead of depending on which screen was visited first.
    if (!get().numericChannelCatalog) await get().ensureChannelCatalog()
    const { epgSources, epgSourceLabels, numericChannelCatalog, settings } = get()
    const sourceIndex = epgSourceLabels.indexOf(sourceUrl)
    const guide = sourceIndex >= 0 ? epgSources[sourceIndex] : undefined
    const catalog = numericChannelCatalog ?? []
    if (!guide || catalog.length === 0) return { applied: 0, stillUnmatched: 0 }

    const index = buildGuideIndex(guide)
    const manual = new Map(
      settings.epgChannelMappings.filter((m) => m.sourceUrl === sourceUrl).map((m) => [m.streamId, m.guideChannelId])
    )
    const plan = await planBulkSuggestionApplyChunked(catalog, index, manual, threshold)
    if (plan.applied.length > 0) {
      const nameByStreamId = new Map(catalog.map((s) => [s.stream_id, s.name]))
      const appliedStreamIds = new Set(plan.applied.map((a) => a.streamId))
      // Same replace semantics as a single add: an existing mapping for a stream is superseded,
      // and every other source's mappings are left untouched.
      const rest = settings.epgChannelMappings.filter((m) => !(m.sourceUrl === sourceUrl && appliedStreamIds.has(m.streamId)))
      get().updateSettings({
        epgChannelMappings: [
          ...rest,
          ...plan.applied.map((a) => ({
            sourceUrl,
            guideChannelId: a.channelId,
            streamId: a.streamId,
            guideChannelName: index.channels.get(a.channelId)?.displayName,
            streamName: nameByStreamId.get(a.streamId)
          }))
        ]
      })
    }
    // Refresh the pool and the match report so the editor shows the new state immediately.
    get().applyEpgPool()
    return { applied: plan.applied.length, stillUnmatched: plan.belowThreshold }
  },

  applySuggestedMappingsAcrossSources: async (threshold) => {
    // Same lazy-catalogue trap as the per-source action above.
    if (!get().numericChannelCatalog) await get().ensureChannelCatalog()
    const { epgSources, epgSourceLabels, numericChannelCatalog, settings } = get()
    const catalog = numericChannelCatalog ?? []
    const perSource: Array<{ source: string; applied: number }> = []
    if (catalog.length === 0 || epgSources.length === 0) return { applied: 0, perSource }

    const nameByStreamId = new Map(catalog.map((s) => [s.stream_id, s.name]))
    // Channels this run has already given a mapping to. Each source keeps its own mapping list
    // (they're independent — that's what source priority is for), but planning the NEXT source
    // should skip them: the highest-priority source able to place a channel is the one that
    // should, and without this every source would happily map the same channel again.
    const plannedHere = new Map<number, string>()
    const newMappings: EpgChannelMapping[] = []

    for (const [index, label] of epgSourceLabels.entries()) {
      // The provider's own guide isn't manually mappable at all (see EpgChannelMapping) — its ids
      // are what epg_channel_id already refers to, so there is nothing to plan for it.
      if (label === PROVIDER_GUIDE_LABEL) continue
      const guide = epgSources[index]
      if (!guide) continue

      const guideIndex = buildGuideIndex(guide)
      const manual = new Map(
        settings.epgChannelMappings.filter((m) => m.sourceUrl === label).map((m) => [m.streamId, m.guideChannelId])
      )
      for (const [streamId, channelId] of plannedHere) manual.set(streamId, channelId)

      const plan = await planBulkSuggestionApplyChunked(catalog, guideIndex, manual, threshold)
      if (plan.applied.length === 0) continue
      for (const { streamId, channelId } of plan.applied) plannedHere.set(streamId, channelId)
      newMappings.push(
        ...plan.applied.map(({ streamId, channelId }) => ({
          sourceUrl: label,
          guideChannelId: channelId,
          streamId,
          guideChannelName: guideIndex.channels.get(channelId)?.displayName,
          streamName: nameByStreamId.get(streamId)
        }))
      )
      perSource.push({ source: label, applied: plan.applied.length })
    }

    if (newMappings.length > 0) {
      const appliedIds = new Set(newMappings.map((m) => m.streamId))
      get().updateSettings({
        epgChannelMappings: [
          ...settings.epgChannelMappings.filter((m) => !appliedIds.has(m.streamId)),
          ...newMappings
        ]
      })
    }
    get().applyEpgPool()
    return { applied: newMappings.length, perSource }
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

  reorderCustomEpgUrls: (fromIndex, toIndex) => {
    const current = get().settings.customEpgUrls
    const next = moveItem(current, fromIndex, toIndex)
    if (next === current) return
    get().updateSettings({ customEpgUrls: next })
    // Priority changed, so the pool's "first source with programmes wins" rule can land on a
    // different source for any overlapping channel — reload rather than trying to patch.
    if (get().client) void get().loadEpgSources()
  },

  removeCustomEpgUrl: (url) => {
    const current = get().settings.customEpgUrls
    if (current.includes(url)) {
      get().updateSettings({ customEpgUrls: current.filter((u) => u !== url) })
    }
    // Prune the source out of the in-memory pool immediately, even when it wasn't in settings
    // anymore — the Settings list renders the union of persisted and live sources (see
    // unionEpgSourceUrls), so leaving it in the pool would keep it visible-but-undeletable.
    // Custom sources are labeled by their URL, so this lookup is exact.
    const idx = get().epgSourceLabels.indexOf(url)
    if (idx >= 0) {
      set({
        epgSources: get().epgSources.filter((_, i) => i !== idx),
        epgSourceLabels: get().epgSourceLabels.filter((_, i) => i !== idx)
      })
    }
    const issues = { ...get().epgSourceIssues }
    if (url in issues) {
      delete issues[url]
      set({ epgSourceIssues: issues })
    }
    get().applyEpgPool()
    // Reload the remaining sources so pool state matches settings exactly; the run-token guard
    // makes any in-flight older load (started before this removal) harmless.
    if (get().client) void get().loadEpgSources()
  },

  // One stream maps to one guide channel per source — re-adding replaces that stream's
  // previous mapping rather than stacking a duplicate. Removing a source (removeCustomEpgUrl)
  // leaves its mappings in settings harmlessly: they only ever join against a guide parsed
  // from that URL, so an orphaned mapping can't mis-fire — but pruning it here would need a
  // second updateSettings round-trip mid-edit for no user-visible gain.
  closeChannelMatch: () => set({ epgMatchTarget: null, channelMatchOpen: false }),

  setEpgSourceHidden: (url, hidden) => {
    const current = get().settings.hiddenEpgSourceUrls
    const next = hidden
      ? current.includes(url) ? current : [...current, url]
      : current.filter((entry) => entry !== url)
    if (next === current) return
    get().updateSettings({ hiddenEpgSourceUrls: next })
    // Re-run the pool straight away: the point of hiding a source is to stop it supplying
    // listings, and waiting for the next reload would leave the grid showing its programmes.
    get().applyEpgPool()
  },

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

  ensureCustomCategoryCatalog: async (kind) => {
    const { client } = get()
    if (!client) return
    try {
      if (kind === 'movie') {
        if (!get().vodCatalog) set({ vodCatalog: await client.getVodStreams() })
      } else if (kind === 'series') {
        if (!get().seriesCatalog) set({ seriesCatalog: await client.getSeries() })
      } else {
        await get().ensureChannelCatalog()
      }
    } catch (err) {
      // Same reasoning as ensureChannelCatalog's own catch: a custom category is a convenience
      // layer over the provider's catalog, and a transient fetch failure shouldn't become an
      // error banner — the manager reports what it can show instead.
      console.error('[store] failed to load the catalog for a custom category:', err)
    }
  },

  openCustomCategories: () => set({ customCategoriesOpen: true }),
  closeCustomCategories: () => set({ customCategoriesOpen: false }),

  createCustomCategory: (name, kind = 'live') => {
    const category: CustomCategory = { id: crypto.randomUUID(), name: name.trim() || 'New category', kind, streamIds: [] }
    get().updateSettings({ customCategories: [...get().settings.customCategories, category] })
    return category.id
  },

  renameCustomCategory: (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    get().updateSettings({
      customCategories: get().settings.customCategories.map((c) => (c.id === id ? { ...c, name: trimmed } : c))
    })
  },

  deleteCustomCategory: (id) => {
    get().updateSettings({ customCategories: get().settings.customCategories.filter((c) => c.id !== id) })
    // Deleting the SELECTED category would otherwise leave the grid showing channels sourced from
    // a category that no longer exists — fall back to All, which is what a user deleting the thing
    // they're looking at would expect to see next.
    if (get().selectedCustomCategoryId === id) {
      set({ selectedCustomCategoryId: null })
      get().requestCategory(null)
    }
  },

  addChannelsToCustomCategory: (id, streamIds) => {
    get().updateSettings({
      customCategories: get().settings.customCategories.map((c) =>
        c.id === id ? { ...c, streamIds: addStreamIds(c.streamIds, streamIds) } : c
      )
    })
    get().refreshCustomCategoryStreams(id)
  },

  removeChannelFromCustomCategory: (id, streamId) => {
    get().updateSettings({
      customCategories: get().settings.customCategories.map((c) =>
        c.id === id ? { ...c, streamIds: removeStreamId(c.streamIds, streamId) } : c
      )
    })
    get().refreshCustomCategoryStreams(id)
  },

  reorderCustomCategories: (fromIndex, toIndex) => {
    const current = get().settings.customCategories
    const next = moveItem(current, fromIndex, toIndex)
    // moveItem returns the same array for a no-op drag (dropped where it started) — skip the
    // settings write (and its disk save) in that case.
    if (next === current) return
    get().updateSettings({ customCategories: next })
  },

  reorderCustomCategoryChannels: (id, fromIndex, toIndex) => {
    get().updateSettings({
      customCategories: get().settings.customCategories.map((c) =>
        c.id === id ? { ...c, streamIds: moveItem(c.streamIds, fromIndex, toIndex) } : c
      )
    })
    get().refreshCustomCategoryStreams(id)
  },

  // Rebuilds liveStreams for a custom category straight from the cached full catalog — used both
  // by selection and by every edit, so adding/removing/reordering a channel updates the grid
  // immediately without a provider round-trip. No-ops when the edited category isn't the one on
  // screen (nothing to update) or when the catalog hasn't been loaded yet (selection loads it).
  refreshCustomCategoryStreams: (id) => {
    if (get().selectedCustomCategoryId !== id) return
    const category = get().settings.customCategories.find((c) => c.id === id)
    if (!category) return
    // Each kind rebuilds the list its own surface renders — the grid's liveStreams, or the poster
    // grid's vodStreams/series — from that kind's cached catalog.
    if (kindOf(category) === 'movie') {
      const catalog = get().vodCatalog
      if (!catalog) return
      const byId = new Map(catalog.map((s) => [s.stream_id, s]))
      set({ vodStreams: category.streamIds.map((streamId) => byId.get(streamId)).filter((s): s is VodStream => !!s) })
    } else if (kindOf(category) === 'series') {
      const catalog = get().seriesCatalog
      if (!catalog) return
      const byId = new Map(catalog.map((s) => [s.series_id, s]))
      set({ series: category.streamIds.map((seriesId) => byId.get(seriesId)).filter((s): s is SeriesItem => !!s) })
    } else {
      const catalog = get().numericChannelCatalog
      if (!catalog) return
      const byId = new Map(catalog.map((s) => [s.stream_id, s]))
      const streams = category.streamIds.map((streamId) => byId.get(streamId)).filter((s): s is LiveStream => !!s)
      set({ liveStreams: streams })
      get().applyEpgPool()
    }
  },

  requestCustomCategory: (id) => {
    // Custom categories are the user's own groupings — no parental lock applies (the lock exists
    // to gate provider categories), so this goes straight to loading rather than through
    // requestCategory's PIN check.
    const requested = get().settings.customCategories.find((c) => c.id === id)
    const kind = kindOf(requested)
    set({ selectedCustomCategoryId: id, selectedCategoryId: null, searchTerm: '', previewChannel: null })
    void (async () => {
      await get().ensureCustomCategoryCatalog(kind)
      const category = get().settings.customCategories.find((c) => c.id === id)
      // The user may have switched elsewhere while the catalog was loading — committing now would
      // overwrite whatever they moved on to.
      if (!category || get().selectedCustomCategoryId !== id) return
      // Ids that don't resolve are skipped, not dropped from the stored order — see CustomCategory.
      if (kind === 'movie') {
        const catalog = get().vodCatalog
        if (!catalog) {
          set({ error: 'Could not load your movie list to open that category' })
          return
        }
        const byId = new Map(catalog.map((s) => [s.stream_id, s]))
        set({ vodStreams: category.streamIds.map((streamId) => byId.get(streamId)).filter((s): s is VodStream => !!s) })
        return
      }
      if (kind === 'series') {
        const catalog = get().seriesCatalog
        if (!catalog) {
          set({ error: 'Could not load your series list to open that category' })
          return
        }
        const byId = new Map(catalog.map((s) => [s.series_id, s]))
        set({ series: category.streamIds.map((seriesId) => byId.get(seriesId)).filter((s): s is SeriesItem => !!s) })
        return
      }
      const catalog = get().numericChannelCatalog
      if (!catalog) {
        set({ error: 'Could not load your channel list to open that category' })
        return
      }
      const byId = new Map(catalog.map((s) => [s.stream_id, s]))
      const streams = category.streamIds.map((streamId) => byId.get(streamId)).filter((s): s is LiveStream => !!s)
      set({ liveStreams: streams })
      get().applyEpgPool()
      if (streams.length > 0) get().openChannelPreview(streams[0])
    })()
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

  probeChannelHealth: (streamId) => {
    const { client } = get()
    if (!client) return Promise.resolve()
    if (healthProbeSettled.has(streamId) || healthProbeInFlight.has(streamId)) return Promise.resolve()
    const failedAt = healthProbeFailedAt.get(streamId) ?? 0
    if (Date.now() - failedAt < HEALTH_PROBE_FAILURE_COOLDOWN_MS) return Promise.resolve()
    let url: string
    try {
      url = client.getStreamUrl('live', streamId, 'm3u8')
    } catch {
      // A channel id this client can't resolve (an M3U playlist that changed underneath us,
      // say) — there is nothing to probe, and it is not this channel's fault.
      return Promise.resolve()
    }
    // Only ever fetch something that can be judged cheaply: an HLS media playlist. For an M3U
    // profile this URL is the channel's own address, which is very often a raw .ts stream —
    // pulling that would mean downloading real video just to glance at its first bytes. Anything
    // not ending in .m3u8 is therefore left unjudged on purpose. (The same test Player.tsx and
    // useHlsAttach.ts use to decide what hls.js can play at all.)
    if (!url.endsWith('.m3u8')) return Promise.resolve()
    healthProbeInFlight.add(streamId)
    return new Promise((resolve) => {
      healthProbeQueue.push(async () => {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS)
          let analysis: MediaPlaylistAnalysis | null = null
          try {
            const res = await fetch(url, { signal: controller.signal })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            analysis = analyzeMediaPlaylist(await res.text())
          } finally {
            clearTimeout(timer)
          }
          healthProbeFailedAt.delete(streamId)
          healthProbeSettled.add(streamId)
          set({
            channelHealthByStream: {
              ...get().channelHealthByStream,
              [streamId]: {
                health: classifyChannelHealth(analysis),
                // A master playlist's own summed durations say nothing about the variants it
                // hands off to, so only a media playlist's length is worth keeping.
                durationSeconds: analysis && !analysis.isMaster ? analysis.durationSeconds : null,
                checkedAt: Date.now()
              }
            }
          })
        } catch {
          // Transport-level failure — no verdict at all, just back off before trying again (see
          // HEALTH_PROBE_FAILURE_COOLDOWN_MS). Recording "unavailable" here would be a lie the
          // user would act on.
          healthProbeFailedAt.set(streamId, Date.now())
        } finally {
          healthProbeInFlight.delete(streamId)
          activeHealthProbes--
          resolve()
          runNextHealthProbe()
        }
      })
      runNextHealthProbe()
    })
  },

  play: (kind, streamId, name, extension, icon = '', tvArchive = 0, playlistId) => {
    const { client, playlists, recentlyWatched } = get()
    // With more than one playlist connected the URL has to come from the account this channel
    // belongs to: stream ids are unique within a playlist, not across them, so using "the" client
    // would happily play a different channel that happens to share the id.
    const source = playlistId ? (playlists.find((playlist) => playlist.profileId === playlistId)?.client ?? client) : client
    if (!source) return
    set({
      nowPlaying: {
        kind,
        streamId,
        playbackPlaylistId: playlistId ?? null,
        name,
        extension,
        tvArchive,
        icon,
        url: source.getStreamUrl(kind, streamId, extension)
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

  toggleHiddenLiveChannel: (streamId, playlistId) => {
    const { settings, primaryPlaylistId } = get()
    // Keyed per playlist (see lib/channelIdentity): hiding provider A's channel 42 must not hide
    // provider B's 42, which is an unrelated channel that happens to share the number.
    const key = channelKey(playlistId, streamId, primaryPlaylistId)
    const hidden = settings.hiddenChannelKeys
    const hiddenChannelKeys = hidden.includes(key) ? hidden.filter((entry) => entry !== key) : [...hidden, key]
    get().updateSettings({ hiddenChannelKeys })
  },

  setShowHiddenLiveChannels: (show) => set({ showHiddenLiveChannels: show }),

  isChannelHidden: (playlistId, streamId) => {
    const { settings, primaryPlaylistId } = get()
    return settings.hiddenChannelKeys.includes(channelKey(playlistId, streamId, primaryPlaylistId))
  },

  setShowNotLiveChannels: (show) => set({ showNotLiveChannels: show }),

  rememberLiveAudioFix: (streamId, audioIndex, url, playlistId) => {
    const key = channelKey(playlistId, streamId, get().primaryPlaylistId)
    const liveAudioFixes = { ...get().settings.liveAudioFixes, [key]: { audioIndex, url } }
    get().updateSettings({ liveAudioFixes })
  },

  forgetLiveAudioFix: (streamId, playlistId) => {
    const doomed = channelKeyCandidates(playlistId, streamId, get().primaryPlaylistId)
    const current = get().settings.liveAudioFixes
    if (!doomed.some((key) => key in current)) return
    const liveAudioFixes = { ...current }
    for (const key of doomed) delete liveAudioFixes[key]
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

  openSettings: () => set({ settingsOpen: true, guideOpen: false }),
  closeSettings: () => set({ settingsOpen: false }),

  openGuide: () => set({ guideOpen: true, settingsOpen: false, epgMatchTarget: null, channelMatchOpen: false }),
  closeGuide: () => set({ guideOpen: false }),

  openEpgMatch: (streamId, streamName) =>
    set({ epgMatchTarget: { streamId, streamName }, channelMatchOpen: true, guideOpen: false, settingsOpen: false }),

  clearEpgMatchTarget: () => set({ epgMatchTarget: null, channelMatchOpen: false }),

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
      // Every connected playlist's server, so the tunnel covers all of them — a second playlist left
      // outside the tunnel would be a silent leak (see startVpn in the main process).
      const servers = get()
        .settings.enabledPlaylistIds.map((id) => get().profiles.find((candidate) => candidate.id === id))
        .filter(
          (candidate): candidate is XtreamProfile => !!candidate && candidate.kind !== 'm3u' && !!candidate.server
        )
        .map((candidate) => candidate.server as string)
      await window.api.vpn.connect(
        profile.configPath,
        profile.username,
        profile.password,
        servers.length > 0 ? servers : undefined
      )
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

  reconnectVpnTunnel: async () => {
    const { settings, vpnStatus } = get()
    const targetId = settings.activeVpnProfileId ?? settings.lastVpnProfileId ?? settings.vpnProfiles[0]?.id
    if (!targetId) return
    // Tear the current tunnel down first: the main process's startVpn() deliberately no-ops
    // while a tunnel is connecting/connected, so re-activating the same profile without this
    // would do nothing at all — and there is no way to add a route to a *running* tunnel
    // without root, which this app never does silently. Bringing the tunnel up again is a
    // normal activation: same code path, same elevation prompt an Activate click always makes.
    if (vpnStatus === 'connected' || vpnStatus === 'connecting') {
      await get().deactivateVpnProfile()
    }
    await get().activateVpnProfile(targetId)
    // The routes were just rebuilt against the current DNS answer; if the answer rotates
    // again the probe warns again fresh (the main process's own dedupe resets on status change).
    get().dismissVpnStreamRouteWarning()
  },

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
