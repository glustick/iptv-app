import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'

/**
 * The on-disk guide cache: one entry per source key, each entry a pair of files —
 * `<hash>.xml` holding the guide exactly as fetched, and `<hash>.json` a small sidecar carrying
 * the key and when it was fetched.
 *
 * Two deliberate properties, both load-bearing:
 *
 * - **The sidecar is the freshness record.** The payload is renamed into place first and the
 *   sidecar second, so a payload without a sidecar can only be a write that never completed —
 *   and a read that finds no trustworthy sidecar treats the entry as absent. A half-written
 *   107MB payload therefore cannot look fresh to the TTL that reads this stamp.
 * - **The key is hashed, not used as a filename.** Source keys are URLs — arbitrary characters
 *   and lengths, `..` segments included — so hashing is what keeps a key from ever escaping the
 *   cache directory. The original key lives in the sidecar for debugging.
 *
 * Electron-free by design (the same factory-injection convention as the other main-process
 * services), so its tests can run it against a real temp directory — see guideCache.test.ts.
 */

/**
 * A `fetchedAt` further in the future than this can only be a bad clock or a hand-edited file —
 * rejecting it makes the entry refetch rather than read as "fresh" until the clock catches up.
 * Five minutes covers ordinary NTP corrections.
 */
const FUTURE_STAMP_ALLOWANCE_MS = 5 * 60 * 1000

export interface GuideCacheEntry {
  xml: string
  fetchedAt: number
}

export function createGuideCache(deps: { dir: string }) {
  const baseNameFor = (key: string): string => createHash('sha256').update(key).digest('hex')
  const payloadPathFor = (key: string): string => join(deps.dir, `${baseNameFor(key)}.xml`)
  const sidecarPathFor = (key: string): string => join(deps.dir, `${baseNameFor(key)}.json`)

  /** The fetch stamp from this key's sidecar, or null when there is no trustworthy one. */
  async function readStamp(key: string): Promise<number | null> {
    const raw = await readFile(sidecarPathFor(key), 'utf8').catch(() => null)
    if (raw === null) return null
    try {
      const { fetchedAt } = JSON.parse(raw) as { fetchedAt?: unknown }
      if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt) || fetchedAt <= 0) return null
      if (fetchedAt > Date.now() + FUTURE_STAMP_ALLOWANCE_MS) return null
      return fetchedAt
    } catch {
      return null
    }
  }

  /**
   * Writes through a unique temp file in the same directory, then renames — rename is atomic
   * within a filesystem, so a reader only ever sees a complete payload or the previous one,
   * never a torn write.
   */
  async function writeAtomic(path: string, data: string): Promise<void> {
    const tmpPath = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(tmpPath, data, 'utf8')
      await rename(tmpPath, path)
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {})
      throw err
    }
  }

  /** A write killed between its temp file and its rename leaves that temp file orphaned; sweep
   * this key's leftovers so repeated failures can't accumulate them forever. Best-effort —
   * failing to clean up must never fail a write that just succeeded. */
  async function sweepTempFiles(baseName: string): Promise<void> {
    const entries = await readdir(deps.dir)
    await Promise.all(
      entries
        .filter((name) => name.startsWith(`${baseName}.`) && name.endsWith('.tmp'))
        .map((name) => rm(join(deps.dir, name), { force: true }).catch(() => {}))
    )
  }

  return {
    /** The cached payload and its stamp, or null when this key has nothing trustworthy. */
    async get(key: string): Promise<GuideCacheEntry | null> {
      // Sidecar first: with no usable stamp there is nothing to trust, so the (potentially
      // 107MB) payload read is skipped entirely rather than reading a file that would be
      // discarded.
      const fetchedAt = await readStamp(key)
      if (fetchedAt === null) return null
      const xml = await readFile(payloadPathFor(key), 'utf8').catch(() => null)
      if (xml === null || xml.length === 0) return null
      return { xml, fetchedAt }
    },

    /** Writes the payload + sidecar pair in that order (see the module comment) and returns the
     * stamp recorded, so the caller's TTL and the UI can read the very same value. */
    async set(key: string, xml: string): Promise<{ fetchedAt: number }> {
      await mkdir(deps.dir, { recursive: true })
      const fetchedAt = Date.now()
      await writeAtomic(payloadPathFor(key), xml)
      await writeAtomic(sidecarPathFor(key), JSON.stringify({ key, fetchedAt }))
      await sweepTempFiles(baseNameFor(key)).catch(() => {})
      return { fetchedAt }
    },

    /** Age of the stamp in ms, or null. Sidecar-only by design: the Guide page's "last updated"
     * line asks for this without paying for a payload read. */
    async age(key: string): Promise<number | null> {
      const fetchedAt = await readStamp(key)
      if (fetchedAt === null) return null
      // A stamp slightly in the future (clock skew within the allowance) reads as zero age,
      // never as a negative one.
      return Math.max(0, Date.now() - fetchedAt)
    }
  }
}
