/**
 * "I've seen this" — the explicit mark the app never had (0.23.0).
 *
 * Until now the app inferred watched-ness from progress (`isFinished`: 95%, or the credits window),
 * so a title could only be "watched" while its progress record still existed — and dismissing it
 * from Continue watching erased the only evidence. A mark is a different statement from a position:
 * a resume point is a place to come back to, a watched mark says there is nothing to come back for,
 * and one title can legitimately have had both (rewatching).
 *
 * Keys follow the app's existing progress namespace: `movie:<streamId>` for films, the bare episode
 * id for series episodes (the pre-0.18.0 shape, kept so nothing has to be migrated).
 */
export interface WatchedEntry {
  watchedAt: number
}

/** Oldest-first pruning, like transcodeMemory and the undecodable-video set. */
export const WATCHED_MAX_ENTRIES = 5000

export function watchedKey(kind: 'movie' | 'series', id: number | string): string {
  return kind === 'movie' ? `movie:${id}` : String(id)
}

export function isWatched(record: Record<string, WatchedEntry>, kind: 'movie' | 'series', id: number | string): boolean {
  return record[watchedKey(kind, id)] !== undefined
}

export function markWatched(
  record: Record<string, WatchedEntry>,
  kind: 'movie' | 'series',
  id: number | string,
  now: number = Date.now()
): Record<string, WatchedEntry> {
  return pruneWatched({ ...record, [watchedKey(kind, id)]: { watchedAt: now } })
}

export function unmarkWatched(
  record: Record<string, WatchedEntry>,
  kind: 'movie' | 'series',
  id: number | string
): Record<string, WatchedEntry> {
  const next = { ...record }
  delete next[watchedKey(kind, id)]
  return next
}

/** Keeps the newest entries when the map outgrows the cap; returns the same reference under it. */
export function pruneWatched(
  record: Record<string, WatchedEntry>,
  cap = WATCHED_MAX_ENTRIES
): Record<string, WatchedEntry> {
  const keys = Object.keys(record)
  if (keys.length <= cap) return record
  const newestFirst = keys.sort((a, b) => (record[b]?.watchedAt ?? 0) - (record[a]?.watchedAt ?? 0))
  const kept: Record<string, WatchedEntry> = {}
  for (const key of newestFirst.slice(0, cap)) kept[key] = record[key]
  return kept
}
