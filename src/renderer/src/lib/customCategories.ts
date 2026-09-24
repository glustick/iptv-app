/**
 * Pure list helpers behind "My Categories" — kept out of the store (and unit-tested) because the
 * drag-and-drop reorder in particular is easy to get subtly wrong at the edges (dropping onto
 * itself, dropping past the end, reordering the last item).
 */

/**
 * One membership entry in a custom category: a plain stream id, or — for a channel belonging to a
 * playlist other than the primary — a qualified `playlist:id` key (see lib/channelIdentity).
 * Movies and series only ever come from the primary playlist, so their entries stay numeric.
 */
export type StreamEntry = number | string

/**
 * Moves one item within a list, returning a NEW array. Out-of-range indices are clamped rather
 * than throwing: the drag-and-drop callers derive them from DOM event targets, and a dropped
 * index landing one past the end is normal (dropping below the last row) rather than an error.
 * A move that would be a no-op returns the original array unchanged, so React can skip a
 * re-render on a drag that ended where it started.
 */
export function moveItem<T>(list: T[], fromIndex: number, toIndex: number): T[] {
  if (list.length < 2) return list
  const from = Math.max(0, Math.min(fromIndex, list.length - 1))
  const to = Math.max(0, Math.min(toIndex, list.length - 1))
  if (from === to) return list
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * Appends stream ids not already present, preserving both the existing order and the order the
 * caller supplied. Deduplication matters because the same channel can be offered by more than one
 * provider category, and adding it twice would render it twice in the grid.
 */
export function addStreamIds(current: StreamEntry[], toAdd: StreamEntry[]): StreamEntry[] {
  // Compared as strings: the same channel can be represented as `42` (a primary-playlist channel,
  // the shape every entry written before multi-playlist has) or `'provider:42'`, and a set keyed by
  // the raw value would treat `42` and `'42'` as two different channels.
  const seen = new Set(current.map(String))
  const next = [...current]
  for (const id of toAdd) {
    if (seen.has(String(id))) continue
    seen.add(String(id))
    next.push(id)
  }
  return next
}

/**
 * A category's kind, with the "undefined means live" rule in one place — every category saved
 * before movies/series groupings existed has no `kind` field at all, and treating those as
 * anything other than live would orphan the user's existing setup.
 */
export function kindOf(category: { kind?: string } | undefined): 'live' | 'movie' | 'series' {
  const kind = category?.kind
  return kind === 'movie' || kind === 'series' ? kind : 'live'
}

/** Removes one membership entry, returning a new array (and the original when it wasn't
 * present). String comparison for the same reason as addStreamIds. */
export function removeStreamId(current: StreamEntry[], entry: StreamEntry): StreamEntry[] {
  const wanted = String(entry)
  if (!current.some((id) => String(id) === wanted)) return current
  return current.filter((id) => String(id) !== wanted)
}
