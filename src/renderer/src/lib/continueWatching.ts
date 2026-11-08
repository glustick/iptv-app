import type { EpisodeProgress } from './types'

// The web sibling's own rule (allison-web-iptv v0.92.0), kept identical here so the two apps
// agree about what "watched" means: a title is finished at 95%, or once it is within two minutes
// of the end — but only for a title long enough to have credits. On a five-minute clip the
// credits rule would call it finished before it started, which is why the duration floor exists.
export const FINISHED_FRACTION = 0.95
export const CREDITS_SECONDS = 120
export const CREDITS_MIN_DURATION_SECONDS = 600

// Movies and episodes share one progress map (settings' episodeProgress), so a movie needs a
// namespace of its own: the provider's movie stream ids and episode ids are different numbering
// spaces that collide freely, and a bare key would let one overwrite the other's position.
// Series episode keys stay bare (the pre-0.18.0 shape), so existing resumes survive the upgrade.
const MOVIE_KEY_PREFIX = 'movie:'
const MOVIE_KEY_PATTERN = /^movie:(\d+)$/

export function movieProgressKey(streamId: number | string): string {
  return `${MOVIE_KEY_PREFIX}${streamId}`
}

export function movieIdFromProgressKey(key: string): number | null {
  const match = MOVIE_KEY_PATTERN.exec(key)
  if (!match) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

/** True when this position means "watched", not "part way through" — see the constants above. */
export function isFinished(positionSeconds: number, durationSeconds: number): boolean {
  if (!Number.isFinite(positionSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return false
  }
  if (positionSeconds >= durationSeconds * FINISHED_FRACTION) return true
  return (
    durationSeconds >= CREDITS_MIN_DURATION_SECONDS &&
    durationSeconds - positionSeconds <= CREDITS_SECONDS
  )
}

/** How far through, 0–1 — clamped so a bad stored value can never paint a bar past its end. */
export function progressFraction(positionSeconds: number, durationSeconds: number): number {
  if (!Number.isFinite(positionSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0
  }
  return Math.max(0, Math.min(1, positionSeconds / durationSeconds))
}

/** A position as a viewer reads it — "12:34", or "1:02:05" once there is an hour to show. */
export function formatPlaybackPosition(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0:00'
  const whole = Math.floor(totalSeconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const seconds = whole % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export interface ContinueWatchingEntry {
  key: string
  streamId: number
  positionSeconds: number
  durationSeconds: number
  fraction: number
  updatedAt: number
}

/**
 * The Movies shelf's list: half-watched films, newest first, capped.
 *
 * Deliberately reads only `movie:`-prefixed keys — a series episode's own key is a bare number,
 * so the namespace filter is also what keeps episodes out of a films-only shelf. Finished titles
 * are excluded here rather than deleted from the map: the series modal's own ✓ Watched marker
 * still reads the same records, and a finished film must simply stop being offered.
 */
export function continueWatchingMovies(
  progress: Record<string, EpisodeProgress>,
  limit = 8
): ContinueWatchingEntry[] {
  const entries: ContinueWatchingEntry[] = []
  for (const [key, record] of Object.entries(progress)) {
    const streamId = movieIdFromProgressKey(key)
    if (streamId === null || !record) continue
    if (!Number.isFinite(record.positionSeconds) || record.positionSeconds <= 0) continue
    if (!Number.isFinite(record.durationSeconds) || record.durationSeconds <= 0) continue
    if (isFinished(record.positionSeconds, record.durationSeconds)) continue
    entries.push({
      key,
      streamId,
      positionSeconds: record.positionSeconds,
      durationSeconds: record.durationSeconds,
      fraction: progressFraction(record.positionSeconds, record.durationSeconds),
      updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0
    })
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt)
  return entries.slice(0, Math.max(0, limit))
}
