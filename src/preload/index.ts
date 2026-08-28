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
    start: (sourceUrl: string) =>
      ipcRenderer.invoke('transcode:start', sourceUrl) as Promise<{ sessionId: string; url: string }>,
    stop: (sessionId: string) => ipcRenderer.invoke('transcode:stop', sessionId) as Promise<void>
  },
  safeStorage: {
    isAvailable: () => ipcRenderer.invoke('safeStorage:isAvailable') as Promise<boolean>,
    encrypt: (plainText: string) => ipcRenderer.invoke('safeStorage:encrypt', plainText) as Promise<string>,
    decrypt: (base64: string) => ipcRenderer.invoke('safeStorage:decrypt', base64) as Promise<string>
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
