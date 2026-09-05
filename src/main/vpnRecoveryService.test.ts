import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'net'
import { connect as netConnect } from 'net'
import { createVpnRecoveryService, type VpnRecoveryService, type VpnRecoveryStore } from './vpnRecoveryService'

function fakeStore(initial?: Record<string, unknown>): VpnRecoveryStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial }
  return {
    data,
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
    },
    delete: (key) => {
      delete data[key]
    }
  }
}

function makeService(
  store: VpnRecoveryStore,
  removedDirs: string[],
  terminateTimeoutMs = 300
): VpnRecoveryService {
  return createVpnRecoveryService({
    store,
    connect: (opts, onConnect) => netConnect(opts, onConnect),
    removeDir: async (path) => {
      removedDirs.push(path)
    },
    terminateTimeoutMs
  })
}

function findFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

const activeServers: Server[] = []
afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('createVpnRecoveryService', () => {
  it('recordSession stores exactly what it was given, retrievable via the same key clearSession removes', () => {
    const store = fakeStore()
    const service = makeService(store, [])
    service.recordSession({ managementPort: 1234, tempDir: '/tmp/example' })
    expect(store.data['__vpnOrphanRecovery']).toEqual({ managementPort: 1234, tempDir: '/tmp/example' })
    service.clearSession()
    expect(store.data['__vpnOrphanRecovery']).toBeUndefined()
  })

  it('terminateOrphanedSession is a no-op when nothing was ever recorded', async () => {
    const store = fakeStore()
    const removedDirs: string[] = []
    const service = makeService(store, removedDirs)
    await service.terminateOrphanedSession()
    expect(removedDirs).toEqual([])
  })

  it('terminateOrphanedSession sends SIGTERM to a real listening management port, then cleans up once it closes', async () => {
    const receivedCommands: string[] = []
    const server = createServer((socket) => {
      socket.on('data', (chunk) => {
        receivedCommands.push(chunk.toString('utf8'))
        // Real OpenVPN closes the management connection once it's told to shut down —
        // mirroring that is what lets terminateOrphanedSession's 'close' handler resolve
        // instead of falling through to its timeout fallback.
        socket.end()
      })
    })
    activeServers.push(server)
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })

    const store = fakeStore({ __vpnOrphanRecovery: { managementPort: port, tempDir: '/tmp/orphaned-session' } })
    const removedDirs: string[] = []
    const service = makeService(store, removedDirs)

    await service.terminateOrphanedSession()

    expect(receivedCommands.join('')).toContain('signal SIGTERM')
    expect(removedDirs).toEqual(['/tmp/orphaned-session'])
    expect(store.data['__vpnOrphanRecovery']).toBeUndefined()
  })

  it('terminateOrphanedSession still cleans up when nothing is listening on the recorded port', async () => {
    // A real free port with nothing bound to it — exactly what a previous session that already
    // shut down cleanly (or never actually got OpenVPN running) leaves behind.
    const freePort = await findFreeLocalPort()
    const store = fakeStore({ __vpnOrphanRecovery: { managementPort: freePort, tempDir: '/tmp/never-started' } })
    const removedDirs: string[] = []
    const service = makeService(store, removedDirs)

    await service.terminateOrphanedSession()

    expect(removedDirs).toEqual(['/tmp/never-started'])
    expect(store.data['__vpnOrphanRecovery']).toBeUndefined()
  })

  it('terminateOrphanedSession falls back to its timeout if the daemon accepts the connection but never closes it', async () => {
    const server = createServer((socket) => {
      // Accepts the connection and receives the signal, same as a real daemon, but never closes
      // its end — simulating a wedged/unresponsive process rather than a clean shutdown.
      socket.on('data', () => {})
    })
    activeServers.push(server)
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })

    const store = fakeStore({ __vpnOrphanRecovery: { managementPort: port, tempDir: '/tmp/wedged-session' } })
    const removedDirs: string[] = []
    const service = makeService(store, removedDirs, 200)

    const start = Date.now()
    await service.terminateOrphanedSession()
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(190)
    expect(removedDirs).toEqual(['/tmp/wedged-session'])
    expect(store.data['__vpnOrphanRecovery']).toBeUndefined()
  })
})
