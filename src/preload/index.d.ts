import type { ElectronAPI } from '@electron-toolkit/preload'

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

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      store: StoreAPI
      proxy: ProxyAPI
      transcode: TranscodeAPI
    }
  }
}
