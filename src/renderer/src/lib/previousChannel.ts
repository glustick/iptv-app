/**
 * The "previous channel" a remote has — the web sibling's v0.93.0 button, which this app's header
 * did not have. Session-only and two entries deep: a TV remembers the channel you were just on,
 * not a browsing history, and pressing the button again goes back (A→B→A), which is exactly what
 * a two-entry list produces.
 *
 * The playlist is part of a channel's identity here for the same reason it is everywhere else in
 * this app: provider A's channel 42 and provider B's 42 are unrelated, and "previous" must not
 * jump to the wrong one.
 */
export interface PreviousLiveChannel {
  streamId: number
  name: string
  icon: string
  tvArchive: number
  playlistId: string | null
}

function sameChannel(a: PreviousLiveChannel, b: PreviousLiveChannel): boolean {
  return a.streamId === b.streamId && a.playlistId === b.playlistId
}

/**
 * Records what is now playing. Re-playing the same channel is not a change — otherwise a reload
 * of the current channel would make it its own previous channel, and the button would do nothing.
 */
export function rememberLiveChannel(
  history: PreviousLiveChannel[],
  entry: PreviousLiveChannel
): PreviousLiveChannel[] {
  if (history.length > 0 && sameChannel(history[0], entry)) return history
  return [entry, ...history].slice(0, 2)
}

export function previousLiveChannel(history: PreviousLiveChannel[]): PreviousLiveChannel | null {
  return history[1] ?? null
}
