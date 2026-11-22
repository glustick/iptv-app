/**
 * The session recovery log (0.40.0) — a module-level, read-only-by-design record of every
 * recovery action the player took, for the stats overlay's Recovery section.
 *
 * Why module-level rather than store state or refs: the writers are scattered across Player's
 * effects and timers (the watchdog ladder, the network-error handler, the reconnect backoff,
 * the off-air re-probe), and the reader (PlayerStatsOverlay) polls on its own 1s tick — a
 * snapshot function reads whatever is current with no subscription plumbing. Module scope is
 * exactly the lifetime wanted, too: a session's history, cleared when playback starts over
 * (new channel or fresh attach of a log the viewer can reason about), never persisted.
 *
 * Capped, newest-last, so a channel that stalls-reloads all night cannot grow it without
 * bound; the overlay shows the tail and the summary counts everything recorded.
 */

export interface RecoveryEvent {
  /** Epoch ms. */
  at: number
  /** One of the kinds the player actually records — see recordRecoveryEvent's callers. */
  kind:
    | 'stall-live-edge'
    | 'stall-nudge'
    | 'stall-reload'
    | 'stall-remux'
    | 'stall-give-up'
    | 'network-retry'
    | 'reconnect-backoff'
    | 'reconnect-exhausted'
    | 'off-air-verdict'
    | 'off-air-resume'
    | 'profile-switch'
  /** Short human detail (what was acted on, which attempt, and so on). */
  detail?: string
}

const MAX_EVENTS = 200

const events: RecoveryEvent[] = []

export function recordRecoveryEvent(kind: RecoveryEvent['kind'], detail?: string, now: number = Date.now()): void {
  events.push({ at: now, kind, ...(detail ? { detail } : {}) })
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
}

/** Newest-first tail for display; the caller owns how many. */
export function recentRecoveryEvents(count: number): RecoveryEvent[] {
  return events.slice(-count).reverse()
}

/** Everything recorded this session, oldest-first — what the summary counts over. */
export function allRecoveryEvents(): RecoveryEvent[] {
  return [...events]
}

export function clearRecoveryLog(): void {
  events.splice(0, events.length)
}

/** The one-line session-health summary a bug report wants: total recoveries by kind, then the
 *  most recent action. Empty session answers an honest "no recoveries". */
export function recoverySummary(now: number = Date.now()): string {
  if (events.length === 0) return 'No recoveries this session'
  const counts = new Map<string, number>()
  for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1)
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${n}× ${kind}`)
  const last = events[events.length - 1]
  const ago = Math.max(0, Math.round((now - last.at) / 1000))
  return `${events.length} recoveries — ${parts.join(', ')} — last: ${last.kind}${last.detail ? ` (${last.detail})` : ''} ${ago}s ago`
}

/** HH:MM:SS wall-clock for the overlay's per-row stamp. */
export function formatRecoveryTime(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
