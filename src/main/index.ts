import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  net,
  session,
  nativeImage,
  Menu,
  safeStorage,
  type MenuItemConstructorOptions
} from 'electron'
import { join, extname } from 'path'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { URL } from 'url'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
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

// app.getVersion() already reads package.json's "version" natively, but buildNumber is a
// custom field with no built-in getter — app.getAppPath() resolves correctly both in dev and
// packaged (inside app.asar, which Node's fs can read transparently), so this mirrors how
// Electron itself locates package.json rather than assuming a fixed relative path.
const pkgMeta = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
  buildNumber: number
}

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

// The renderer picks a sessionId up front and can call stop() on it well before startTranscode
// below has actually spawned ffmpeg and registered it in transcodeSessions — e.g. switching to a
// different title while the previous one's transcode attempt is still in flight, before it has
// ever produced output. Without tracking that, stopTranscode would find nothing to do, and the
// spawn already in progress would carry on regardless — leaving an orphaned ffmpeg process
// competing for this account's single connection slot with whatever plays next. Recording the
// cancellation here lets startTranscode notice it and kill the process it just spawned instead.
const cancelledSessions = new Set<string>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function stopTranscode(sessionId: string): Promise<void> {
  cancelledSessions.add(sessionId)
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

async function startTranscode(
  sourceUrl: string,
  isVod: boolean,
  sessionId: string
): Promise<{ sessionId: string; playlistPath: string }> {
  if (!ffmpegPath) {
    throw new Error('ffmpeg binary not available on this platform')
  }
  // A stop() for this exact sessionId could already have arrived (the renderer switched away
  // before this call even started) — nothing to spawn in that case.
  if (cancelledSessions.has(sessionId)) {
    cancelledSessions.delete(sessionId)
    throw new Error('Transcode cancelled')
  }
  const dir = await mkdtemp(join(tmpdir(), 'allisoniptv-transcode-'))
  const playlistFile = join(dir, 'playlist.m3u8')

  const proc = spawn(ffmpegPath, [
    '-y',
    '-i',
    sourceUrl,
    // Movies/series routinely carry an embedded subtitle track alongside the audio this fix
    // targets. Left unmapped, ffmpeg auto-selects it and the HLS muxer treats it as a second
    // WebVTT rendition — which defers writing the main playlist.m3u8 until the *entire* input
    // has been processed, not incrementally per segment (confirmed live: ffmpeg fully
    // transcoded a 76-minute movie at 19x realtime, writing hundreds of segments the whole
    // time, yet playlist.m3u8 itself never appeared until the process was killed at the very
    // end — every prior timeout in this investigation was this, not a network/connection
    // problem). Excluding subtitles avoids that rendition entirely; there's no reason to carry
    // them through here anyway, since fixing silent audio is the only thing this path is for.
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
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
    // Live's list is deliberately a short, ever-deleting window (there's no fixed end to keep
    // segments for). VOD is the opposite: a movie/episode has a real duration, and the whole
    // point is being able to scrub anywhere in it, so every segment has to stick around. This
    // is *not* `-hls_playlist_type vod`, despite the name fitting — confirmed directly (an
    // isolated, network-free ffmpeg run, checked mid-encode): `vod` writes nothing to disk at
    // all until the source hits EOF, per the HLS spec's own definition of a VOD playlist as
    // "published complete and unchanging." That's exactly backwards for a still-in-progress
    // remux — every earlier "timeout waiting for ffmpeg" in this feature's development was
    // actually this, not a network or subtitle problem, and would recur for any file whose
    // full runtime exceeds startTranscode's deadline. `event` is the type actually meant for
    // this shape (segments keep appending until the source ends), and does write the playlist
    // incrementally, confirmed by ffmpeg's own log showing repeated
    // "Opening playlist.m3u8.tmp for writing" during encode rather than only at exit — hls.js
    // (which is what actually plays this, once transcoded — see getSourceUrl/isM3u8 in
    // Player.tsx) already knows to keep reloading an EVENT playlist until it sees
    // #EXT-X-ENDLIST, so this is a drop-in behavior change, not a player-side one.
    ...(isVod
      ? ['-hls_list_size', '0', '-hls_playlist_type', 'event']
      : ['-hls_list_size', '6', '-hls_flags', 'delete_segments+omit_endlist']),
    '-hls_segment_filename',
    join(dir, 'seg_%05d.ts'),
    playlistFile
  ])

  // mkdtemp and spawn() both involve a real async/OS gap after the check above — a stop() can
  // still have landed in between. Checking again right before registering the session (rather
  // than relying on the polling loop alone) keeps a cancelled request from ever occupying the
  // account's connection slot at all, instead of just getting killed a beat later.
  if (cancelledSessions.has(sessionId)) {
    cancelledSessions.delete(sessionId)
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw new Error('Transcode cancelled')
  }
  const session: TranscodeSession = { proc, dir, stderrTail: [] }
  transcodeSessions.set(sessionId, session)

  // A stall-detection scheme keyed on "time since ffmpeg last wrote to stderr" was tried here
  // and had to be abandoned: ffmpeg's stderr is a pipe, not a tty, and glibc/libSystem's stdio
  // buffers pipes fully rather than line-by-line — so long, apparently silent stretches
  // (confirmed live, repeatedly, against a real account: 60-120+ seconds with zero stderr
  // output) don't reliably mean ffmpeg is stuck. Several of those "stalls" turned out to have
  // already opened the input and started encoding; the silence was just unflushed buffer, and
  // killing on it destroyed transcodes that were actually about to succeed. A single generous
  // deadline (below) doesn't have that false-positive problem.
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

  // ffmpeg only writes the playlist once it's produced enough of the first segment, so poll for
  // it rather than assuming it exists immediately — and give up if the process has already
  // died, rather than polling for the full timeout on a lost cause. VOD gets a much longer
  // budget than live: confirmed live against a real account, just opening the input (probing
  // the container, before ffmpeg writes a single frame) took anywhere from ~25s to ~90s across
  // otherwise-identical attempts against the same file, and actual encode throughput — once it
  // does get going — was fast (19x realtime, -c:v copy isn't CPU-bound). The bottleneck is
  // entirely how long this account's connection takes to start delivering data, which varies
  // enough attempt-to-attempt that the deadline needs real headroom rather than being tuned to
  // the common case.
  const deadline = Date.now() + (isVod ? 240000 : 20000)
  while (Date.now() < deadline) {
    if (cancelledSessions.has(sessionId)) {
      cancelledSessions.delete(sessionId)
      await stopTranscode(sessionId)
      throw new Error('Transcode cancelled')
    }
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

      // Xtream auth is entirely via query-string params, not headers, so there's no need to
      // forward the browser's request headers — most of them (connection, content-length, a
      // Chromium-managed sec-fetch-* set, etc.) are hop-by-hop or forbidden and make Electron's
      // net.request throw ERR_INVALID_ARGUMENT. Only Range matters, for video-seek support.
      const range = req.headers.range

      // Uses Electron's net module (Chromium's network stack) rather than Node's http/https —
      // Node ships its own bundled CA list, separate from the OS trust store, so on networks
      // with a TLS-inspecting corporate proxy (which install their root CA into the system
      // keychain), a plain Node https.request fails with SELF_SIGNED_CERT_IN_CHAIN even though
      // curl and the browser itself trust the connection fine.
      //
      // Confirmed live: Chromium's own network stack can end up in a state, mid-session, where
      // *every* subsequent request to a given host hangs forever with no response — reproduced
      // with a plain renderer-side `fetch()` to the same host (bypassing this proxy entirely)
      // hanging identically, while a `curl` to the exact same URL from the same machine at the
      // same moment succeeded in ~1s, repeatedly. So the origin is healthy; something in this
      // process's own DNS cache or pooled-connection state for that host isn't. Previously this
      // proxy had no timeout at all on the upstream request, so a hang like that was permanent —
      // nothing short of restarting the app would recover. Now: give up on the *first* attempt
      // early enough to matter (getting response *headers* back should be fast even for a huge
      // video file — this doesn't bound how long the body then takes to fully arrive), clear
      // Chromium's host resolver cache for this session in case a stale DNS entry is the cause,
      // and retry exactly once with a fresh request before actually failing.
      const UPSTREAM_TIMEOUT_MS = 20000
      let retried = false

      function attemptUpstream(): void {
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
        if (range) upstreamReq.setHeader('range', Array.isArray(range) ? range.join(', ') : range)

        let gotResponse = false
        const timeout = setTimeout(() => {
          if (!gotResponse && !upstreamReq.destroyed) upstreamReq.destroy()
        }, UPSTREAM_TIMEOUT_MS)

        upstreamReq.on('response', (upstreamRes) => {
          gotResponse = true
          clearTimeout(timeout)
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
          clearTimeout(timeout)
          if (!gotResponse && !retried) {
            retried = true
            session.defaultSession.clearHostResolverCache()
            attemptUpstream()
            return
          }
          console.error('[proxy] upstream request error:', err)
          if (!res.headersSent) res.writeHead(502)
          res.end(`Upstream request failed: ${err.message}`)
        })
        // `.pipe()` only carries data forward — it does nothing when the *destination* goes
        // away, so a renderer that abandons a request mid-stream (a <video> element doing
        // `.removeAttribute('src'); .load()` to switch sources, a page navigating away) left
        // the upstream request to the real Xtream server running indefinitely with nothing
        // left to write to. Invisible on an unlimited-connections account, but fatal on one
        // capped at a single concurrent stream (confirmed via a real account's
        // get_server_info, max_connections: "1"): the old connection never actually released,
        // so a second legitimate request (e.g. this app's own ffmpeg transcode fallback,
        // moments later) had nothing to connect with and just hung. Destroying the upstream
        // request as soon as the client side closes — for any reason, not just success — is
        // what actually frees the slot.
        res.on('close', () => {
          clearTimeout(timeout)
          if (!upstreamReq.destroyed) upstreamReq.destroy()
        })
        // GET/HEAD requests (everything this app ever proxies — Xtream auth is query-string
        // only, never a body) end `req` immediately with nothing written, so re-piping it into
        // a second `upstreamReq` on retry just ends that one too, correctly, with no body lost.
        req.pipe(upstreamReq)
      }

      req.on('error', (err) => console.error('[proxy] client request error:', err))
      attemptUpstream()
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

// The About menu item needs to reach the renderer via IPC, but Menu.buildFromTemplate's click
// handler has no direct reference to whichever BrowserWindow is currently focused — captured
// here instead of threading it through, since this app only ever has one window at a time.
let mainWindowRef: BrowserWindow | null = null

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

  mainWindowRef = mainWindow
  mainWindow.on('closed', () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null
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

// A custom click handler (not role: 'about') so the panel is a renderer-side modal showing the
// buildNumber field too — the native macOS About panel (role: 'about') has no slot for that.
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const openAbout = (): void => mainWindowRef?.webContents.send('menu:open-about')
  const aboutItem: MenuItemConstructorOptions = { label: `About ${app.getName()}`, click: openAbout }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.getName(),
            submenu: [
              aboutItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] satisfies MenuItemConstructorOptions[])
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: isMac ? [] : [aboutItem] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.iptv.app')
  buildAppMenu()

  // BrowserWindow's `icon` option only affects Windows/Linux — macOS Dock icon has to be set
  // separately, and only matters in dev, since the packaged .app bundle carries its own icns.
  if (is.dev && process.platform === 'darwin') {
    app.dock?.setIcon(nativeImage.createFromPath(devIconPath))
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    buildNumber: pkgMeta.buildNumber
  }))

  ipcMain.handle('store:get', (_event, key: string) => store.get(key))
  ipcMain.handle('store:set', (_event, key: string, value: unknown) => store.set(key, value))
  ipcMain.handle('store:delete', (_event, key: string) => store.delete(key))

  // OS-keychain-backed encryption (macOS Keychain / Windows DPAPI / Linux Secret Service where
  // available) for the parental PIN — only reachable from the main process, hence the IPC
  // round-trip rather than something storage.ts could do directly. isAvailable() can be false
  // on Linux without a keyring daemon running; callers fall back to plaintext in that case,
  // same as before this existed.
  ipcMain.handle('safeStorage:isAvailable', () => safeStorage.isEncryptionAvailable())
  ipcMain.handle('safeStorage:encrypt', (_event, plainText: string) =>
    safeStorage.encryptString(plainText).toString('base64')
  )
  ipcMain.handle('safeStorage:decrypt', (_event, base64: string) =>
    safeStorage.decryptString(Buffer.from(base64, 'base64'))
  )

  const proxyPort = await startLocalProxy()
  ipcMain.handle('proxy:getBaseUrl', () => `http://127.0.0.1:${proxyPort}`)
  ipcMain.handle('proxy:setTarget', (_event, baseUrl: string) => {
    proxyTargetBase = baseUrl
  })

  ipcMain.handle('transcode:start', async (_event, sourceUrl: string, isVod: boolean, sessionId: string) => {
    await startTranscode(sourceUrl, isVod, sessionId)
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
