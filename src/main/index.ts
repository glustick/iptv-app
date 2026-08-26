import { app, shell, BrowserWindow, ipcMain, net } from 'electron'
import { join } from 'path'
import { createServer, IncomingMessage, ServerResponse } from 'http'
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
      try {
        handleProxyRequest(req, res)
      } catch (err) {
        console.error('[proxy] unhandled error:', err)
        if (!res.headersSent) res.writeHead(502)
        res.end(`Proxy error: ${err instanceof Error ? err.stack || err.message : String(err)}`)
      }
    })

    function handleProxyRequest(req: IncomingMessage, res: ServerResponse): void {
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

      // `new URL()` throws synchronously on a malformed base (e.g. a server address typed
      // without "http://", such as "myprovider.com:8080") — left uncaught, that exception
      // would propagate out of this request handler and crash the whole main process.
      let target: URL
      try {
        target = new URL(req.url ?? '/', proxyTargetBase)
      } catch {
        res.writeHead(502)
        res.end(`Invalid Xtream server address: ${proxyTargetBase}`)
        return
      }

      // Use Electron's net module (Chromium's network stack) rather than Node's http/https —
      // Node ships its own bundled CA list, separate from the OS trust store, so on networks
      // with a TLS-inspecting corporate proxy (which install their root CA into the system
      // keychain), a plain Node https.request fails with SELF_SIGNED_CERT_IN_CHAIN even though
      // curl and the browser itself trust the connection fine.
      let upstreamReq
      try {
        upstreamReq = net.request({
          method: req.method,
          url: target.href,
          redirect: 'follow'
        })
      } catch (err) {
        res.writeHead(502)
        res.end(`Could not reach upstream server: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      // Xtream auth is entirely via query-string params, not headers, so there's no need to
      // forward the browser's request headers — most of them (connection, content-length, a
      // Chromium-managed sec-fetch-* set, etc.) are hop-by-hop or forbidden and make Electron's
      // net.request throw ERR_INVALID_ARGUMENT. Only Range matters, for video-seek support.
      const range = req.headers.range
      if (range) upstreamReq.setHeader('range', Array.isArray(range) ? range.join(', ') : range)
      upstreamReq.on('response', (upstreamRes) => {
        const headers = { ...upstreamRes.headers }
        headers['access-control-allow-origin'] = '*'
        headers['access-control-allow-headers'] = '*'
        delete headers['content-security-policy']
        // Electron's net module (Chromium's network stack) transparently decompresses
        // gzip/br/zstd bodies before we ever see the bytes, but the upstream response
        // headers still advertise the original encoding/length. Forwarding those stale
        // headers alongside the now-plain body makes the renderer try to re-decompress
        // already-decoded data, which fails with net::ERR_CONTENT_DECODING_FAILED.
        delete headers['content-encoding']
        delete headers['content-length']
        res.writeHead(upstreamRes.statusCode, headers)
        upstreamRes.pipe(res)
      })
      upstreamReq.on('error', (err) => {
        console.error('[proxy] upstream request error:', err)
        if (!res.headersSent) res.writeHead(502)
        res.end(`Upstream request failed: ${err.message}`)
      })
      req.on('error', (err) => console.error('[proxy] client request error:', err))
      req.pipe(upstreamReq)
    }

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
