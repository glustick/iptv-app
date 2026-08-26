import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { createServer } from 'http'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import { URL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import Store from 'electron-store'

const store = new Store()

/**
 * Xtream Codes panels are built for native players (VLC, set-top boxes) and never send
 * CORS headers, so Chromium blocks every player_api/EPG/stream request as cross-origin.
 * This proxy re-issues each request from the main process (not subject to browser CORS)
 * and stamps the response with permissive CORS headers before handing it to the renderer.
 * `proxyTargetBase` is swapped whenever the user connects to a (possibly different) profile.
 */
let proxyTargetBase: string | null = null

function startLocalProxy(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': '*',
          'access-control-allow-headers': '*'
        })
        res.end()
        return
      }

      if (!proxyTargetBase) {
        res.writeHead(502)
        res.end('No upstream Xtream server configured')
        return
      }

      const target = new URL(req.url ?? '/', proxyTargetBase)
      const isHttps = target.protocol === 'https:'
      const requestFn = isHttps ? httpsRequest : httpRequest
      const { host: _clientHost, ...forwardedHeaders } = req.headers

      const upstreamReq = requestFn(
        {
          hostname: target.hostname,
          port: target.port || (isHttps ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: req.method,
          headers: { ...forwardedHeaders, host: target.host }
        },
        (upstreamRes) => {
          const headers = { ...upstreamRes.headers }
          headers['access-control-allow-origin'] = '*'
          headers['access-control-allow-headers'] = '*'
          delete headers['content-security-policy']
          res.writeHead(upstreamRes.statusCode ?? 200, headers)
          upstreamRes.pipe(res)
        }
      )
      upstreamReq.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end('Upstream request failed')
      })
      req.pipe(upstreamReq)
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.iptv.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('store:get', (_event, key: string) => store.get(key))
  ipcMain.handle('store:set', (_event, key: string, value: unknown) => store.set(key, value))
  ipcMain.handle('store:delete', (_event, key: string) => store.delete(key))

  const proxyPort = await startLocalProxy()
  ipcMain.handle('proxy:getBaseUrl', () => `http://127.0.0.1:${proxyPort}`)
  ipcMain.handle('proxy:setTarget', (_event, baseUrl: string) => {
    proxyTargetBase = baseUrl
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
