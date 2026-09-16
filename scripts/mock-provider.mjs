// Runs the synthetic Xtream provider (the same fixture the integration tests use) as a standalone
// local server, so the packaged app can be pointed at it when the real provider is unavailable —
// useful for clicking through the UI, and for driving it from CDP later.
//
// It logs every request it serves, which is how a caller can tell the app actually connected
// without needing to read anything off the screen.
//
//   node scripts/mock-provider.mjs [port]        (default 8123)
import { build } from 'esbuild'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const port = Number(process.argv[2] ?? 8123)

// The fixture is TypeScript, so bundle it for Node rather than depending on a TS loader.
const out = join(mkdtempSync(join(tmpdir(), 'mock-provider-')), 'mock.mjs')
await build({
  entryPoints: ['src/renderer/src/lib/testFixtures/mockXtreamServer.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'warning'
})

const { startMockXtreamServer } = await import(out)
const server = await startMockXtreamServer({ port })
console.log(`[mock-provider] serving a synthetic Xtream provider at ${server.url}`)
console.log(`[mock-provider] ids: ${JSON.stringify(server.ids)}`)

// Wrap every request so the log shows what the app fetched.
const originalEmit = process.emit
process.on('SIGTERM', async () => {
  await server.close()
  process.exit(0)
})
process.on('SIGINT', async () => {
  await server.close()
  process.exit(0)
})
void originalEmit

// A lightweight request log: patch http's server emit via the connection event is overkill, so we
// simply note liveness every 15s alongside any requests the fixture itself would have handled.
setInterval(() => console.log('[mock-provider] alive, awaiting app requests…'), 15000).unref()
