/**
 * Renderer-side access to the main process's guide cache — raw XML per source key with a
 * fetched-at stamp, so a launch inside the TTL parses the cached guide instead of refetching a
 * 16–107MB document (see ROADMAP and src/main/guideCache.ts for the file layout).
 *
 * Everything here is best-effort: the cache must never be able to break a guide load, and this
 * store's tests run in plain Node where `window` does not exist at all (see logGuideTiming's
 * own note in useAppStore) — every entry point degrades to "no cache" rather than throwing.
 */

/**
 * "Once a day", as the owner decided: a rolling 24 h window, not the first launch of each
 * calendar day — someone who opens the app every evening would otherwise never once get the
 * benefit of the cache.
 */
export const GUIDE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export interface CachedGuide {
  xml: string
  fetchedAt: number
}

/** Whether a cached copy is inside its TTL — i.e. a load may use it without refetching. */
export function isGuideCacheFresh(fetchedAt: number): boolean {
  return Date.now() - fetchedAt < GUIDE_CACHE_TTL_MS
}

/** The cached copy for a key, or null when there is nothing trustworthy to use. */
export async function readCachedGuide(key: string | null): Promise<CachedGuide | null> {
  if (!key || typeof window === 'undefined') return null
  try {
    return (await window.api?.cache?.get(key)) ?? null
  } catch {
    return null
  }
}

/**
 * Writes a fetched payload and returns the fetched-at stamp the cache recorded — main owns the
 * clock for this, so the TTL and the UI's "last updated" line both read the same value. When
 * the cache is unavailable the local clock stands in: the in-memory stamp is still true, only
 * the on-disk copy is missing (the next launch simply refetches).
 */
export async function writeCachedGuide(key: string | null, xml: string): Promise<number> {
  if (!key || typeof window === 'undefined') return Date.now()
  try {
    const { fetchedAt } = await window.api.cache.set(key, xml)
    return fetchedAt
  } catch (err) {
    console.warn('[guide-cache] failed to write the cached guide:', err)
    return Date.now()
  }
}

/**
 * Age in ms of the key's on-disk stamp, or null when there is no cached copy. Sidecar-only —
 * reading this never touches the payload, which is exactly what the Guide page's "last updated"
 * line needs.
 */
export async function cachedGuideAge(key: string | null): Promise<number | null> {
  if (!key || typeof window === 'undefined') return null
  try {
    return (await window.api?.cache?.age(key)) ?? null
  } catch {
    return null
  }
}
