/**
 * Identity for a channel across playlists.
 *
 * Why this is needed: `stream_id` is unique *within* a provider but not *across* providers — two
 * Xtream accounts number their channels independently, so id 42 on one is an unrelated channel on
 * the other. Every per-channel thing the app persists (hidden channels, remembered audio fixes,
 * per-channel EPG mappings, watch reminders, custom-category membership) was keyed by that bare id,
 * which with multi-playlist (0.7.105) meant acting on one provider's channel could silently act on
 * the other's.
 *
 * The rule here is deliberately **additive rather than a migration**: a channel belonging to the
 * *primary* playlist keys exactly as it always did — its plain id — so every existing stored entry
 * keeps meaning what it meant, with nothing to rewrite. Only other playlists' channels get a
 * qualified key. That also keeps the common single-playlist case byte-identical on disk.
 *
 * Pure and dependency-free, like the rest of lib/ (see STATE.md's direction note).
 */

/** Separator for a qualified key. `:` cannot appear in a numeric stream id, so the two forms can
 * never be confused for one another. */
const SEPARATOR = ':'

/**
 * The storage key for one channel. `primaryPlaylistId` and `playlistId` may both be null — an
 * unknown playlist is treated as the primary, because that is what every entry written before
 * multi-playlist meant.
 */
export function channelKey(
  playlistId: string | null | undefined,
  streamId: number,
  primaryPlaylistId: string | null | undefined
): string {
  if (!playlistId || !primaryPlaylistId || playlistId === primaryPlaylistId) return String(streamId)
  return `${playlistId}${SEPARATOR}${streamId}`
}

/** True when `key` refers to this channel. Takes the already-computed key so callers that hold one
 * (or a list of them) can avoid recomputing it per comparison. */
export function isChannelKeyFor(key: string, playlistId: string | null | undefined, streamId: number, primaryPlaylistId: string | null | undefined): boolean {
  return key === channelKey(playlistId, streamId, primaryPlaylistId)
}

/**
 * Every stored key that could refer to this channel — its own, plus the bare id when it belongs to
 * the primary. Used when *removing* entries: a stale entry written before the playlist was known
 * (bare id) must still be cleared when the same channel is acted on now.
 */
export function channelKeyCandidates(
  playlistId: string | null | undefined,
  streamId: number,
  primaryPlaylistId: string | null | undefined
): string[] {
  const key = channelKey(playlistId, streamId, primaryPlaylistId)
  return key === String(streamId) ? [key] : [key, String(streamId)]
}

/**
 * Whether a stored key belongs to `playlistId`'s line-up. A bare key belongs to the primary (that is
 * all it can mean), a qualified key names its own playlist. Used for scope questions — "how many
 * hidden channels are there in what I am looking at" — where there is no channel object to hand.
 */
export function channelKeyBelongsToPlaylist(
  key: string,
  playlistId: string | null | undefined,
  primaryPlaylistId: string | null | undefined
): boolean {
  const separatorAt = key.indexOf(SEPARATOR)
  if (separatorAt < 0) return !playlistId || !primaryPlaylistId || playlistId === primaryPlaylistId
  return key.slice(0, separatorAt) === playlistId
}

/**
 * A custom-category membership entry for one channel: the plain numeric id for a channel on the
 * primary playlist — byte-for-byte what every entry written before multi-playlist is — and the
 * qualified key otherwise. Deliberately returns the *number* rather than its string form for the
 * bare case, so existing membership keeps both its value and its type; a category holding channels
 * from two playlists therefore holds a mix, which is exactly what the comparison helper below is for.
 */
export function channelEntryFor(
  playlistId: string | null | undefined,
  streamId: number,
  primaryPlaylistId: string | null | undefined
): number | string {
  const key = channelKey(playlistId, streamId, primaryPlaylistId)
  return key === String(streamId) ? streamId : key
}

/** True when a stored membership entry refers to this channel. Compares string forms, because an
 * entry is legitimately either shape (see channelEntryFor) and `42`/`'42'` must not be two channels. */
export function isChannelEntryFor(
  entry: number | string,
  playlistId: string | null | undefined,
  streamId: number,
  primaryPlaylistId: string | null | undefined
): boolean {
  return String(entry) === channelKey(playlistId, streamId, primaryPlaylistId)
}
