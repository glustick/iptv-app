// Detecting a live playlist that never advances — "this channel isn't broadcasting".
//
// The provider's placeholder/off-air shape serves a perfectly valid playlist whose window is
// frozen: every reload answers 200 with the same media sequence numbers and the same fragment
// count, forever. Nothing errors — hls.js happily reloads it, the buffer drains to its end, and
// the recovery ladder spends its entire budget (source reloads, engine switches, one of the
// account's two provider connections per attempt) on a channel that simply has no signal. The
// roadmap has carried this since 2026-09-22: say one honest sentence instead.
//
// The signal is the window's identity, not its timing: a playlist is "advancing" when its
// (startSN, endSN) pair CHANGES across reloads. The same pair seen on STALL_LOADS consecutive
// live reloads spanning at least STALL_WINDOW_MS is a frozen window — slow providers are
// tolerated by the window (they have to be quiet for half a minute straight), and a VOD
// playlist (live: false) is never stalled, because a fixed window is what VOD means.
//
// Pure, with the clock injected, so the classification is unit-tested without a player.

/** Consecutive identical live windows required before a stall is declared. */
export const STALL_LOADS = 4

/** The identical windows must span at least this long — well past one target duration. */
export const STALL_WINDOW_MS = 30_000

export interface PlaylistWindowSample {
  /** Epoch ms of the playlist reload this sample describes. */
  at: number
  /** Whether the playlist declares itself live (no #EXT-X-ENDLIST). */
  live: boolean
  /** The window's first media sequence number. */
  startSN: number
  /** The window's last media sequence number. */
  endSN: number
}

export interface PlaylistStallTracker {
  /** Feed one sample per playlist reload. Returns true exactly once — the moment a stall is
   *  declared. Further samples after that return false (the caller has already acted). */
  sample(input: PlaylistWindowSample): boolean
}

export function createPlaylistStallTracker(options?: {
  stallLoads?: number
  stallWindowMs?: number
}): PlaylistStallTracker {
  const stallLoads = options?.stallLoads ?? STALL_LOADS
  const stallWindowMs = options?.stallWindowMs ?? STALL_WINDOW_MS

  let identicalLoads = 0
  let firstIdenticalAt: number | null = null
  let lastKey = ''
  let declared = false

  return {
    sample(input: PlaylistWindowSample): boolean {
      if (declared) return false
      const key = `${input.startSN}:${input.endSN}`
      // A VOD window never stalls — a fixed window is what VOD means.
      if (!input.live) {
        identicalLoads = 0
        firstIdenticalAt = null
        lastKey = key
        return false
      }
      if (key !== lastKey) {
        // Any change in the window is advancement; this load is the new window's first sighting.
        lastKey = key
        identicalLoads = 1
        firstIdenticalAt = input.at
        return false
      }
      identicalLoads += 1
      const since = firstIdenticalAt ?? input.at
      if (identicalLoads >= stallLoads && input.at - since >= stallWindowMs) {
        declared = true
        return true
      }
      return false
    }
  }
}

// ---- the off-air re-probe's pacing (0.42.0) ----------------------------------------------------
// The re-probe exists to spare the provider connection during an outage — which argues for it
// also slowing down as the outage drags on. The schedule is gentle and bounded: every probe
// for the first ten minutes runs at 30s (a short outage — the common case — is caught within
// half a minute of returning), then the delay doubles every further ten minutes of dead air,
// capped at ten minutes between probes. Pure, injected count, so the schedule is unit-tested
// without a player.
export const OFF_AIR_PROBE_BASE_MS = 30_000
export const OFF_AIR_PROBE_ESCALATE_AFTER = 20
export const OFF_AIR_PROBE_MAX_MS = 600_000

export function offAirProbeDelayMs(probeCount: number): number {
  if (probeCount < OFF_AIR_PROBE_ESCALATE_AFTER) return OFF_AIR_PROBE_BASE_MS
  const escalated = OFF_AIR_PROBE_BASE_MS * Math.pow(2, Math.floor(probeCount / OFF_AIR_PROBE_ESCALATE_AFTER))
  return Math.min(escalated, OFF_AIR_PROBE_MAX_MS)
}
