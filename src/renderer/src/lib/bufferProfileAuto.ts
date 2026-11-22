/**
 * The auto buffer-profile switch (0.37.0).
 *
 * Two profiles exist for two network shapes: "smooth" (the default — a healthy broadband
 * connection wants modest latency and a deep-but-sane buffer) and, from this release,
 * "resilient" (a flaky connection wants the deepest buffer and the longest live-sync target
 * the 15-segment remux window allows — see the liveMaxLatencyDurationCount invariant in the
 * Player's hls constructor). This module decides WHEN to move between them, from evidence the
 * player already collects: stall-ladder recoveries and network-error retries, as timestamps.
 *
 * The shape is deliberately asymmetric, because the two mistakes cost differently: escalating
 * to resilient costs a few seconds of extra join latency — trivial; staying smooth through a
 * bad patch costs repeated stalls — what the viewer actually feels. So escalation is quick
 * (two recovery events inside five minutes) and de-escalation is slow (ten clean minutes).
 * A per-switch cool-down (five minutes) sits on top, because flapping the profile itself
 * causes reloads — the very instability it exists to prevent.
 *
 * Pure, with the clock injected, like playbackWatchdog.
 */

export const AUTO_ESCALATE_EVENTS = 2
export const AUTO_ESCALATE_WINDOW_MS = 5 * 60_000
export const AUTO_DEESCALATE_AFTER_MS = 10 * 60_000
export const AUTO_MIN_SWITCH_INTERVAL_MS = 5 * 60_000

export interface AutoProfileInput {
  /** Epoch-ms timestamps of recent recovery events (stall-ladder actions, network retries). */
  recoveryEvents: number[]
  /** The profile currently in effect. */
  current: 'smooth' | 'resilient'
  /** Epoch ms of the last profile switch (null = never switched this session). */
  lastSwitchAt: number | null
  /** Now, injected. */
  now: number
}

export type AutoProfileDecision = 'smooth' | 'resilient' | null

export function adaptBufferProfile(input: AutoProfileInput): AutoProfileDecision {
  const recent = input.recoveryEvents.filter((at) => input.now - at <= AUTO_ESCALATE_WINDOW_MS)
  if (input.current === 'smooth') {
    if (recent.length >= AUTO_ESCALATE_EVENTS) {
      // The cool-down gates only if THIS session has already switched recently — a session
      // that starts on smooth (the default) escalates on first evidence regardless.
      if (input.lastSwitchAt !== null && input.now - input.lastSwitchAt < AUTO_MIN_SWITCH_INTERVAL_MS) return null
      return 'resilient'
    }
    return null
  }
  // Currently resilient: de-escalate only on a genuinely quiet stretch.
  const latestEvent = input.recoveryEvents.length > 0 ? Math.max(...input.recoveryEvents) : null
  const quietFor = latestEvent === null ? Infinity : input.now - latestEvent
  if (quietFor >= AUTO_DEESCALATE_AFTER_MS) {
    if (input.lastSwitchAt !== null && input.now - input.lastSwitchAt < AUTO_MIN_SWITCH_INTERVAL_MS) return null
    return 'smooth'
  }
  return null
}
