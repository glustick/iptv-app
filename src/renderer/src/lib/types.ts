export interface XtreamProfile {
  id: string
  name: string
  server: string
  username: string
  password: string
}

export interface XtreamUserInfo {
  auth?: number
  username: string
  password: string
  status: string
  exp_date: string | null
  is_trial: string
  active_cons: string
  created_at: string
  max_connections: string
}

export interface XtreamServerInfo {
  url: string
  port: string
  https_port: string
  server_protocol: string
  timezone: string
}

export interface XtreamAuthResponse {
  user_info: XtreamUserInfo
  server_info: XtreamServerInfo
}

export interface Category {
  category_id: string
  category_name: string
  parent_id: number
}

export interface LiveStream {
  num: number
  name: string
  stream_type: string
  stream_id: number
  stream_icon: string
  epg_channel_id: string | null
  added: string
  category_id: string
  custom_sid: string | null
  tv_archive: number
  direct_source: string
  tv_archive_duration: number
}

export interface VodStream {
  num: number
  name: string
  stream_type: string
  stream_id: number
  stream_icon: string
  rating: string
  rating_5based: number
  added: string
  category_id: string
  container_extension: string
}

export interface SeriesItem {
  num: number
  name: string
  series_id: number
  cover: string
  plot: string
  cast: string
  director: string
  genre: string
  releaseDate: string
  rating: string
  category_id: string
}

export interface SeriesEpisode {
  id: string
  episode_num: number
  title: string
  container_extension: string
  season: number
}

export interface SeriesInfo {
  seasons: Array<{ season_number: number; name: string; cover: string }>
  episodes: Record<string, SeriesEpisode[]>
}

export interface ShortEpgProgram {
  id: string
  epg_id: string
  title: string
  lang: string
  start: string
  end: string
  description: string
  channel_id: string
  start_timestamp: string
  stop_timestamp: string
}

export type MediaKind = 'live' | 'movie' | 'series'

// Favorites keep the original rich object per kind, since clicking a favorited item
// should behave exactly like clicking it from its normal list (open the live preview,
// play the movie, or open the series modal) — not just replay a flat stream URL.
export type FavoriteEntry =
  | { kind: 'live'; stream: LiveStream }
  | { kind: 'movie'; stream: VodStream }
  | { kind: 'series'; item: SeriesItem }

export function favoriteKey(entry: FavoriteEntry): string {
  const id = entry.kind === 'series' ? entry.item.series_id : entry.stream.stream_id
  return `${entry.kind}:${id}`
}

// Recently-watched tracks whatever was actually handed to play() — a flat, directly
// replayable reference (for series this is the episode that was played, not the series).
export interface RecentlyWatchedEntry {
  kind: MediaKind
  streamId: number
  name: string
  icon: string
  extension: string
  // Only meaningful for kind === 'live' — see NowPlaying.tvArchive for why this is carried
  // through rather than looked up again later.
  tvArchive: number
  watchedAt: number
}

export interface EpisodeProgress {
  positionSeconds: number
  durationSeconds: number
  updatedAt: number
}

export type BufferProfile = 'smooth' | 'lowLatency'
export type ClockFormat = '12h' | '24h'
export type EpgRowDensity = 'comfortable' | 'compact'

// A saved OpenVPN configuration — a user can save more than one (different providers, or
// different servers from the same provider), but only one can ever be the *active* tunnel at a
// time (see AppSettings.activeVpnProfileId), since this app only ever spawns a single openvpn
// process. username/password are optional since not every .ovpn file needs them (some rely on
// cert-only auth) — encrypted the same way as the parental PIN, see lib/storage.ts.
export interface VpnProfile {
  id: string
  name: string
  configPath: string
  configName: string
  username: string | null
  password: string | null
}

export interface AppSettings {
  bufferProfile: BufferProfile
  clockFormat: ClockFormat
  parentalPin: string | null
  lockedCategoryIds: string[]
  sidebarWidth: number
  detailPanelWidth: number
  epgRowDensity: EpgRowDensity
  // Width of the EPG grid's channel-name column (both the main docked guide and the fullscreen
  // channel-swap overlay share this — same EpgGrid component, same setting) — drag-resizable so
  // a long channel name isn't clipped by ellipsis at the default width.
  epgChannelColumnWidth: number
  playerVolume: number
  playerMuted: boolean
  vpnProfiles: VpnProfile[]
  activeVpnProfileId: string | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  bufferProfile: 'smooth',
  clockFormat: '12h',
  parentalPin: null,
  lockedCategoryIds: [],
  sidebarWidth: 220,
  detailPanelWidth: 560,
  epgRowDensity: 'comfortable',
  epgChannelColumnWidth: 128,
  playerVolume: 1,
  playerMuted: false,
  vpnProfiles: [],
  activeVpnProfileId: null
}

export type VpnStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface VpnState {
  status: VpnStatus
  errorMessage: string | null
}
