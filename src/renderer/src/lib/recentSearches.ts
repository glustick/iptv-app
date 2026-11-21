/**
 * Recent programme searches (0.33.0) — the last five queries this device acted on, in the same
 * per-device localStorage idiom as the 0.19.0 list-order key. Recorded ONLY when a result was
 * acted on (played or reminded — Enter on a hit or the bell on an upcoming one), never on
 * keystrokes: a chip is an intent worth repeating, not every half-typed query.
 */

export const RECENT_PROGRAMME_SEARCHES_KEY = 'allisoniptv-recent-programme-searches'

export const MAX_RECENT_SEARCHES = 5

// Storage is a structural parameter (not window.localStorage directly) so tests and any future
// non-browser surface can supply their own; corrupt or blocked storage degrades to "no recents".
type ReadableStorage = { getItem(key: string): string | null }
type WritableStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void }

function parseList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string').slice(0, MAX_RECENT_SEARCHES)
  } catch {
    return []
  }
}

export function loadRecentSearches(storage: ReadableStorage): string[] {
  try {
    return parseList(storage.getItem(RECENT_PROGRAMME_SEARCHES_KEY))
  } catch {
    return []
  }
}

/**
 * Record a query that was acted on: trimmed, ignored when empty, moved to the front if it is
 * already somewhere in the list (a repeat is still the most recent intent), capped at five —
 * the chip row is one line, and older-than-five intent is stale anyway. Returns the new list.
 */
export function recordRecentSearch(query: string, storage: WritableStorage): string[] {
  const trimmed = query.trim()
  if (!trimmed) return loadRecentSearches(storage)
  const next = [trimmed, ...loadRecentSearches(storage).filter((item) => item !== trimmed)].slice(
    0,
    MAX_RECENT_SEARCHES
  )
  try {
    storage.setItem(RECENT_PROGRAMME_SEARCHES_KEY, JSON.stringify(next))
  } catch {
    // A blocked storage surface must not take the palette down with it; this session keeps the
    // list in memory, the next one simply starts fresh.
  }
  return next
}
