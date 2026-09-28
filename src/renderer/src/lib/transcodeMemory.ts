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
import type { TranscodeMemoryEntry } from './types'

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

// Cap on the shared record. Without one it grows an entry for every distinct channel/title that
// ever needed a fix (or specifically didn't) — thousands of entries on a large catalogue,
// rewritten into settings on every write. 2000 is a generous multiple of any realistic watch
// history while still bounding the file.
export const TRANSCODE_MEMORY_MAX_ENTRIES = 2000

/**
 * Caps the record at `cap` entries, dropping the OLDEST by `confirmedAt` first — an outcome not
 * seen (or re-confirmed) for the longest is the safest to forget. Within the cap the record is
 * returned as-is (the same reference), so a write that doesn't exceed the limit never rewrites
 * more than the single entry it came for.
 *
 * Entries missing a usable `confirmedAt` (a hand-edited or partially-written settings file —
 * loadSettings only shape-checks this field as an object) count as the oldest, so corruption
 * ages out rather than pinning the record's newest end.
 */
export function pruneTranscodeMemory(
  memory: Record<string, TranscodeMemoryEntry>,
  cap = TRANSCODE_MEMORY_MAX_ENTRIES
): Record<string, TranscodeMemoryEntry> {
  const keys = Object.keys(memory)
  if (keys.length <= cap) return memory
  const newestFirst = keys.sort(
    (a, b) => (memory[b]?.confirmedAt ?? 0) - (memory[a]?.confirmedAt ?? 0)
  )
  const kept: Record<string, TranscodeMemoryEntry> = {}
  for (const key of newestFirst.slice(0, cap)) kept[key] = memory[key]
  return kept
}

/**
 * The audio track index a remembered outcome says to remux with, or null when there is nothing
 * actionable to act on.
 *
 * Deliberately only an 'audio' entry is acted on. Acting on a 'direct' record — skipping
 * detection because this source played as-is last time — would silently leave a title whose
 * file has since been replaced with an AC-3 one mute, with nothing on screen to explain it; so
 * 'direct' is recorded but detection must keep running against it. A missing entry, or one
 * confirmed against a different source shape, likewise yields null — normal detection, not a
 * guess. The url comparison is sameSourceUrl's host+path rule, so a rotated provider token
 * still matches (see this file's header for why exact matching would be the wrong test).
 */
export function rememberedAudioIndex(
  memory: Record<string, TranscodeMemoryEntry>,
  key: string,
  url: string
): number | null {
  const entry = memory[key]
  if (!entry || entry.kind !== 'audio') return null
  return sameSourceUrl(entry.url, url) ? entry.audioIndex : null
}
