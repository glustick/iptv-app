import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createGuideCache } from './guideCache'

// Exercised against a real temp directory: everything this module does that matters is the
// file-level pairing (payload + sidecar) and what a reader may trust, so an in-memory fake
// would test none of the behaviour the guide cache exists for.
describe('createGuideCache', () => {
  let dir: string
  let cache: ReturnType<typeof createGuideCache>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'guide-cache-test-'))
    cache = createGuideCache({ dir })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** The single sidecar file inside the cache dir — there is exactly one per key. */
  async function sidecarPath(): Promise<string> {
    const names = await readdir(dir)
    const sidecar = names.find((name) => name.endsWith('.json'))
    if (!sidecar) throw new Error('no sidecar was written')
    return join(dir, sidecar)
  }

  it('round-trips a payload with its fetch stamp', async () => {
    const before = Date.now()
    const { fetchedAt } = await cache.set('https://example.com/epg.xml', '<tv></tv>')
    expect(fetchedAt).toBeGreaterThanOrEqual(before)

    const got = await cache.get('https://example.com/epg.xml')
    expect(got).toEqual({ xml: '<tv></tv>', fetchedAt })

    const age = await cache.age('https://example.com/epg.xml')
    expect(age).not.toBeNull()
    expect(age!).toBeLessThan(5000)
  })

  it('keeps one entry per key, and a key that would be hostile as a filename still cannot escape', async () => {
    await cache.set('../../evil', 'A')
    await cache.set('https://example.com/epg.xml', 'B')

    expect(await cache.get('../../evil')).toMatchObject({ xml: 'A' })
    expect(await cache.get('https://example.com/epg.xml')).toMatchObject({ xml: 'B' })

    // Two entries -> exactly four files (two payloads, two sidecars), every name a hash plus
    // its known extension — nothing derived from the key itself reaches the filesystem.
    const names = await readdir(dir)
    expect(names).toHaveLength(4)
    for (const name of names) expect(name).toMatch(/^[0-9a-f]{64}\.(xml|json)$/)
  })

  it('misses when nothing was ever written', async () => {
    expect(await cache.get('https://example.com/epg.xml')).toBeNull()
    expect(await cache.age('https://example.com/epg.xml')).toBeNull()
  })

  it('treats a payload without its sidecar as absent — a half-written entry can never look fresh', async () => {
    await cache.set('https://example.com/epg.xml', '<tv></tv>')
    const names = await readdir(dir)
    // The state a write killed between the payload rename and the sidecar write leaves behind.
    await rm(join(dir, names.find((name) => name.endsWith('.json'))!))

    expect(await cache.get('https://example.com/epg.xml')).toBeNull()
    expect(await cache.age('https://example.com/epg.xml')).toBeNull()
  })

  it('treats a sidecar with no payload as a miss', async () => {
    await cache.set('https://example.com/epg.xml', '<tv></tv>')
    const names = await readdir(dir)
    await rm(join(dir, names.find((name) => name.endsWith('.xml'))!))

    expect(await cache.get('https://example.com/epg.xml')).toBeNull()
  })

  it('treats a corrupt sidecar as absent', async () => {
    await cache.set('https://example.com/epg.xml', '<tv></tv>')
    await writeFile(await sidecarPath(), 'not json{{{', 'utf8')

    expect(await cache.get('https://example.com/epg.xml')).toBeNull()
    expect(await cache.age('https://example.com/epg.xml')).toBeNull()
  })

  it('rejects nonsense stamps — zero, negative, non-numeric, and far-future ones', async () => {
    await cache.set('https://example.com/epg.xml', '<tv></tv>')
    const path = await sidecarPath()
    for (const fetchedAt of [0, -1, 'yesterday', Date.now() + 365 * 24 * 60 * 60 * 1000]) {
      await writeFile(path, JSON.stringify({ key: 'https://example.com/epg.xml', fetchedAt }), 'utf8')
      expect(await cache.get('https://example.com/epg.xml')).toBeNull()
      expect(await cache.age('https://example.com/epg.xml')).toBeNull()
    }
  })

  it('serves the real age of an old stamp, and normalizes a small future skew to zero', async () => {
    await cache.set('https://example.com/epg.xml', '<tv></tv>')
    const path = await sidecarPath()

    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000
    await writeFile(path, JSON.stringify({ key: 'https://example.com/epg.xml', fetchedAt: threeDaysAgo }), 'utf8')
    expect(await cache.get('https://example.com/epg.xml')).toMatchObject({ fetchedAt: threeDaysAgo })
    const age = await cache.age('https://example.com/epg.xml')
    expect(age!).toBeGreaterThanOrEqual(3 * 24 * 60 * 60 * 1000 - 1000)
    expect(age!).toBeLessThan(3 * 24 * 60 * 60 * 1000 + 60_000)

    // Inside the clock-skew allowance a future stamp is tolerated (an NTP correction can move
    // the clock back a little), but reads as "just written", not as a negative age.
    await writeFile(path, JSON.stringify({ key: 'https://example.com/epg.xml', fetchedAt: Date.now() + 60_000 }), 'utf8')
    expect(await cache.age('https://example.com/epg.xml')).toBe(0)
  })

  it('replaces the previous copy on a second write, leaving no temp files behind', async () => {
    await cache.set('https://example.com/epg.xml', 'first')
    await cache.set('https://example.com/epg.xml', 'second')

    expect(await cache.get('https://example.com/epg.xml')).toMatchObject({ xml: 'second' })
    const names = await readdir(dir)
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(names).toHaveLength(2)
  })
})
