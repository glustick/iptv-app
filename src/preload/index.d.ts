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

interface TranscodeAPI {
  start: (sourceUrl: string) => Promise<{ sessionId: string; url: string }>
  stop: (sessionId: string) => Promise<void>
}

interface SafeStorageAPI {
  isAvailable: () => Promise<boolean>
  encrypt: (plainText: string) => Promise<string>
  decrypt: (base64: string) => Promise<string>
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
    }
  }
}
