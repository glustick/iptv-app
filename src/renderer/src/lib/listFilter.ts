/**
 * What the search box means when it filters a list (the web sibling's v0.94.0 rule: case- and
 * accent-insensitive, no request). Deliberately its own tiny normalizer rather than a reuse of
 * lib/epg.ts's matching normalizers: those are channel-identity rules that also drop noise tokens
 * and standalone numbers ("101 BBC One" → "bbc one"), which would make a user's literal search
 * for "101" match everything. A filter should do exactly what it says, and nothing clever.
 *
 * The split between foldListText and matchesFoldedQuery exists for the 24k-channel catalogue:
 * folding every name on every keystroke would pay an NFD normalization 24,000 times, so a name
 * that is already plain ASCII takes the cheap lowercase path. Only the accented minority fold.
 */

const ASCII_ONLY = /^[\x20-\x7E]*$/
const COMBINING_MARKS = /\p{M}/gu

/** Case- and accent-folded (café → cafe), with runs of whitespace collapsed. */
export function foldListText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whether this text contains the (already folded) query. An empty query matches everything —
 * callers use that to mean "no filter", and this keeps them from special-casing it twice.
 */
export function matchesFoldedQuery(text: string, foldedQuery: string): boolean {
  if (!foldedQuery) return true
  if (ASCII_ONLY.test(text)) return text.toLowerCase().includes(foldedQuery)
  return foldListText(text).includes(foldedQuery)
}
