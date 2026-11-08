import { foldListText } from './listFilter'
import type { SeriesItem, VodStream } from './types'

/**
 * How a catalogue list is ordered — the web sibling's v0.94.0 film/series ordering, brought to
 * the desktop. Per device and per kind, in localStorage for the same reason the quality ceiling
 * lives there: it is a habit of the person browsing this machine, not a property of the account.
 *
 * Applied only to a catalogue list (Movies, Series). Favourites and History keep their own
 * orders — the order is what makes those lists useful (most recent first, or a hand-built
 * grouping), and re-sorting them by name would take that away.
 */
export type ListOrder = 'provider' | 'az' | 'newest'

export type ListOrderKind = 'movie' | 'series'

export function listOrderOptions(kind: ListOrderKind): { value: ListOrder; label: string }[] {
  return [
    { value: 'provider', label: 'Provider order' },
    { value: 'az', label: 'A–Z' },
    // Deliberately different words for the two kinds: a film's catalogue date is when the
    // provider added it, while a show's is its release date. Calling both "newest" would claim
    // they mean the same thing.
    { value: 'newest', label: kind === 'movie' ? 'Newest added' : 'Newest release' }
  ]
}

const STORAGE_PREFIX = 'allisoniptv-list-order-'

function storageKey(kind: ListOrderKind): string {
  return `${STORAGE_PREFIX}${kind}`
}

function isValidListOrder(value: unknown): value is ListOrder {
  return value === 'provider' || value === 'az' || value === 'newest'
}

export function loadListOrder(kind: ListOrderKind): ListOrder {
  try {
    const raw = window.localStorage.getItem(storageKey(kind))
    if (raw === null) return 'provider'
    const parsed: unknown = JSON.parse(raw)
    return isValidListOrder(parsed) ? parsed : 'provider'
  } catch {
    return 'provider'
  }
}

export function saveListOrder(kind: ListOrderKind, order: ListOrder): void {
  try {
    // Absence is the default — the same rule qualityPref follows, so "provider order" can never
    // be stored as a value that a future default has to argue with.
    if (order === 'provider') window.localStorage.removeItem(storageKey(kind))
    else window.localStorage.setItem(storageKey(kind), JSON.stringify(order))
  } catch {
    // A blocked storage surface must not take browsing down with it; the order just does not
    // persist.
  }
}

/**
 * A provider's date as epoch milliseconds, or null when it is absent or nonsense.
 *
 * Xtream panels spell this three ways in practice: a unix timestamp in seconds as a string
 * ("1621234567"), milliseconds, or a date string ("2023-05-01 12:00:00"). Anything unparseable
 * sorts last rather than pretending to be 1970 — a title with no date is not the oldest film ever
 * made, it is a title whose date this panel did not send.
 */
export function parseProviderTimestamp(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    return value > 1e12 ? value : value * 1000
  }
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) {
    const asNumber = Number(trimmed)
    if (!Number.isFinite(asNumber) || asNumber <= 0) return null
    return asNumber > 1e12 ? asNumber : asNumber * 1000
  }
  const parsed = Date.parse(trimmed) || Date.parse(trimmed.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : null
}

function sortByOrder<T>(
  items: T[],
  order: ListOrder,
  name: (item: T) => string,
  timestamp: (item: T) => string | number | null | undefined
): T[] {
  // Provider order is the array the provider sent — returned as-is, not copied, so "no ordering"
  // costs nothing and cannot quietly reorder anything.
  if (order === 'provider') return items
  // The sort key is computed once per title, not once per comparison: on a 10,000-film category
  // an on-demand fold would run ~140,000 normalizations instead of 10,000.
  if (order === 'az') {
    const decorated = items.map((item, index) => ({ item, index, key: foldListText(name(item)) }))
    decorated.sort((a, b) => {
      if (a.key < b.key) return -1
      if (a.key > b.key) return 1
      return a.index - b.index
    })
    return decorated.map((entry) => entry.item)
  }
  const decorated = items.map((item, index) => ({ item, index, key: parseProviderTimestamp(timestamp(item)) }))
  decorated.sort((a, b) => {
    if (a.key === null && b.key === null) return a.index - b.index
    if (a.key === null) return 1
    if (b.key === null) return -1
    if (a.key !== b.key) return b.key - a.key
    return a.index - b.index
  })
  return decorated.map((entry) => entry.item)
}

export function sortVodStreams(items: VodStream[], order: ListOrder): VodStream[] {
  return sortByOrder(items, order, (item) => item.name, (item) => item.added)
}

export function sortSeries(items: SeriesItem[], order: ListOrder): SeriesItem[] {
  return sortByOrder(items, order, (item) => item.name, (item) => item.releaseDate)
}
