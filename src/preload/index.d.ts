import type { ElectronAPI } from '@electron-toolkit/preload'

interface AppInfoAPI {
  getInfo: () => Promise<{ name: string; version: string; buildNumber: number; platform: string }>
  openExternal: (url: string) => Promise<void>
  logGuideTiming: (message: string) => Promise<void>
  onOpenAbout: (callback: () => void) => () => void
  isFullScreen: () => Promise<boolean>
  getGpuSummary: () => Promise<{ videoDecode: string | null; devices: string[] } | null>
  exitFullScreen: () => Promise<void>
  onFullScreenChanged: (callback: (isFullScreen: boolean) => void) => () => void
}

interface StoreAPI {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
}

// The guide cache (see the main process's guideCache.ts): raw XML per source key plus a fetchedAt
// stamp. `get` resolves null for anything that can't be trusted — absent, half-written, or
// corrupt — so callers fall back to fetching.
interface CacheAPI {
  get: (key: string) => Promise<{ xml: string; fetchedAt: number } | null>
  set: (key: string, xml: string) => Promise<{ fetchedAt: number }>
  age: (key: string) => Promise<number | null>
}

interface NotificationsAPI {
  show: (title: string, body: string) => Promise<void>
}

interface ProxyAPI {
  getBaseUrl: () => Promise<string>
  setTarget: (baseUrl: string, backupUrl?: string) => Promise<void>
}

interface BackupAPI {
  export: () => Promise<string | null>
  import: () => Promise<{ imported: boolean }>
}

interface SubtitleTrackInfo {
  index: number
  language: string | null
  supported: boolean
}

interface AudioTrackInfo {
  index: number
  language: string | null
  codec: string
  channelLayout: string
}

interface TranscodeAPI {
  start: (
    sourceUrl: string,
    isVod: boolean,
    sessionId: string,
    subtitleStreamIndex?: number,
    audioStreamIndex?: number,
    // The viewer's quality ceiling (v0.75.0 port): caps the re-encode tier's height when this
    // client can only play a channel through it. Null/absent = Source. Only ever honored by
    // the video re-encode path — a copy session cannot reshape.
    maxHeight?: number
  ) => Promise<{ sessionId: string; url: string; subtitleTracks: SubtitleTrackInfo[] }>
  stop: (sessionId: string) => Promise<void>
  // One-shot: tells the main process whether this client can decode HEVC from fragmented MP4,
  // which decides whether an HEVC live remux copies (hvc1-tagged) or re-encodes (see
  // transcodeService's canDecodeHevc).
  setHevcSupport: (canDecode: boolean) => Promise<void>
  probeTracks: (sourceUrl: string) => Promise<{ audioTracks: AudioTrackInfo[]; subtitleTracks: SubtitleTrackInfo[] }>
}

interface KeepAwakeAPI {
  setEnabled: (enabled: boolean) => Promise<boolean>
}

interface SafeStorageAPI {
  isAvailable: () => Promise<boolean>
  encrypt: (plainText: string) => Promise<string>
  decrypt: (base64: string) => Promise<string>
}

interface VpnStatusPayload {
  status: string
  errorMessage: string | null
}

interface VpnAPI {
  selectConfigFile: () => Promise<string | null>
  connect: (
    configPath: string,
    username: string | null,
    password: string | null,
    serverUrls?: string[]
  ) => Promise<void>
  disconnect: () => Promise<void>
  removeImportedConfig: (configPath: string) => Promise<void>
  getStatus: () => Promise<VpnStatusPayload>
  openLog: () => Promise<{ ok: boolean; message?: string }>
  onStatusChange: (callback: (status: VpnStatusPayload) => void) => () => void
  onStreamRouteWarning: (callback: (payload: { message: string }) => void) => () => void
}

interface UpdaterAPI {
  check: () => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
  onAvailable: (callback: (payload: { version: string; releaseNotes: string | null }) => void) => () => void
  onProgress: (callback: (payload: { percent: number }) => void) => () => void
  onDownloaded: (callback: (payload: { version: string }) => void) => () => void
  onError: (callback: (payload: { message: string }) => void) => () => void
}

// Sports-tab fixture data from api-football.com, proxied through main so the key never needs a
// CORS-capable direct renderer call and the request target stays pinned (see the main handler).
interface ApiFootballAPI {
  fetch: (path: string, key: string) => Promise<unknown>
}

// The sibling sport feeds on api-football.com (one host per sport; see lib/api-sports.ts for the
// renderer-side list). Same pinned-host discipline, with the sport id selecting the host from
// main's own allowlist.
interface ApiSportsAPI {
  fetch: (sport: string, path: string, key: string) => Promise<unknown>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      app: AppInfoAPI
      store: StoreAPI
      cache: CacheAPI
      notifications: NotificationsAPI
      backup: BackupAPI
      proxy: ProxyAPI
      transcode: TranscodeAPI
      keepAwake: KeepAwakeAPI
      safeStorage: SafeStorageAPI
      vpn: VpnAPI
      updater: UpdaterAPI
      apiFootball: ApiFootballAPI
      apiSports: ApiSportsAPI
    }
  }
}
