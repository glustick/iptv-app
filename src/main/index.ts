import { app, shell, BrowserWindow, ipcMain, net, nativeImage } from 'electron'
import { join, extname } from 'path'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { URL } from 'url'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import Store from 'electron-store'
import { autoUpdater } from 'electron-updater'
import ffmpegPathRaw from 'ffmpeg-static'

// Electron resolves the app's name from package.json's "productName" (falling back to
// "name") before any of this module's own code runs — by the time a line here calls
// app.getPath('userData'), that already reflects the new "AllisonIPTV" productName added
// alongside this rename, not the "iptv-app" name the existing userData folder was created
// under. So the pre-rename location has to be reconstructed explicitly (appData is the
// OS-level user-data root and doesn't depend on the app's own name) rather than captured
// from getPath('userData'), or every user's saved server profile, favorites, and settings
// would silently go missing the first time this runs post-rename.
const legacyUserDataPath = join(app.getPath('appData'), 'iptv-app')
app.setName('AllisonIPTV')
app.setPath('userData', legacyUserDataPath)

const store = new Store()

/**
 * ffmpeg-static's exported path always points inside app.asar, even once packaged — the
 * actual binary lives in app.asar.unpacked (see build.asarUnpack in package.json), since a
 * native executable can't be run from inside a virtual asar archive. This substitution is
 * only meaningful once packaged; in dev the path already resolves directly on disk.
 */
const ffmpegPath = app.isPackaged
  ? ffmpegPathRaw?.replace('app.asar', 'app.asar.unpacked')
  : ffmpegPathRaw

/**
 * Some providers' live channels carry EC-3/E-AC-3 (Dolby Digital Plus) audio inside their
 * MPEG-TS segments, which hls.js's built-in demuxer cannot parse at all — every fragment
 * fails identically, forever (see Player.tsx's MEDIA_ERROR handling). The only real fix is
 * remuxing the audio to AAC before hls.js ever sees it. This spawns ffmpeg per affected
 * channel on demand (not for every stream — most don't need it) reading from this app's own
 * local proxy (already TLS-solved and CORS-free) and writes a fresh local HLS output that the
 * player falls back to.
 */
interface TranscodeSession {
  proc: ChildProcessWithoutNullStreams
  dir: string
  stderrTail: string[]
}
const transcodeSessions = new Map<string, TranscodeSession>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function stopTranscode(sessionId: string): Promise<void> {
  const session = transcodeSessions.get(sessionId)
  if (!session) return
  transcodeSessions.delete(sessionId)

  if (session.proc.exitCode === null) {
    session.proc.kill('SIGTERM')
    // Give ffmpeg a moment to actually stop writing before removing its directory — its own
    // 'exit' handler also cleans up, but only once the process has genuinely terminated;
    // this covers the case where something else (e.g. app quit) needs the directory gone now.
    await Promise.race([
      new Promise<void>((resolve) => session.proc.once('exit', () => resolve())),
      sleep(2000)
    ])
    if (session.proc.exitCode === null) session.proc.kill('SIGKILL')
  }
  await rm(session.dir, { recursive: true, force: true }).catch(() => {})
}

async function startTranscode(sourceUrl: string): Promise<{ sessionId: string; playlistPath: string }> {
  if (!ffmpegPath) {
    throw new Error('ffmpeg binary not available on this platform')
  }
  const sessionId = randomUUID()
  const dir = await mkdtemp(join(tmpdir(), 'allisoniptv-transcode-'))
  const playlistFile = join(dir, 'playlist.m3u8')

  const proc = spawn(ffmpegPath, [
    '-y',
    '-i',
    sourceUrl,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ac',
    '2',
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_list_size',
    '6',
    '-hls_flags',
    'delete_segments+omit_endlist',
    '-hls_segment_filename',
    join(dir, 'seg_%05d.ts'),
    playlistFile
  ])

  const session: TranscodeSession = { proc, dir, stderrTail: [] }
  transcodeSessions.set(sessionId, session)

  proc.stderr.on('data', (chunk: Buffer) => {
    // Keep only a rolling tail — ffmpeg is chatty, but the last few lines are what actually
    // explain a failure to start (bad input, unsupported option, etc).
    session.stderrTail.push(...chunk.toString('utf8').split('\n').filter(Boolean))
    if (session.stderrTail.length > 40) session.stderrTail.splice(0, session.stderrTail.length - 40)
  })
  proc.on('error', (err) => {
    console.error('[transcode] failed to spawn ffmpeg:', err.message)
  })
  proc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[transcode] ffmpeg exited with code ${code}:`, session.stderrTail.join('\n'))
    }
    transcodeSessions.delete(sessionId)
    rm(dir, { recursive: true, force: true }).catch(() => {})
    void signal
  })

  // ffmpeg only writes the playlist once it's produced enough of the first segment, so poll
  // for it rather than assuming it exists immediately — and give up if the process has
  // already died, rather than polling for the full timeout on a lost cause.
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (existsSync(playlistFile)) return { sessionId, playlistPath: playlistFile }
    if (proc.exitCode !== null) {
      throw new Error(`ffmpeg exited before producing output: ${session.stderrTail.slice(-10).join('\n')}`)
    }
    await sleep(300)
  }
  await stopTranscode(sessionId)
  throw new Error('Timed out waiting for ffmpeg to produce transcoded output')
}

const TRANSCODE_MIME_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t'
}

async function serveTranscodeFile(url: string, res: ServerResponse): Promise<void> {
  const match = /^\/__transcode\/([^/]+)\/([^/]+)$/.exec(url)
  const session = match ? transcodeSessions.get(match[1]) : undefined
  const filename = match?.[2]
  const mime = filename ? TRANSCODE_MIME_TYPES[extname(filename)] : undefined
  if (!session || !filename || !mime) {
    res.writeHead(404)
    res.end('Not found')
    return
  }
  try {
    const data = await readFile(join(session.dir, filename))
    res.writeHead(200, {
      'content-type': mime,
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache'
    })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Segment not available')
  }
}

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

      // Transcoded HLS output lives on local disk, not upstream — serve it directly instead
      // of treating it as something to proxy to the Xtream server.
      if (req.url?.startsWith('/__transcode/')) {
        void serveTranscodeFile(req.url, res)
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

// Packaged builds get their icon baked in by electron-builder (from build/icon.png) at the OS
// level — an .icns/.ico embedded in the app bundle/exe — so this path only needs to resolve
// for the unpackaged dev app, which otherwise falls back to Electron's own default icon.
const devIconPath = join(__dirname, '../../build/icon.png')

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    title: 'AllisonIPTV',
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    ...(is.dev ? { icon: devIconPath } : {}),
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

  // BrowserWindow's `icon` option only affects Windows/Linux — macOS Dock icon has to be set
  // separately, and only matters in dev, since the packaged .app bundle carries its own icns.
  if (is.dev && process.platform === 'darwin') {
    app.dock?.setIcon(nativeImage.createFromPath(devIconPath))
  }

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

  ipcMain.handle('transcode:start', async (_event, sourceUrl: string) => {
    const { sessionId } = await startTranscode(sourceUrl)
    return { sessionId, url: `http://127.0.0.1:${proxyPort}/__transcode/${sessionId}/playlist.m3u8` }
  })
  ipcMain.handle('transcode:stop', (_event, sessionId: string) => stopTranscode(sessionId))

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Checks the GitHub Releases this app's CI publishes to (see .github/workflows/release.yml
  // and the "publish" field in package.json) — a no-op until the app is actually packaged
  // and code-signed, since autoUpdater has nothing to check against in dev and unsigned
  // installs can download but not silently apply an update.
  if (!is.dev) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('[auto-update] check failed:', err)
    })
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Without this, quitting the app while a transcode is active would leave its ffmpeg child
// process (and temp directory) running/on-disk indefinitely — Electron doesn't kill child
// processes it didn't spawn via its own process-management APIs on quit.
app.on('before-quit', () => {
  for (const sessionId of transcodeSessions.keys()) {
    void stopTranscode(sessionId)
  }
})
