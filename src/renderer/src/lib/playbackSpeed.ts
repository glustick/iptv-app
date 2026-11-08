/**
 * Playback speed for films and episodes — the web sibling's v0.93.0 selector. Per device, like
 * the quality ceiling: how fast you watch a film is a habit of the person at this screen.
 *
 * Live TV deliberately has no speed: the stream is realtime, and a 1.25x live channel is a
 * different channel (one that skips). The control is only offered where speed means something.
 */
export const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5] as const
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number]

const STORAGE_KEY = 'allisoniptv-playback-speed'

function isPlaybackSpeed(value: unknown): value is PlaybackSpeed {
  return typeof value === 'number' && (PLAYBACK_SPEEDS as readonly number[]).includes(value)
}

export function loadPlaybackSpeed(): PlaybackSpeed {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return 1
    const parsed: unknown = JSON.parse(raw)
    return isPlaybackSpeed(parsed) ? parsed : 1
  } catch {
    return 1
  }
}

export function savePlaybackSpeed(speed: PlaybackSpeed): void {
  try {
    // 1x is the absence of a choice, not a stored one — same rule as the ordering and the quality
    // ceiling, so "normal" can never be a value a future default has to argue with.
    if (speed === 1) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(speed))
  } catch {
    // A blocked storage surface must not take playback down with it.
  }
}

export function formatPlaybackSpeed(speed: PlaybackSpeed): string {
  return `${speed}×`
}
