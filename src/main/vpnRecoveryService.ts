/**
 * Recovers from OpenVPN outliving a previous run of this app entirely. startVpn (index.ts) spawns
 * OpenVPN detached/daemonized — deliberately less standing privilege than a persistent root-level
 * daemon (see index.ts's own comment on that tradeoff) — but it also means the OpenVPN process is
 * never a child of Electron's own process tree, so Electron dying without a clean shutdown (a
 * crash, or a force-quit that skips the normal before-quit handler entirely) leaves the tunnel
 * running with nothing left to use it.
 *
 * The fix is the same trick index.ts's own stopVpn() already uses for a connection *this* process
 * started: OpenVPN's management interface is a plain, unprivileged local TCP socket, and asking an
 * already-root-owned process to shut itself down over it needs no elevated privilege at all — only
 * *starting* one does. recordSession persists just enough (the management port, and the temp
 * directory to clean up afterward) to reconnect to that same socket from a completely fresh
 * process next launch, in terminateOrphanedSession.
 *
 * Safe to call unconditionally on every launch only because index.ts pairs this with
 * requestSingleInstanceLock: without that, a second concurrently running instance would find the
 * first instance's own perfectly legitimate, still-in-use session here and tear it down out from
 * under it, having no way to distinguish "abandoned by a process that's gone" from "actively owned
 * by a process that's still running." With it, any session found here can only be a genuine
 * orphan, and the common case (no VPN was ever connected, or it shut down cleanly last time)
 * resolves instantly since there's simply no recorded session to act on.
 */

export interface VpnRecoverySession {
  managementPort: number
  tempDir: string
}

// The subset of electron-store's own interface this module actually needs — kept local (not
// imported from 'electron-store') so this file has no Electron dependency and can be unit-tested
// against a plain in-memory fake instead, the same reasoning proxyServer.ts's own
// UpstreamClientRequest documents for the identical pattern.
export interface VpnRecoveryStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
}

// The subset of node:net's Socket this module actually needs, for the same reason.
export interface VpnRecoverySocket {
  write(data: string): void
  on(event: 'error', listener: () => void): void
  on(event: 'close', listener: () => void): void
  destroy(): void
}

export interface VpnRecoveryServiceDeps {
  store: VpnRecoveryStore
  // net.connect(opts, onConnect) in production — takes the connect callback directly (rather
  // than requiring the caller to attach a 'connect' listener separately) to mirror how
  // index.ts's own connectManagementInterface already calls net.connect.
  connect: (opts: { host: string; port: number }, onConnect: () => void) => VpnRecoverySocket
  // fs/promises' rm(path, { recursive: true, force: true }) in production, already pre-bound to
  // those options — this module only ever removes its own whole temp directory, never anything
  // more granular, so there's nothing for a caller-supplied options object to actually vary.
  removeDir: (path: string) => Promise<void>
  // How long to wait for OpenVPN to acknowledge the shutdown signal and close the socket before
  // giving up and cleaning up anyway — overridable purely so a test doesn't have to wait out the
  // real production value.
  terminateTimeoutMs?: number
}

export interface VpnRecoveryService {
  recordSession(session: VpnRecoverySession): void
  clearSession(): void
  terminateOrphanedSession(): Promise<void>
}

const STORE_KEY = '__vpnOrphanRecovery'
const DEFAULT_TERMINATE_TIMEOUT_MS = 3000

export function createVpnRecoveryService(deps: VpnRecoveryServiceDeps): VpnRecoveryService {
  const terminateTimeoutMs = deps.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS

  function recordSession(session: VpnRecoverySession): void {
    deps.store.set(STORE_KEY, session)
  }

  function clearSession(): void {
    deps.store.delete(STORE_KEY)
  }

  async function terminateOrphanedSession(): Promise<void> {
    const session = deps.store.get(STORE_KEY) as VpnRecoverySession | undefined
    if (!session) return
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeoutHandle)
        resolve()
      }
      const socket = deps.connect({ host: '127.0.0.1', port: session.managementPort }, () => {
        socket.write('signal SIGTERM\n')
      })
      socket.on('error', () => {
        // Nothing listening on this port anymore — the previous session already shut down
        // cleanly by some other means, or never actually got OpenVPN running in the first place.
        socket.destroy()
        finish()
      })
      socket.on('close', finish)
      // Guards against a daemon that's up but wedged/unresponsive — this is best-effort recovery
      // at launch, not something worth blocking app startup over indefinitely. Destroying the
      // socket here (not just resolving) matters even though we're moving on regardless: an
      // un-destroyed socket is a real leaked connection, confirmed live by a test server whose
      // own close() never completed while one of these sat open against it.
      const timeoutHandle = setTimeout(() => {
        socket.destroy()
        finish()
      }, terminateTimeoutMs)
    })
    await deps.removeDir(session.tempDir).catch(() => {})
    clearSession()
  }

  return { recordSession, clearSession, terminateOrphanedSession }
}
