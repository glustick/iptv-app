import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  app: {
    getInfo: () =>
      ipcRenderer.invoke('app:info') as Promise<{ name: string; version: string; buildNumber: number }>,
    onOpenAbout: (callback: () => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:open-about', listener)
      return () => ipcRenderer.removeListener('menu:open-about', listener)
    }
  },
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('store:delete', key)
  },
  proxy: {
    getBaseUrl: () => ipcRenderer.invoke('proxy:getBaseUrl') as Promise<string>,
    setTarget: (baseUrl: string) => ipcRenderer.invoke('proxy:setTarget', baseUrl) as Promise<void>
  },
  transcode: {
    start: (
      sourceUrl: string,
      isVod: boolean,
      sessionId: string,
      subtitleStreamIndex?: number,
      audioStreamIndex?: number
    ) =>
      ipcRenderer.invoke(
        'transcode:start',
        sourceUrl,
        isVod,
        sessionId,
        subtitleStreamIndex,
        audioStreamIndex
      ) as Promise<{
        sessionId: string
        url: string
        subtitleTracks: { index: number; language: string | null; supported: boolean }[]
      }>,
    stop: (sessionId: string) => ipcRenderer.invoke('transcode:stop', sessionId) as Promise<void>,
    probeTracks: (sourceUrl: string) =>
      ipcRenderer.invoke('transcode:probeTracks', sourceUrl) as Promise<{
        audioTracks: { index: number; language: string | null; codec: string; channelLayout: string }[]
        subtitleTracks: { index: number; language: string | null; supported: boolean }[]
      }>
  },
  safeStorage: {
    isAvailable: () => ipcRenderer.invoke('safeStorage:isAvailable') as Promise<boolean>,
    encrypt: (plainText: string) => ipcRenderer.invoke('safeStorage:encrypt', plainText) as Promise<string>,
    decrypt: (base64: string) => ipcRenderer.invoke('safeStorage:decrypt', base64) as Promise<string>
  },
  vpn: {
    selectConfigFile: () => ipcRenderer.invoke('vpn:selectConfigFile') as Promise<string | null>,
    connect: (configPath: string, username: string | null, password: string | null) =>
      ipcRenderer.invoke('vpn:connect', configPath, username, password) as Promise<void>,
    disconnect: () => ipcRenderer.invoke('vpn:disconnect') as Promise<void>,
    removeImportedConfig: (configPath: string) =>
      ipcRenderer.invoke('vpn:removeImportedConfig', configPath) as Promise<void>,
    getStatus: () =>
      ipcRenderer.invoke('vpn:getStatus') as Promise<{ status: string; errorMessage: string | null }>,
    openLog: () => ipcRenderer.invoke('vpn:openLog') as Promise<{ ok: boolean; message?: string }>,
    onStatusChange: (callback: (status: { status: string; errorMessage: string | null }) => void) => {
      const listener = (_event: unknown, status: { status: string; errorMessage: string | null }): void =>
        callback(status)
      ipcRenderer.on('vpn:status-changed', listener)
      return () => ipcRenderer.removeListener('vpn:status-changed', listener)
    },
    onStreamRouteWarning: (callback: (payload: { message: string }) => void) => {
      const listener = (_event: unknown, payload: { message: string }): void => callback(payload)
      ipcRenderer.on('vpn:stream-route-warning', listener)
      return () => ipcRenderer.removeListener('vpn:stream-route-warning', listener)
    }
  },
  updater: {
    check: () => ipcRenderer.invoke('update:check') as Promise<void>,
    download: () => ipcRenderer.invoke('update:download') as Promise<void>,
    // Tears the app down to install — nothing meaningful to await after this resolves.
    install: () => ipcRenderer.invoke('update:install') as Promise<void>,
    onAvailable: (callback: (payload: { version: string }) => void) => {
      const listener = (_event: unknown, payload: { version: string }): void => callback(payload)
      ipcRenderer.on('update:available', listener)
      return () => ipcRenderer.removeListener('update:available', listener)
    },
    onProgress: (callback: (payload: { percent: number }) => void) => {
      const listener = (_event: unknown, payload: { percent: number }): void => callback(payload)
      ipcRenderer.on('update:progress', listener)
      return () => ipcRenderer.removeListener('update:progress', listener)
    },
    onDownloaded: (callback: (payload: { version: string }) => void) => {
      const listener = (_event: unknown, payload: { version: string }): void => callback(payload)
      ipcRenderer.on('update:downloaded', listener)
      return () => ipcRenderer.removeListener('update:downloaded', listener)
    },
    onError: (callback: (payload: { message: string }) => void) => {
      const listener = (_event: unknown, payload: { message: string }): void => callback(payload)
      ipcRenderer.on('update:error', listener)
      return () => ipcRenderer.removeListener('update:error', listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
