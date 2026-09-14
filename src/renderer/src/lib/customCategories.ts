/**
 * Pure list helpers behind "My Categories" — kept out of the store (and unit-tested) because the
 * drag-and-drop reorder in particular is easy to get subtly wrong at the edges (dropping onto
 * itself, dropping past the end, reordering the last item).
 */

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
export function addStreamIds(current: number[], toAdd: number[]): number[] {
  const seen = new Set(current)
  const next = [...current]
  for (const id of toAdd) {
    if (seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  return next
}

/** Removes one stream id, returning a new array (and the original when it wasn't present). */
export function removeStreamId(current: number[], streamId: number): number[] {
  if (!current.includes(streamId)) return current
  return current.filter((id) => id !== streamId)
}
