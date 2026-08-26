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

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      store: StoreAPI
      proxy: ProxyAPI
    }
  }
}
