/**
 * Keys and source matching for the remembered transcode outcome — AppSettings.transcodeMemory,
 * shape in TranscodeMemoryEntry (./types).
 *
 * Why a key function rather than a bare id: what a channel/title needs transcoded is a property
 * of the source itself, and the three catalogs identify sources differently. Live channels must
 * follow lib/channelIdentity's playlist-aware rule (two providers' channel 42 are unrelated, and
 * a remembered fix following the wrong one would remux the wrong stream), while movies and
 * series episodes need their own namespaces so they cannot collide with a live key inside the
 * one shared Record.
 *
 * Why host+pathname matching rather than exact URL equality: provider stream URLs rotate their
 * token between opens (and append session/expiry query parameters), so an exactly-matched entry
 * would work once and then silently stop applying — the one failure this memory exists to avoid.
 * Host + pathname stay stable across a rotation and identify the same stream.
 *
 * Pure and dependency-free, like the rest of lib/ (see STATE.md's direction note).
 */

import { channelKey } from './channelIdentity'

/**
 * The storage key for one channel/title's remembered transcode outcome.
 *
 * Live goes through channelKey unchanged — deliberately not reimplemented here, because every
 * per-channel record in this app shares that one rule. Movies and series episodes only ever come
 * from the primary playlist (the one that carries the non-live surfaces), so they need no
 * playlist dimension; the prefixes cannot collide with a qualified live key either, since
 * playlist ids are generated uuids, never the literal words "movie"/"series".
 */
export function transcodeMemoryKey(
  ref:
    | { kind: 'live'; playlistId?: string | null; streamId: number; primaryPlaylistId?: string | null }
    | { kind: 'movie'; streamId: number }
    | { kind: 'series'; episodeId: string }
): string {
  switch (ref.kind) {
    case 'live':
      return channelKey(ref.playlistId, ref.streamId, ref.primaryPlaylistId)
    case 'movie':
      return `movie:${ref.streamId}`
    case 'series':
      return `series:${ref.episodeId}`
  }
}

/**
 * Whether two source URLs point at the same content — same host and pathname, query ignored.
 * The query is exactly where providers rotate auth tokens and expiry parameters, so it is not
 * part of the comparison; see the file header for why exact matching is the wrong test here.
 * Unparseable input falls back to plain string equality rather than throwing, so a mangled or
 * hand-typed URL can never take down a lookup that runs on the playback path.
 */
export function sameSourceUrl(a: string, b: string): boolean {
  const left = hostAndPath(a)
  const right = hostAndPath(b)
  if (!left || !right) return a === b
  return left.host === right.host && left.pathname === right.pathname
}

function hostAndPath(raw: string): { host: string; pathname: string } | null {
  try {
    const url = new URL(raw)
    return { host: url.host, pathname: url.pathname }
  } catch {
    return null
  }
}
