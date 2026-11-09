/**
 * The ordered channel list the player steps through (0.27.0), and the stepping itself.
 *
 * The list is the one PlayerChannelBar has always built — the last-browsed category's
 * liveStreams, minus hidden channels when that filter is on — extracted here so the
 * Ch− / Ch+ keys and buttons step through exactly the same lineup the swap bar shows,
 * rather than a second, subtly different one. A channel picked from elsewhere (Favorites,
 * Recently Watched) may not be in the list at all; stepChannel answers null for that case
 * and the caller does nothing, which is honest — there is no "next" in a list of one.
 */
import type { LiveStream } from './types'

/**
 * The category's channels in the catalogue's own order, with hidden channels removed unless
 * the viewer has chosen to see them. Pure: the hidden-channel predicate is passed in (the
 * store's isChannelHidden), so this stays testable without a store.
 */
export function visibleLiveChannelList(
  liveStreams: LiveStream[],
  showHidden: boolean,
  isChannelHidden: (playlistId: string | null | undefined, streamId: number) => boolean
): LiveStream[] {
  if (showHidden) return liveStreams
  return liveStreams.filter((channel) => !isChannelHidden(channel.playlistId, channel.stream_id))
}

/**
 * The channel `delta` places away from `currentStreamId` in `list`, wrapping around both ends
 * the way a set-top box does — the last channel's next is the first. +1 is "down" the list
 * (Ch+), -1 is "up" (Ch−). null when there is nothing to step to: an empty list, a
 * single-channel list (stepping would land on the same channel, which is a no-op the caller
 * can't distinguish from a real switch), or a current channel the list doesn't contain.
 */
export function stepChannel(
  list: LiveStream[],
  currentStreamId: number,
  delta: 1 | -1
): LiveStream | null {
  if (list.length < 2) return null
  const index = list.findIndex((channel) => channel.stream_id === currentStreamId)
  if (index < 0) return null
  const next = list[(index + delta + list.length) % list.length]
  return next.stream_id === currentStreamId ? null : next
}
