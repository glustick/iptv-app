import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
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
}

export interface ProxyServerDeps {
  // Swapped whenever the user connects to a (possibly different) profile — null before any
  // profile has connected yet.
  getProxyTargetBase: () => string | null
  // Electron's net.request in production (Chromium's network stack — see the comment on
  // createUpstreamRequest's call site in index.ts for why, not Node's http/https). Anything
  // satisfying UpstreamClientRequest works, which is what makes this testable without Electron.
  createUpstreamRequest: (opts: { method: string | undefined; url: string }) => UpstreamClientRequest
  // Electron's session.defaultSession.clearHostResolverCache() in production.
  clearHostResolverCache: () => Promise<void>
  isVpnConnected: () => boolean
  getVpnTunneledHost: () => string | null
  // Called whenever a redirect lands on a host other than getVpnTunneledHost()'s while the VPN
  // is connected — the caller owns deciding what to do with that (dedup, logging, IPC to the
  // renderer), this module only ever detects it.
  onOffTunnelRedirect: (tunneledHost: string, redirectHost: string) => void
  // The IP address actually written into the OS route for getVpnTunneledHost() (see
  // writeRouteScript in index.ts) — resolved once, at connect time, independent of Chromium's
  // own DNS resolution for this proxy's actual requests.
  getVpnTunneledIp: () => string | null
  // Node's dns.lookup in production — deliberately separate from Electron's own resolver (and
  // from clearHostResolverCache, which only clears Chromium's cache) so this reflects a genuinely
  // fresh, independent answer to compare against getVpnTunneledIp().
  resolveHostIp: (hostname: string) => Promise<string | null>
  // Called when a retry's fresh DNS lookup resolves the tunneled host to a different IP than
  // getVpnTunneledIp() — distinct from onOffTunnelRedirect: same hostname, different underlying
  // address, not a redirect at all, so the hostname-based check above can't catch it.
  onTunneledHostIpChanged: (tunneledHost: string, tunneledIp: string, resolvedIp: string) => void
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

    function attemptUpstream(): void {
      let upstreamReq: UpstreamClientRequest
      try {
        upstreamReq = deps.createUpstreamRequest({ method: req.method, url: target.href })
      } catch (err) {
        res.writeHead(502)
        res.end(`Could not reach upstream server: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      if (range) upstreamReq.setHeader('range', Array.isArray(range) ? range.join(', ') : range)

      upstreamReq.on('redirect', (_statusCode, _method, redirectUrl) => {
        if (deps.isVpnConnected()) {
          const tunneledHost = deps.getVpnTunneledHost()
          if (tunneledHost) {
            try {
              const redirectHost = new URL(redirectUrl).hostname.toLowerCase()
              if (redirectHost !== tunneledHost) {
                deps.onOffTunnelRedirect(tunneledHost, redirectHost)
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
            const tunneledHost = deps.getVpnTunneledHost()
            const tunneledIp = deps.getVpnTunneledIp()
            if (tunneledHost && tunneledIp && target.hostname.toLowerCase() === tunneledHost) {
              deps
                .resolveHostIp(target.hostname)
                .then((resolvedIp) => {
                  if (resolvedIp && resolvedIp !== tunneledIp) {
                    deps.onTunneledHostIpChanged(tunneledHost, tunneledIp, resolvedIp)
                  }
                })
                .catch(() => {})
            }
          }
          attemptUpstream()
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
