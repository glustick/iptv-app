import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server } from 'http'
import { EventEmitter } from 'events'
import { AddressInfo } from 'net'
import { createProxyServer, type ProxyServerDeps, type UpstreamClientRequest, type UpstreamResponse } from './proxyServer'

// Real Node http.request-backed stand-in for Electron's net.request, satisfying exactly the
// UpstreamClientRequest surface createProxyServer actually calls (see proxyServer.ts's own doc
// comment on why the real thing can't be used here — this app deliberately never runs against a
// plain Node http/https client in production, only Electron's net module). This is what lets
// createProxyServer's own retry/timeout/header/redirect logic be exercised against a genuine
// local HTTP server instead of a hand-rolled fake response object.
//
// Backed by a real EventEmitter (not a hand-rolled listener list) because createProxyServer
// pipes the client request into this object (req.pipe(upstreamReq)) — Node's own pipe()
// machinery subscribes to generic stream events ('drain', 'close', etc.) on the destination
// that have nothing to do with 'response'/'redirect'/'error', and a fake that only understood
// those three would crash the moment pipe() tried to listen for anything else.
function createNodeHttpUpstreamRequest(opts: { method: string | undefined; url: string }): UpstreamClientRequest {
  const emitter = new EventEmitter()
  let destroyed = false
  let pendingRedirectUrl: string | null = null
  let activeReq: ReturnType<typeof httpRequest> | null = null

  function issue(url: string): void {
    const req = httpRequest(url, { method: opts.method }, (res: IncomingMessage) => {
      const statusCode = res.statusCode ?? 0
      const location = res.headers.location
      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        pendingRedirectUrl = new URL(location, url).href
        emitter.emit('redirect', statusCode, opts.method ?? 'GET', pendingRedirectUrl)
        return
      }
      const upstreamRes: UpstreamResponse = {
        statusCode,
        headers: res.headers,
        pipe: (dest) => {
          res.pipe(dest)
        }
      }
      emitter.emit('response', upstreamRes)
    })
    req.on('error', (err) => emitter.emit('error', err))
    activeReq = req
    // Deferred rather than called inline: the real proxy calls setHeader() on the object this
    // function returns synchronously, right after construction — ending the request immediately
    // here would make that throw ("Can't set headers after they are sent"). By the time this
    // fires, the same-tick setHeader/on/pipe setup in attemptUpstream() has already run. Also
    // covers followRedirect()'s re-issue, which otherwise has nothing else to ever end() it
    // (the client request piped into the *original* upstreamReq only ever ends that one).
    process.nextTick(() => req.end())
  }

  issue(opts.url)

  return Object.assign(emitter, {
    setHeader: (name: string, value: string) => activeReq?.setHeader(name, value),
    followRedirect() {
      if (pendingRedirectUrl) issue(pendingRedirectUrl)
    },
    destroy() {
      destroyed = true
      activeReq?.destroy()
    },
    get destroyed() {
      return destroyed
    },
    // Pipe compatibility for req.pipe(upstreamReq) — every request this proxy ever issues is
    // GET/HEAD with nothing written, so these only need to exist, not do anything meaningful.
    write: () => true,
    end: () => activeReq?.end()
  }) as unknown as UpstreamClientRequest
}

function baseUrl(server: Server): string {
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function startMockOrigin(
  handler: (req: IncomingMessage, res: import('http').ServerResponse) => void
): Promise<{ url: string; server: Server }> {
  const server = createHttpServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: baseUrl(server), server }
}

function fetchViaProxy(
  proxyServer: Server,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {}
): Promise<{ statusCode: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${baseUrl(proxyServer)}${path}`,
      { method: init.method ?? 'GET', headers: init.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

function makeDeps(overrides: Partial<ProxyServerDeps> = {}): ProxyServerDeps {
  return {
    getProxyTargetBase: () => null,
    createUpstreamRequest: createNodeHttpUpstreamRequest,
    clearHostResolverCache: () => Promise.resolve(),
    isVpnConnected: () => false,
    getVpnTunneledHost: () => null,
    onOffTunnelRedirect: () => {},
    handleTranscodeRequest: () => {},
    ...overrides
  }
}

const openServers: Server[] = []

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  )
})

async function startProxy(deps: ProxyServerDeps): Promise<Server> {
  const server = createProxyServer(deps)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  openServers.push(server)
  return server
}

describe('createProxyServer', () => {
  it('proxies a request to the configured origin and stamps permissive CORS headers', async () => {
    const { url: originUrl, server: origin } = await startMockOrigin((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    openServers.push(origin)
    const proxy = await startProxy(makeDeps({ getProxyTargetBase: () => originUrl }))

    const res = await fetchViaProxy(proxy, '/player_api.php?action=get_live_categories')

    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(res.headers['access-control-allow-headers']).toBe('*')
    expect(res.body).toBe('{"ok":true}')
  })

  it('answers an OPTIONS preflight directly without touching the origin', async () => {
    const originHandler = vi.fn((_req: IncomingMessage, res: import('http').ServerResponse) => res.end())
    const { url: originUrl, server: origin } = await startMockOrigin(originHandler)
    openServers.push(origin)
    const proxy = await startProxy(makeDeps({ getProxyTargetBase: () => originUrl }))

    const res = await fetchViaProxy(proxy, '/anything', { method: 'OPTIONS' })

    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-methods']).toBe('*')
    expect(originHandler).not.toHaveBeenCalled()
  })

  it('returns 502 when no upstream server is configured yet', async () => {
    const proxy = await startProxy(makeDeps({ getProxyTargetBase: () => null }))

    const res = await fetchViaProxy(proxy, '/player_api.php')

    expect(res.statusCode).toBe(502)
    expect(res.body).toContain('No upstream Xtream server configured')
  })

  it('returns 502 instead of crashing on a malformed upstream base URL', async () => {
    const proxy = await startProxy(makeDeps({ getProxyTargetBase: () => 'not a url at all' }))

    const res = await fetchViaProxy(proxy, '/player_api.php')

    expect(res.statusCode).toBe(502)
    expect(res.body).toContain('Invalid Xtream server address')
  })

  it('forwards the Range header for video-seek support', async () => {
    let receivedRange: string | undefined
    const { url: originUrl, server: origin } = await startMockOrigin((req, res) => {
      receivedRange = req.headers.range
      res.writeHead(206)
      res.end('partial')
    })
    openServers.push(origin)
    const proxy = await startProxy(makeDeps({ getProxyTargetBase: () => originUrl }))

    await fetchViaProxy(proxy, '/movie.mp4', { headers: { range: 'bytes=10-20' } })

    expect(receivedRange).toBe('bytes=10-20')
  })

  it('strips content-encoding/content-length/CSP headers the origin sent', async () => {
    // content-length is deliberately correct for the real bytes written here — this test is
    // about the proxy unconditionally stripping the header (real gzip'd traffic makes the
    // *value* wrong, per the comment in proxyServer.ts, but a wrong value at the raw HTTP-
    // framing level this test operates at just hangs the client waiting for bytes that were
    // never coming, which isn't what's under test).
    const body = 'plain body, not actually gzipped'
    const { url: originUrl, server: origin } = await startMockOrigin((_req, res) => {
      res.writeHead(200, {
        'content-encoding': 'gzip',
        'content-length': String(Buffer.byteLength(body)),
        'content-security-policy': "default-src 'self'",
        'x-custom': 'kept'
      })
      res.end(body)
    })
    openServers.push(origin)
    const proxy = await startProxy(makeDeps({ getProxyTargetBase: () => originUrl }))

    const res = await fetchViaProxy(proxy, '/movie.mp4')

    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.headers['content-length']).toBeUndefined()
    expect(res.headers['content-security-policy']).toBeUndefined()
    expect(res.headers['x-custom']).toBe('kept')
  })

  it('routes /__transcode/ requests to handleTranscodeRequest instead of proxying', async () => {
    const handleTranscodeRequest = vi.fn((_url: string, res: import('http').ServerResponse) => {
      res.writeHead(200)
      res.end('segment data')
    })
    const proxy = await startProxy(makeDeps({ getProxyTargetBase: () => 'http://127.0.0.1:1', handleTranscodeRequest }))

    const res = await fetchViaProxy(proxy, '/__transcode/session-1/playlist.m3u8')

    expect(handleTranscodeRequest).toHaveBeenCalledTimes(1)
    expect(handleTranscodeRequest.mock.calls[0][0]).toBe('/__transcode/session-1/playlist.m3u8')
    expect(res.body).toBe('segment data')
  })

  describe('off-tunnel redirect detection', () => {
    it('reports a redirect that lands on a different host while the VPN is connected', async () => {
      const { url: originUrl, server: origin } = await startMockOrigin((req, res) => {
        if (req.url === '/start') {
          // Redirecting to "localhost" (a different hostname string than 127.0.0.1, even
          // though it resolves to the same loopback server) is what lets this test exercise a
          // genuine cross-host redirect without needing a second bindable loopback address.
          res.writeHead(302, { location: originUrl.replace('127.0.0.1', 'localhost') + '/final' })
          res.end()
        } else {
          res.writeHead(200)
          res.end('final content')
        }
      })
      openServers.push(origin)
      const onOffTunnelRedirect = vi.fn()
      const proxy = await startProxy(
        makeDeps({
          getProxyTargetBase: () => originUrl,
          isVpnConnected: () => true,
          getVpnTunneledHost: () => '127.0.0.1',
          onOffTunnelRedirect
        })
      )

      const res = await fetchViaProxy(proxy, '/start')

      expect(onOffTunnelRedirect).toHaveBeenCalledWith('127.0.0.1', 'localhost')
      // The redirect is still followed regardless — this is detection, not blocking.
      expect(res.body).toBe('final content')
    })

    it('does not report a redirect to the same tunneled host', async () => {
      const { url: originUrl, server: origin } = await startMockOrigin((req, res) => {
        if (req.url === '/start') {
          res.writeHead(302, { location: '/final' })
          res.end()
        } else {
          res.writeHead(200)
          res.end('final content')
        }
      })
      openServers.push(origin)
      const onOffTunnelRedirect = vi.fn()
      const proxy = await startProxy(
        makeDeps({
          getProxyTargetBase: () => originUrl,
          isVpnConnected: () => true,
          getVpnTunneledHost: () => '127.0.0.1',
          onOffTunnelRedirect
        })
      )

      await fetchViaProxy(proxy, '/start')

      expect(onOffTunnelRedirect).not.toHaveBeenCalled()
    })

    it('does not report anything while the VPN is not connected', async () => {
      const { url: originUrl, server: origin } = await startMockOrigin((req, res) => {
        if (req.url === '/start') {
          res.writeHead(302, { location: originUrl.replace('127.0.0.1', 'localhost') + '/final' })
          res.end()
        } else {
          res.writeHead(200)
          res.end('final content')
        }
      })
      openServers.push(origin)
      const onOffTunnelRedirect = vi.fn()
      const proxy = await startProxy(
        makeDeps({
          getProxyTargetBase: () => originUrl,
          isVpnConnected: () => false,
          getVpnTunneledHost: () => '127.0.0.1',
          onOffTunnelRedirect
        })
      )

      await fetchViaProxy(proxy, '/start')

      expect(onOffTunnelRedirect).not.toHaveBeenCalled()
    })
  })

  it('retries exactly once with a fresh request when the first attempt times out', async () => {
    let attempts = 0
    const { url: originUrl, server: origin } = await startMockOrigin((_req, res) => {
      attempts += 1
      if (attempts === 1) {
        // Never respond — simulates the real hang this timeout/retry logic exists for.
        return
      }
      res.writeHead(200)
      res.end('recovered on retry')
    })
    openServers.push(origin)
    const clearHostResolverCache = vi.fn(() => Promise.resolve())
    const proxy = await startProxy(
      makeDeps({ getProxyTargetBase: () => originUrl, clearHostResolverCache, upstreamTimeoutMs: 150 })
    )

    const res = await fetchViaProxy(proxy, '/slow')

    expect(attempts).toBe(2)
    expect(clearHostResolverCache).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('recovered on retry')
  })

  it('fails with a 502 after both attempts time out', async () => {
    const { url: originUrl, server: origin } = await startMockOrigin(() => {
      // Never respond, ever.
    })
    openServers.push(origin)
    const proxy = await startProxy(makeDeps({ getProxyTargetBase: () => originUrl, upstreamTimeoutMs: 100 }))

    const res = await fetchViaProxy(proxy, '/slow')

    expect(res.statusCode).toBe(502)
    expect(res.body).toContain('Upstream request failed')
  }, 10000)
})
