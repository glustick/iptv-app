/**
 * One search across everything the app has loaded (0.24.0).
 *
 * The app already filters each list separately — the channel list, the film grid, the guide — but
 * there was no way to type a name and be taken to it regardless of which tab it lives on. This is
 * that: the catalogues are already in memory, so the whole thing is a filter, not a request.
 *
 * Ranking is deliberately simple and explainable: an entry whose name *starts* with the query comes
 * first, then one where a word starts with it ("sports" → "Sky Sports"), then any substring. Ties
 * keep the catalogue's own order, because re-sorting by anything else would make the list move
 * under the cursor for reasons nobody can see.
 */
export type SearchKind = 'live' | 'movie' | 'series'

export interface SearchEntry {
  kind: SearchKind
  id: number
  name: string
  /** Secondary line: category, rating, year — whatever the catalogue already carries. */
  note?: string
  /** Needed to play a film; absent for live and series. */
  extension?: string
  icon?: string
}

export interface SearchHit extends SearchEntry {
  /** 3 = name starts with the query, 2 = a word does, 1 = substring. */
  score: number
}

const KIND_ORDER: Record<SearchKind, number> = { live: 0, movie: 1, series: 2 }

export function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function scoreName(name: string, needle: string): number {
  const folded = foldForSearch(name)
  if (!folded) return 0
  if (folded.startsWith(needle)) return 3
  // A word boundary: "sports" matches "Sky Sports", "101 BBC One" matches "bbc".
  if (folded.split(/[^a-z0-9]+/).some((word) => word.startsWith(needle))) return 2
  return folded.includes(needle) ? 1 : 0
}

export function searchAll(entries: SearchEntry[], query: string, limit = 40): SearchHit[] {
  const needle = foldForSearch(query)
  if (needle.length < 2) return []
  const hits: SearchHit[] = []
  for (const entry of entries) {
    const score = scoreName(entry.name, needle)
    if (score > 0) hits.push({ ...entry, score })
  }
  hits.sort((a, b) => b.score - a.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name))
  return hits.slice(0, Math.max(0, limit))
}

/** How many of each kind are in a result set — used for the palette's section counts. */
export function countByKind(hits: SearchHit[]): Record<SearchKind, number> {
  return {
    live: hits.filter((hit) => hit.kind === 'live').length,
    movie: hits.filter((hit) => hit.kind === 'movie').length,
    series: hits.filter((hit) => hit.kind === 'series').length
  }
}
