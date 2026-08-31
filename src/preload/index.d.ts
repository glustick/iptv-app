import type { ElectronAPI } from '@electron-toolkit/preload'

interface AppInfoAPI {
  getInfo: () => Promise<{ name: string; version: string; buildNumber: number }>
  onOpenAbout: (callback: () => void) => () => void
}

interface StoreAPI {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
}

interface ProxyAPI {
  getBaseUrl: () => Promise<string>
  setTarget: (baseUrl: string) => Promise<void>
}

interface SubtitleTrackInfo {
  index: number
  language: string | null
  supported: boolean
}

interface TranscodeAPI {
  start: (
    sourceUrl: string,
    isVod: boolean,
    sessionId: string,
    subtitleStreamIndex?: number
  ) => Promise<{ sessionId: string; url: string; subtitleTracks: SubtitleTrackInfo[] }>
  stop: (sessionId: string) => Promise<void>
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
  connect: (configPath: string, username: string | null, password: string | null) => Promise<void>
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
  onAvailable: (callback: (payload: { version: string }) => void) => () => void
  onProgress: (callback: (payload: { percent: number }) => void) => () => void
  onDownloaded: (callback: (payload: { version: string }) => void) => () => void
  onError: (callback: (payload: { message: string }) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      app: AppInfoAPI
      store: StoreAPI
      proxy: ProxyAPI
      transcode: TranscodeAPI
      safeStorage: SafeStorageAPI
      vpn: VpnAPI
      updater: UpdaterAPI
    }
  }
}
