import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import {
  backupPreferredUntil,
  createFailoverState,
  notePrimaryFailure,
  notePrimarySuccess
} from './proxyFailover'
import { URL } from 'url'

/**
 * The subset of Electron's net.ClientRequest this module actually uses — kept as a local
 * structural type (not imported from 'electron') so this file has no Electron dependency at
 * all and can be unit-tested with a plain Node http.request-backed implementation instead.
 * Electron's real net.ClientRequest genuinely has every member here with a matching signature
 * (checked directly in electron.d.ts) — index.ts still casts to this type at its one
 * construction site, but that's a TypeScript overload-set assignability limitation, not a real
 * gap (see the comment there).
 *
 * abort() — not destroy() — is the one that actually works here. Found the hard way (an
 * isolated, real-net.request reproduction, no live account involved): once a request has
 * followed at least one redirect, .destroyed reports true even before anything has cancelled
 * it, and calling .destroy() on it is a silent no-op — the underlying connection to the
 * redirect target is never actually closed. That's a real leak: since Electron's net module
 * shares one connection pool per host across the whole app, a single stuck, never-released
 * connection from this proxy's own retry logic can eventually starve *every other* request to
 * the same Xtream server, not just the one that leaked (reproduced live: a VOD title's failed
 * audio-fix transcode left the entire app's menus/API calls unable to reach the server
 * afterward). abort() closes the connection correctly in both the redirected and
 * non-redirected cases, and is safe to call more than once or after the request already
 * completed normally — confirmed directly, not assumed.
 */
export interface UpstreamClientRequest {
  setHeader(name: string, value: string): void
  on(event: 'response', listener: (response: UpstreamResponse) => void): this
  on(event: 'redirect', listener: (statusCode: number, method: string, redirectUrl: string) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  followRedirect(): void
  abort(): void
}

export interface UpstreamResponse {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  pipe(destination: ServerResponse): void
  // Only needed for buffering a small .m3u8 playlist body to rewrite it (see rewriteM3u8ForProxy)
  // — every other response (segments, API/EPG payloads) still just pipe()s straight through.
  // Electron's real net.IncomingMessage genuinely supports these too, alongside pipe(); this is
  // the same narrowed-structural-interface approach UpstreamClientRequest already documents.
  on(event: 'data', listener: (chunk: Buffer) => void): this
  on(event: 'end', listener: () => void): this
}

// M3U profiles route every request — including a channel's own per-stream playlist — through
// /__fetch/<url-encoded absolute URL> (see its own route comment below), since unlike Xtream
// there's no single base URL every request shares. That breaks the moment hls.js resolves a
// RELATIVE reference *within* a fetched .m3u8 (a segment file, a nested variant playlist) —
// relative-URL resolution happens against the URL the content was fetched from, which from the
// browser's perspective is this proxy's own /__fetch/<one giant percent-encoded path segment>,
// and replacing just that one segment (standard relative-resolution behavior) lands on
// /__fetch/seg_00001.ts, not /__fetch/<the real upstream segment URL, encoded> — confirmed live
// against a real synthetic multi-segment HLS channel, every segment request 502ing. Rewriting
// every URI reference inside a fetched .m3u8 to its own already-correct, absolute-path
// /__fetch/<encoded> form — resolved server-side against the real upstream URL, which this
// proxy has and the browser doesn't — is what makes nested references transparent regardless of
// how many playlist levels a provider's stream actually has. Also rewrites references that are
// *already* absolute (e.g. a CDN-hosted segment) — left alone, the browser would fetch those
// directly, bypassing this proxy (and whatever CORS/VPN handling it provides) entirely.
export function rewriteM3u8ForProxy(body: string, sourceUrl: URL): string {
  function rewriteRef(ref: string): string {
    try {
      const resolved = new URL(ref, sourceUrl)
      return `/__fetch/${encodeURIComponent(resolved.href)}`
    } catch {
      return ref
    }
  }
  return body
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (trimmed.startsWith('#')) {
        // Tag lines can carry their own URI reference as an attribute — EXT-X-KEY (decryption),
        // EXT-X-MAP (fragmented-MP4 init segment), EXT-X-MEDIA (alternate audio/subtitle
        // renditions) all use this exact `URI="..."` shape.
        return line.replace(/URI="([^"]+)"/g, (_match, ref: string) => `URI="${rewriteRef(ref)}"`)
      }
      // Any other non-blank, non-comment line is itself a URI — a segment or a nested/variant
      // playlist reference, HLS's own convention for what a plain line in a playlist means.
      return rewriteRef(trimmed)
    })
    .join('\n')
}

export interface ProxyServerDeps {
  // Swapped whenever the user connects to a (possibly different) profile — null before any
  // profile has connected yet.
  getProxyTargetBase: () => string | null
  // The account's backup portal for the current primary target, or null when there is none
  // (no backup configured, or the proxy is deliberately pointed elsewhere). Optional so
  // existing test wirings compile untouched; without it there is simply no failover. Ported
  // from the web sibling (allison-web-iptv v0.72.0), where the operator's provider publishes
  // a reserve portal and the proxy now fails over to it by itself.
  getProxyBackupBase?: () => string | null
  // Electron's net.request in production (Chromium's network stack — see the comment on
  // createUpstreamRequest's call site in index.ts for why, not Node's http/https). Anything
  // satisfying UpstreamClientRequest works, which is what makes this testable without Electron.
  createUpstreamRequest: (opts: { method: string | undefined; url: string }) => UpstreamClientRequest
  // Electron's session.defaultSession.clearHostResolverCache() in production.
  clearHostResolverCache: () => Promise<void>
  isVpnConnected: () => boolean
  // Every provider host this connection's tunnel routes — plural since multi-playlist
  // (see startVpn): with two playlists connected, routing only one would leave the other's
  // traffic outside the tunnel with nothing saying so.
  getVpnTunneledHosts: () => string[]
  // Called whenever a redirect lands on a host that is not one of getVpnTunneledHosts() while the VPN
  // is connected — the caller owns deciding what to do with that (dedup, logging, IPC to the
  // renderer), this module only ever detects it.
  onOffTunnelRedirect: (tunneledHost: string, redirectHost: string) => void
  // The addresses actually written into the OS routes for getVpnTunneledHosts() (see
  // writeRouteScript in index.ts) — resolved once, at connect time, independent of Chromium's
  // own DNS resolution for this proxy's actual requests.
  // Every address this connection's routes actually cover — plural, because a panel behind
  // several A records gets a route per address (see resolveRouteAddresses / vpnRouteScript).
  getVpnTunneledIps: () => string[]
  // Node's dns.lookup in production — deliberately separate from Electron's own resolver (and
  // from clearHostResolverCache, which only clears Chromium's cache) so this reflects a genuinely
  // fresh, independent answer to compare against getVpnTunneledIp().
  resolveHostIp: (hostname: string) => Promise<string | null>
  // Called when a retry's fresh DNS lookup resolves the tunneled host to a different IP than
  // getVpnTunneledIp() — distinct from onOffTunnelRedirect: same hostname, different underlying
  // address, not a redirect at all, so the hostname-based check above can't catch it.
  onTunneledHostIpChanged: (tunneledHost: string, tunneledIps: string[], resolvedIp: string) => void
  // Transcoded HLS output lives on local disk, not upstream — index.ts wires this to
  // serveTranscodeFile so /__transcode/ requests never get treated as something to proxy.
  handleTranscodeRequest: (url: string, res: ServerResponse) => void
  // 45s in production (see the reasoning at this option's use below) — overridable so tests
  // don't have to wait out a real 45-second timeout to exercise the retry path.
  upstreamTimeoutMs?: number
}

/**
 * Xtream Codes panels are built for native players (VLC, set-top boxes) and never send CORS
 * headers, so Chromium blocks every player_api/EPG/stream request as cross-origin. This proxy
 * re-issues each request from the main process (not subject to browser CORS) and stamps the
 * response with permissive CORS headers before handing it to the renderer.
 *
 * Extracted from src/main/index.ts's startLocalProxy() into its own module (all dependencies on
 * Electron's net/session modules and on this app's VPN/transcode state injected rather than
 * referenced directly) specifically so it can be unit-tested against a real local HTTP server
 * without needing to load the rest of the Electron main process at all.
 */
export function createProxyServer(deps: ProxyServerDeps): Server {
  const upstreamTimeoutMs = deps.upstreamTimeoutMs ?? 45000

  // The failover memory: which primary bases are currently being failed over from (see
  // proxyFailover.ts). Scoped to this server instance, so tests get a clean slate.
  const failoverState = createFailoverState()

  // --- Refused-segment retry with a fresh playlist (signature expiry) -------------------------
  //
  // This provider signs each playlist's segment URLs for roughly 25 seconds (measured on the web
  // sibling, same provider family). hls.js normally consumes young signatures — it reloads the
  // playlist every cycle — but a slow fetch or a pause-and-resume can put an old segment URL in
  // flight after its signature has gone, and the answer is a bare 400/403. The player treats a
  // fatal fragment error as a full remux-session restart (0.7.113's ladder), which is an expensive
  // answer to what is really a *token refresh* problem. The thorough fix lives here, where the
  // tokens are actually consumed: remember every served playlist's segment window; when a segment
  // request is refused, re-fetch that playlist (fresh signatures), map the refused segment to the
  // same absolute sequence number in the fresh window, and retry exactly once. Ported from the
  // web sibling's relay (allison-web-iptv v0.44.0), where it shipped with a signing-URL origin
  // test suite this port carries over.
  interface PlaylistWindow {
    /** Absolute upstream segment URLs, in playlist order. */
    segments: string[]
    /** #EXT-X-MEDIA-SEQUENCE — makes indexes absolute across window slides. */
    mediaSequence: number
    /** The upstream URL the window was fetched from — what a refresh re-fetches. */
    upstreamHref: string
  }

  // One-deep window history per playlist: a burst of refusals can straddle a refresh (the first
  // refusal's refresh completes before its neighbours are even handled), and those later refusals
  // carry URLs from the window *before* the refresh — without the previous window kept for
  // matching, they would look unknown and pass through un-retried.
  interface PlaylistWindowEntry {
    current: PlaylistWindow
    previous: PlaylistWindow | null
  }

  const PLAYLIST_WINDOW_LIMIT = 32
  const PLAYLIST_REFRESH_MIN_INTERVAL_MS = 2000
  /** Keyed by the app-side path the playlist was served at; the lookup that matters scans values. */
  const playlistWindows = new Map<string, PlaylistWindowEntry>()
  const playlistRefreshInFlight = new Map<string, Promise<PlaylistWindow | null>>()
  const playlistLastRefreshAt = new Map<string, number>()

  function parsePlaylistWindow(body: string, playlistUrl: URL): { segments: string[]; mediaSequence: number } | null {
    let mediaSequence = -1
    const segments: string[] = []
    for (const raw of body.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      if (line.startsWith('#')) {
        const match = line.match(/^#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/)
        if (match) mediaSequence = Number(match[1])
        continue
      }
      try {
        segments.push(new URL(line, playlistUrl).href)
      } catch {
        // A malformed URI line — the browser would fail on it too; leave it out of the window.
      }
    }
    // Master/variant playlists (no media sequence, no inline segments) and VOD playlists (no
    // media sequence at all) aren't live segment windows.
    if (mediaSequence < 0 || segments.length === 0) return null
    return { segments, mediaSequence }
  }

  function rememberPlaylistWindow(appSideKey: string, window: PlaylistWindow): void {
    if (!appSideKey) return
    const existing = playlistWindows.get(appSideKey)
    playlistWindows.delete(appSideKey)
    playlistWindows.set(appSideKey, { current: window, previous: existing?.current ?? null })
    if (playlistWindows.size > PLAYLIST_WINDOW_LIMIT) {
      const oldest = playlistWindows.keys().next().value
      if (oldest !== undefined) playlistWindows.delete(oldest)
    }
  }

  /** Finds a requested segment URL in the entry's current or previous window, with its index. */
  function locateSegmentInEntry(entry: PlaylistWindowEntry, requestedUrl: string): { window: PlaylistWindow; index: number } | null {
    const currentHit = entry.current.segments.indexOf(requestedUrl)
    if (currentHit !== -1) return { window: entry.current, index: currentHit }
    if (entry.previous) {
      const previousHit = entry.previous.segments.indexOf(requestedUrl)
      if (previousHit !== -1) return { window: entry.previous, index: previousHit }
    }
    return null
  }

  /**
   * The window holding a refused segment, found by scanning — deliberately NOT keyed off the
   * request's Referer like the web sibling's relay: this renderer loads from file://, which sends
   * no Referer at all. The proxy knows the upstream URL every request addresses, and each window
   * holds its segments' upstream URLs, so a scan over ≤32 windows × ≤2 generations answers it
   * (the web keyed off Referer because its browser client could provide one; nothing here needs
   * client cooperation).
   */
  function findWindowContaining(refusedUrl: string): { key: string; entry: PlaylistWindowEntry; hit: { window: PlaylistWindow; index: number } } | null {
    for (const [key, entry] of playlistWindows) {
      const hit = locateSegmentInEntry(entry, refusedUrl)
      if (hit) return { key, entry, hit }
    }
    return null
  }

  /** Collects a text body through the shared upstream machinery (redirect handling included). */
  function fetchTextUpstream(url: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let upstreamReq: UpstreamClientRequest
      try {
        upstreamReq = deps.createUpstreamRequest({ method: 'GET', url })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      const timer = setTimeout(() => {
        upstreamReq.abort()
        finish(() => reject(new Error(`Playlist refresh timed out after ${timeoutMs}ms`)))
      }, timeoutMs)
      upstreamReq.on('redirect', () => upstreamReq.followRedirect())
      upstreamReq.on('error', (err) => finish(() => reject(err)))
      upstreamReq.on('response', (upstreamRes) => {
        if (upstreamRes.statusCode >= 400) {
          upstreamRes.on('data', () => {}) // drain the refusal body — it is of no use to anyone
          upstreamReq.abort()
          finish(() => reject(new Error(`Playlist refresh got HTTP ${upstreamRes.statusCode}`)))
          return
        }
        const chunks: Buffer[] = []
        upstreamRes.on('data', (chunk) => chunks.push(chunk))
        upstreamRes.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8'))))
      })
      // No end() call — Electron's net.request sends a bodyless GET on creation (every request
      // this proxy already makes works exactly so), and the test fake ends itself on nextTick.
    })
  }

  /**
   * Refreshes the refused segment's playlist at most once per interval (concurrent refused
   * segments share one fetch — a burst of 400s must not become a burst of playlist downloads),
   * then maps the refused segment to the fresh window by absolute sequence number. Returns the
   * fresh absolute URL to retry, or null when a retry is not possible (unknown segment, window
   * already slid past it, or the refresh itself failed).
   */
  async function freshSegmentUrlFor(refusedUrl: string): Promise<string | null> {
    const found = findWindowContaining(refusedUrl)
    if (!found) return null
    const { key, entry, hit } = found
    const absoluteSequence = hit.window.mediaSequence + hit.index

    const lastRefresh = playlistLastRefreshAt.get(key) ?? 0
    let inFlight = playlistRefreshInFlight.get(key)
    if (!inFlight && Date.now() - lastRefresh >= PLAYLIST_REFRESH_MIN_INTERVAL_MS) {
      playlistLastRefreshAt.set(key, Date.now())
      inFlight = fetchTextUpstream(entry.current.upstreamHref, 10_000)
        .then((body) => {
          const parsed = parsePlaylistWindow(body, new URL(entry.current.upstreamHref))
          if (!parsed) return null
          const fresh: PlaylistWindow = { ...parsed, upstreamHref: entry.current.upstreamHref }
          rememberPlaylistWindow(key, fresh)
          return fresh
        })
        .catch(() => null)
      playlistRefreshInFlight.set(key, inFlight)
      void inFlight.finally(() => playlistRefreshInFlight.delete(key))
    }

    const refreshed = (await inFlight) ?? null
    const fresh = refreshed ?? playlistWindows.get(key)?.current ?? null
    if (!fresh) return null
    const freshIndex = absoluteSequence - fresh.mediaSequence
    if (freshIndex < 0 || freshIndex >= fresh.segments.length) return null
    return fresh.segments[freshIndex]
  }

  // -------------------------------------------------------------------------------------------

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
      deps.handleTranscodeRequest(req.url, res)
      return
    }

    // Unlike Xtream (where every request — API, EPG, every stream — shares one base URL this
    // proxy can resolve a path against), an M3U playlist can reference a completely different
    // host per channel, and the playlist/EPG URLs themselves can differ from every one of those
    // too. /__fetch/<url-encoded absolute URL> lets a caller (see lib/m3uClient.ts) proxy to
    // any destination directly, bypassing getProxyTargetBase() entirely, while still getting
    // the same CORS/retry/timeout/redirect handling as the Xtream path below.
    let target: URL
    // The account's backup portal for this request, resolved once — null on /__fetch/ (whose
    // destination is the encoded URL itself) or when none is configured. lib/proxyFailover.ts
    // carries the why of the cooldown.
    let backupUrl: URL | null = null
    // The base the target resolved against (null on /__fetch/) — the key the failover
    // cooldown is remembered under.
    let primaryBase: string | null = null
    if (req.url?.startsWith('/__fetch/')) {
      try {
        target = new URL(decodeURIComponent(req.url.slice('/__fetch/'.length)))
      } catch {
        res.writeHead(502)
        res.end('Invalid proxied URL')
        return
      }
    } else {
      const proxyTargetBase = deps.getProxyTargetBase()
      if (!proxyTargetBase) {
        res.writeHead(502)
        res.end('No upstream Xtream server configured')
        return
      }
      primaryBase = proxyTargetBase

      // `new URL()` throws synchronously on a malformed base (e.g. a server address typed
      // without "http://", such as "myprovider.com:8080") — left uncaught, that exception
      // would propagate out of this request handler and crash the whole main process.
      try {
        target = new URL(req.url ?? '/', proxyTargetBase)
      } catch {
        res.writeHead(502)
        res.end(`Invalid Xtream server address: ${proxyTargetBase}`)
        return
      }

      // A malformed stored backup must not kill the request the way a malformed primary
      // would — it just means no failover this time.
      const backupBase = deps.getProxyBackupBase?.() ?? null
      if (backupBase) {
        try {
          backupUrl = new URL(req.url ?? '/', backupBase)
        } catch {
          backupUrl = null
        }
      }
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
    // early enough to matter, clear Chromium's host resolver cache for this session in case a
    // stale DNS entry is the cause, and retry exactly once with a fresh request before
    // actually failing.
    //
    // 20s was the original figure here, on the assumption that getting response *headers*
    // back should be fast even for a huge video file regardless of how slow the body then is.
    // Confirmed live that assumption was wrong for this account on at least one real byte-
    // range request: it timed out at 20s, the retry *also* timed out at 20s, and the origin's
    // real response to the very first attempt then arrived anyway, just later than 20s —
    // proof the connection wasn't dead, only slower than the timeout assumed. 45s gives a
    // real request room to actually finish before being mistaken for a hung one, while two
    // attempts at 45s each (90s worst case) still leaves headroom inside startTranscode's
    // overall 240s deadline.
    let retried = false
    // The refused-segment retry (signature expiry, see the window block above) is a separate
    // one-shot from the same-target transport retry `retried` drives: a segment the provider
    // refuses with 400/403 gets exactly one refresh-and-remap attempt, and a retried segment
    // that is refused again passes through (the player's own recovery remains the backstop).
    let retriedWithFreshSegment = false
    // The backup-portal failover is its own one-shot after the same-target retry: one attempt
    // against the other portal before the failure is surfaced. Whichever base the CURRENT
    // attempt addresses is tracked here, so the same-target retry re-tries the right portal
    // and the response handler knows whose answer it is looking at.
    let attemptOnBackup = false
    let failedOver = false
    // Cooldown: after a failover, later requests skip the dead primary for a short window —
    // without it every request would pay the primary's connect-timeout before the backup.
    const backupFirst =
      backupUrl !== null &&
      primaryBase !== null &&
      backupPreferredUntil(failoverState, primaryBase, Date.now()) !== null

    function attemptUpstream(urlOverride?: URL): void {
      let upstreamReq: UpstreamClientRequest
      try {
        upstreamReq = deps.createUpstreamRequest({ method: req.method, url: (urlOverride ?? target).href })
      } catch (err) {
        res.writeHead(502)
        res.end(`Could not reach upstream server: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      if (range) upstreamReq.setHeader('range', Array.isArray(range) ? range.join(', ') : range)

      upstreamReq.on('redirect', (_statusCode, _method, redirectUrl) => {
        if (deps.isVpnConnected()) {
          const tunneledHosts = deps.getVpnTunneledHosts()
          if (tunneledHosts.length > 0) {
            try {
              const redirectHost = new URL(redirectUrl).hostname.toLowerCase()
              // Still inside the tunnel if the redirect lands on *any* routed host — with two
              // playlists connected, provider A redirecting to provider B is not a leak.
              if (!tunneledHosts.includes(redirectHost)) {
                deps.onOffTunnelRedirect(tunneledHosts[0], redirectHost)
              }
            } catch {
              // Malformed redirect URL — nothing useful to compare against; let followRedirect()
              // below surface whatever error actually following it produces instead.
            }
          }
        }
        upstreamReq.followRedirect()
      })

      let gotResponse = false
      let settled = false

      // Split out from the 'error' handler rather than having the timeout only call abort()
      // and hope that reliably emits 'error' — Electron's net.ClientRequest, built on
      // Chromium's network stack rather than Node's http module, isn't guaranteed to fire one
      // just because JS-side abort() was called. If it doesn't, a timeout that only aborts and
      // waits leaves this request permanently unsettled: no response, no error, res never gets
      // written to, and whatever's waiting on it (ffmpeg, the renderer) hangs forever —
      // indistinguishable from the original bug this timeout exists to fix. Calling this
      // directly from the timeout guarantees the retry/failure path actually runs.
      function giveUpOrRetry(err: Error): void {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        // abort() unconditionally — no .destroyed-style guard needed, it's safe to call more
        // than once or on an already-completed request (see the interface's own doc comment).
        upstreamReq.abort()
        if (!gotResponse && !retried) {
          retried = true
          // clearHostResolverCache() returns a Promise (an IPC round-trip to the browser
          // process) — a rejection here left unhandled would be an unhandled promise
          // rejection in the main process, which is exactly the kind of thing that surfaces
          // as Electron's disruptive "A JavaScript error occurred in the main process"
          // dialog. Best-effort only: whether or not it succeeds, the retry itself is what
          // matters, so failure here just means the retry runs without a fresh DNS lookup.
          deps.clearHostResolverCache().catch(() => {})
          // The line above deliberately forces a *fresh* DNS answer for this retry — if that
          // now differs from the one IP the VPN's OS route actually covers (see
          // getVpnTunneledIp's own comment), this and every request after it would silently
          // use the normal, non-tunneled route instead. onOffTunnelRedirect can't catch this:
          // it only compares hostnames on an HTTP redirect, and this is the *same* hostname
          // resolving to a *different* address, not a redirect at all. Warning-only, and never
          // lets this delay the retry itself — fire-and-forget, same as the line above.
          if (deps.isVpnConnected()) {
            const tunneledHosts = deps.getVpnTunneledHosts()
            const tunneledHost = tunneledHosts.includes(target.hostname.toLowerCase())
              ? target.hostname.toLowerCase()
              : null
            const tunneledIps = deps.getVpnTunneledIps()
            if (tunneledHost && tunneledIps.length > 0) {
              deps
                .resolveHostIp(target.hostname)
                .then((resolvedIp) => {
                  if (resolvedIp && !tunneledIps.includes(resolvedIp)) {
                    deps.onTunneledHostIpChanged(tunneledHost, tunneledIps, resolvedIp)
                  }
                })
                .catch(() => {})
            }
          }
          // Re-try the portal this attempt was already addressing — not blindly the primary:
          // when the cooldown sent this request to the backup first, its retry belongs there.
          attemptUpstream(attemptOnBackup && backupUrl ? backupUrl : undefined)
          return
        }
        // The same-target retry is spent. One attempt against the OTHER portal before the
        // failure is surfaced — the failover itself, ported from the web sibling (v0.72.0).
        if (!failedOver && backupUrl && primaryBase !== null) {
          failedOver = true
          if (!attemptOnBackup) {
            attemptOnBackup = true
            notePrimaryFailure(failoverState, primaryBase, Date.now())
            console.warn(`[proxy] primary ${target.host} failed (${err.message}) — failing over to the backup portal`)
            attemptUpstream(backupUrl)
          } else {
            attemptOnBackup = false
            console.warn(`[proxy] backup ${backupUrl.host} failed (${err.message}) — trying the primary portal`)
            attemptUpstream()
          }
          return
        }
        console.error('[proxy] upstream request error:', err)
        if (!res.headersSent) res.writeHead(502)
        res.end(`Upstream request failed: ${err.message}`)
      }

      const timeout = setTimeout(() => {
        if (!gotResponse) giveUpOrRetry(new Error(`Upstream request timed out after ${upstreamTimeoutMs}ms`))
      }, upstreamTimeoutMs)

      upstreamReq.on('response', (upstreamRes) => {
        // Confirmed live: Electron's net module can still deliver a 'response' event well
        // after the timeout already gave up on this exact attempt and answered res — the
        // origin was just slower than the timeout, not actually dead, and its real response
        // arrived anyway, just late. Without this guard, that late arrival tried to
        // res.writeHead() a second time on a response already ended, crashing the whole main
        // process with ERR_HTTP_HEADERS_SENT (an uncaught exception from a level below this
        // handler, per Electron's SimpleURLLoaderWrapper — same class of thing the global
        // uncaughtException handler exists for, but this one's cheap to prevent outright).
        if (settled) return
        gotResponse = true
        settled = true
        clearTimeout(timeout)

        // Failover bookkeeping on the answer itself. A portal that answered below 500 is
        // alive: a primary answer clears any cooldown (traffic returns to it at once), a
        // backup answer leaves the cooldown alone (it expires on its own). A 5xx is the
        // provider down in its most common clothing (a dying portal answers, badly): one
        // attempt at the OTHER portal before letting the status through, in either direction.
        // 4xx is deliberately NOT a failover trigger — an auth problem would fail identically
        // on both portals.
        if (primaryBase !== null && backupUrl && !failedOver && upstreamRes.statusCode >= 500) {
          upstreamRes.on('data', () => {}) // Drain the failed body — the other portal's answer is being waited on.
          failedOver = true
          if (!attemptOnBackup) {
            attemptOnBackup = true
            notePrimaryFailure(failoverState, primaryBase, Date.now())
            console.warn(
              `[proxy] primary ${target.host} answered ${upstreamRes.statusCode} — failing over to the backup portal`
            )
            attemptUpstream(backupUrl)
          } else {
            attemptOnBackup = false
            console.warn(
              `[proxy] backup ${backupUrl.host} answered ${upstreamRes.statusCode} — failing over to the primary portal`
            )
            attemptUpstream()
          }
          return
        }
        if (!attemptOnBackup && primaryBase !== null && upstreamRes.statusCode < 500) {
          notePrimarySuccess(failoverState, primaryBase)
        }

        // A refused segment (400/403) is, on providers with ~25s signed URLs, a signature that
        // expired mid-playlist — see the refused-segment retry block near the top of this
        // server. Try one refresh-retry before letting the refusal through: the player-side
        // handling (the remux-recovery ladder) remains the backstop for channels this cannot
        // save. The window lookup scans for the refused upstream URL — this attempt's own href,
        // whichever portal it is on — and a playlist fetch of its own (a 403 on the .m3u8 is an
        // auth problem no refresh fixes) never enters this path.
        const isPlaylistFetch = target.pathname.toLowerCase().endsWith('.m3u8')
        if (
          (upstreamRes.statusCode === 400 || upstreamRes.statusCode === 403) &&
          !isPlaylistFetch &&
          !retriedWithFreshSegment
        ) {
          const refusedUrl = attemptOnBackup && backupUrl ? backupUrl.href : target.href
          if (findWindowContaining(refusedUrl)) {
            upstreamRes.on('data', () => {}) // Drain the refusal body — it is of no use to anyone.
            retriedWithFreshSegment = true
            const refusedStatus = upstreamRes.statusCode
            const refusedThrough = (): void => {
              if (!res.headersSent) res.writeHead(refusedStatus)
              res.end()
            }
            freshSegmentUrlFor(refusedUrl)
              .then((freshUrl) => {
                if (!freshUrl) {
                  refusedThrough()
                  return
                }
                console.warn('[proxy] segment refused (signature expired?); retrying once with a fresh playlist URL')
                attemptUpstream(new URL(freshUrl))
              })
              .catch(refusedThrough)
            return
          }
        }

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
        // Only the /__fetch/ path (M3U profiles) needs the REWRITE below — see
        // rewriteM3u8ForProxy's own comment for why. The Xtream path (proxyTargetBase-relative)
        // doesn't have the same problem: a channel's own relative segment references there
        // already resolve correctly against this proxy's own origin, which is what
        // proxyTargetBase-relative resolution already targets. Both paths DO get their bodies
        // buffered now (small documents; the mpeg-ts guard keeps live TS away from the buffer),
        // because serving a playlist is where the refused-segment retry's window gets
        // remembered.
        //
        // Keyed strictly on the .m3u8 extension (the same signal isM3u8/getSourceUrl already
        // use throughout this app, e.g. Player.tsx/useHlsAttach.ts's own sourceUrl.endsWith
        // ('.m3u8') checks) rather than the response's content-type — confirmed live this
        // matters: a real server can (and this app's own m3u.ts-facing test fixture did) serve
        // the *outer*, application-level .m3u provider playlist with the exact same generic
        // audio/x-mpegurl content-type an actual .m3u8 media playlist uses. Rewriting that outer
        // file's own channel-entry lines here — before lib/m3uClient.ts's own parser ever sees
        // them — would store an already-/__fetch/-wrapped URL as if it were the raw channel URL,
        // which getStreamUrl() then wraps a second time, doubly-encoding it into something no
        // longer parseable at all. The outer .m3u is deliberately left completely untouched:
        // m3uClient.ts's own parser already resolves everything in it directly against the
        // real playlist URL, with no proxy involvement needed.
        const isFetchPlaylist = req.url?.startsWith('/__fetch/') && isPlaylistFetch
        // The .m3u8 extension used to imply the body is an HLS playlist, which is what
        // rewriteM3u8ForProxy below needs — but confirmed live 2026-09-26: this account's
        // provider moved to a panel that answers EVERY live stream URL with a raw MPEG-TS byte
        // stream (content-type video/mp2t), extension notwithstanding. Buffering one of those
        // "for rewriting" never finishes at all — a live TS stream has no end, so the playlist
        // request would hang until the client gave up (this is exactly what a transcode
        // fallback's ffmpeg, reading the same URL, would otherwise do) — and there are no URI
        // references to rewrite in binary media anyway. The response's content-type is the
        // discriminator: video/mp2t pipes through untouched (the consumer — hls.js failing
        // into its raw-stream fallback, or ffmpeg — sniffs the actual bytes), anything else
        // keeps the established rewrite behavior.
        const upstreamIsMpegTs = /^video\/mp2t\b/i.test(String(upstreamRes.headers['content-type'] ?? ''))
        if (isPlaylistFetch && !upstreamIsMpegTs) {
          const chunks: Buffer[] = []
          upstreamRes.on('data', (chunk) => chunks.push(chunk))
          upstreamRes.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8')
            const parsed = parsePlaylistWindow(body, target)
            if (parsed) {
              rememberPlaylistWindow(req.url ?? '', { ...parsed, upstreamHref: target.href })
            }
            res.end(isFetchPlaylist ? rewriteM3u8ForProxy(body, target) : body)
          })
        } else {
          upstreamRes.pipe(res)
        }
      })
      upstreamReq.on('error', giveUpOrRetry)
      // `.pipe()` only carries data forward — it does nothing when the *destination* goes
      // away, so a renderer that abandons a request mid-stream (a <video> element doing
      // `.removeAttribute('src'); .load()` to switch sources, a page navigating away) left
      // the upstream request to the real Xtream server running indefinitely with nothing
      // left to write to. Invisible on an unlimited-connections account, but fatal on one
      // capped at a single concurrent stream (confirmed via a real account's
      // get_server_info, max_connections: "1"): the old connection never actually released,
      // so a second legitimate request (e.g. this app's own ffmpeg transcode fallback,
      // moments later) had nothing to connect with and just hung. Aborting the upstream
      // request as soon as the client side closes — for any reason, not just success — is
      // what actually frees the slot. This used to call destroy() here, which turned out to
      // be exactly this same bug in a different shape: for a request that had followed even
      // one redirect, destroy() was a silent no-op (see the interface's own doc comment) — the
      // connection to the *redirect target* leaked instead, still occupying the account's one
      // slot, which is exactly what a real VOD title's stream URL (redirected to a CDN host)
      // hit live: the failed title never recovered, and every other request to the same
      // server — menus, other streams, all of it — was starved right along with it.
      res.on('close', () => {
        // Marking this settled (not just clearing the timeout) matters here specifically:
        // aborting upstreamReq below can itself emit 'error', and without this the client
        // having already disconnected wouldn't stop giveUpOrRetry from kicking off a pointless
        // retry — a fresh attemptUpstream() writing to a res nobody is listening to anymore.
        settled = true
        clearTimeout(timeout)
        upstreamReq.abort()
      })
      // GET/HEAD requests (everything this app ever proxies — Xtream auth is query-string
      // only, never a body) end `req` immediately with nothing written, so re-piping it into
      // a second `upstreamReq` on retry just ends that one too, correctly, with no body lost.
      // .pipe()'s target type is Node's full NodeJS.WritableStream — UpstreamClientRequest
      // deliberately only declares the handful of members this module actually calls, since a
      // GET/HEAD request never writes real data through this pipe anyway (both Electron's and
      // Node's own request types are genuinely full Writables at runtime regardless).
      req.pipe(upstreamReq as unknown as NodeJS.WritableStream)
    }

    req.on('error', (err) => console.error('[proxy] client request error:', err))
    if (backupFirst && backupUrl) {
      console.warn(
        `[proxy] ${primaryBase} is in failover cooldown — trying the backup portal ${backupUrl.host} first`
      )
      attemptOnBackup = true
      attemptUpstream(backupUrl)
      return
    }
    attemptUpstream()
  }

  return createServer((req, res) => {
    try {
      handleProxyRequest(req, res)
    } catch (err) {
      console.error('[proxy] unhandled error:', err)
      if (!res.headersSent) res.writeHead(502)
      res.end(`Proxy error: ${err instanceof Error ? err.stack || err.message : String(err)}`)
    }
  })
}
