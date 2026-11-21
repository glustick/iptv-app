// Pure helpers for scheduled-recording air times and overlap detection (0.34.0). Kept free of
// React/store/IPC so the boundary math and phrasing are unit-testable directly — the same
// philosophy as recordingMatch.ts.

/** The shape findScheduleConflict needs; a structural subset of RecordingEntry. */
export interface ScheduleConflictCandidate {
  id: string
  programmeTitle?: string
  channelName: string
  status: string
  startAt?: number
  endAt?: number
}

/**
 * The scheduled entry whose air window [startAt, endAt) overlaps [startAt, endAt), if any.
 * Only SCHEDULED entries are considered — a past or in-flight recording cannot be un-scheduled,
 * so warning about it would only be noise — and entries without an air window (pre-0.34 index
 * entries, or ones scheduled before this field existed) are skipped rather than guessed at.
 * The operator's standing decision is that the app never silently refuses a recording, so this
 * is purely advisory: the caller names the conflict and still schedules on OK.
 */
export function findScheduleConflict(
  existingScheduled: ScheduleConflictCandidate[],
  startAt: number,
  endAt: number
): ScheduleConflictCandidate | null {
  return (
    existingScheduled.find(
      (e) =>
        e.status === 'scheduled' &&
        typeof e.startAt === 'number' &&
        typeof e.endAt === 'number' &&
        e.startAt < endAt &&
        startAt < e.endAt
    ) ?? null
  )
}

/**
 * "in 2h 15m"-style rounding of the time until `startAt`, for a scheduled row's meta line:
 * under five minutes is "any minute now" (the preroll means it may already be starting), under
 * an hour keeps minutes, under a day keeps hours-and-minutes, and anything further rounds to
 * whole days — nobody plans a recording to the minute three days out.
 */
export function formatAirsIn(startAt: number, nowMs: number): string {
  const ms = startAt - nowMs
  if (ms < 5 * 60 * 1000) return 'any minute now'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `in ${minutes}m`
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}m`
  }
  return `in ${Math.round(minutes / (24 * 60))}d`
}

/**
 * The Recordings tab's ordering (0.34.0): upcoming first — scheduled entries by air time, those
 * without an air window (pre-0.34) after them — then anything recording, then the finished
 * statuses (done/partial/failed) by recency, most recent first. Copies the array; never mutates.
 */
export function sortRecordingsForList<T extends { status: string; startedAt: number; startAt?: number; endedAt?: number }>(
  entries: T[]
): T[] {
  const rank = (e: T): number => (e.status === 'scheduled' ? 0 : e.status === 'recording' ? 1 : 2)
  return [...entries].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    if (ra === 0) {
      // Scheduled: by air time; entries without one sort last (stable within by recency).
      const aa = typeof a.startAt === 'number' ? a.startAt : Number.POSITIVE_INFINITY
      const bb = typeof b.startAt === 'number' ? b.startAt : Number.POSITIVE_INFINITY
      if (aa !== bb) return aa - bb
    }
    return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)
  })
}
