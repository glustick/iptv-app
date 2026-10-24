import type { LiveStream } from './types'

// Identity for a live channel across playlists — the key the manual "Also on …" switch matches
// on (0.16.0, ported from the web sibling's lib/crossPlaylist.ts, itself ported from its
// server's playlists.ts; ported code-identical, tests and all). Deliberately NOT the stream id:
// ids are provider-scoped, so two playlists use different ids for the same channel and the same
// id for different ones. Normalised name plus category is what a human would match on.
//
// It is a match *heuristic*: a wrong match offers the wrong channel under "Also on" (one click,
// visibly labelled, immediately correctable), and a missed match merely offers nothing.

export function channelMatchKey(channel: { name: string; category?: string | null }): string {
  const normalise = (value: string): string =>
    value
      .toLowerCase()
      // Providers prefix the same channel differently on different lines ("UK: Sky Sports Main
      // Event" on one, "Sky Sports Main Event" on another), so a leading region tag is provider
      // furniture rather than part of the name.
      .replace(/^[a-z]{2,4}\s*:\s*/, '')
      .replace(/\b(uhd|fhd|hd|sd)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  return `${normalise(channel.name)}|${normalise(channel.category ?? '')}`
}

function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .replace(/^[a-z]{2,4}\s*:\s*/, '')
    .replace(/\b(uhd|fhd|hd|sd)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export interface AlsoOnCandidate {
  playlistId: string
  playlistName: string
  streamId: number
  name: string
  icon: string
  tvArchive: number
}

/**
 * Where else this channel lives: every OTHER connected playlist that carries a channel of the
 * same normalised name, ready to hand straight to the store's `play` (which routes the URL and
 * the account by the playlistId it is passed). `catalog` is the merged live catalogue
 * (`numericChannelCatalog`, every connected playlist's channels, each tagged with its
 * playlistId/playlistName — entries without a playlistId are primary).
 *
 * Matched on the NORMALISED NAME alone, not channelMatchKey's name+category pair: two providers
 * rarely spell a category the same way ("UK | Sports" vs "Sports"), and a category mismatch
 * would silently kill the offer in exactly the messy catalogues this switch exists for. The
 * failure mode of name-only matching is an occasional wrong offer under a visible label — one
 * click, immediately corrected — which beats a switch that is usually absent.
 *
 * First match per playlist wins (a provider listing the same name twice resolves to a stable
 * one). Stream ids stay provider-scoped throughout: candidates are keyed by playlist, never by
 * bare stream_id (the channelIdentity rule).
 */
export function findAlsoOnCandidates(
  channel: Pick<LiveStream, 'name' | 'playlistId'>,
  catalog: LiveStream[],
  primaryPlaylistId: string | null
): AlsoOnCandidate[] {
  const ownPlaylistId = channel.playlistId ?? primaryPlaylistId ?? ''
  const target = normaliseName(channel.name)
  if (target.length === 0) return []
  const byPlaylist = new Map<string, LiveStream>()
  for (const entry of catalog) {
    const entryPlaylistId = entry.playlistId ?? primaryPlaylistId ?? ''
    if (entryPlaylistId === ownPlaylistId) continue
    if (normaliseName(entry.name) !== target) continue
    if (!byPlaylist.has(entryPlaylistId)) byPlaylist.set(entryPlaylistId, entry)
  }
  return [...byPlaylist.entries()].map(([playlistId, entry]) => ({
    playlistId,
    playlistName: entry.playlistName ?? playlistId,
    streamId: entry.stream_id,
    name: entry.name,
    icon: entry.stream_icon ?? '',
    tvArchive: entry.tv_archive ?? 0
  }))
}
