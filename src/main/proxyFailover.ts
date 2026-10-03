// Backup-portal failover memory, kept pure so the decision is testable without a proxy.
//
// The operator's provider (like most) publishes a reserve portal URL: the same panel and
// credentials behind a second host, for the day the primary stops answering. The proxy now
// carries that backup and fails over to it — but failing over per-request would double the
// latency of every request while the primary is down (connect timeouts are not instant), and
// returning to the primary the instant one request succeeds would flap on a portal that is
// dying slowly. So the outcome is remembered for a short window: once a request has failed
// over, subsequent requests try the backup FIRST until the cooldown expires — and the first
// real answer from the primary clears it immediately, so a quick recovery costs one request,
// not a minute.

/** How long a primary that had to be failed over from is left alone. Short enough that a
 *  quick primary recovery is picked up on the next request after expiry; long enough to span
 *  a portal blip rather than paying its connect-timeout on every single request. */
export const FAILOVER_COOLDOWN_MS = 60_000

/** Bounded: a long-running proxy must not accumulate cooldown entries for bases nobody uses
 *  any more (profiles change; the map is keyed by primary base). */
export const FAILOVER_STATE_LIMIT = 8

export interface FailoverState {
  /** Primary base → epoch ms until which its backup is preferred. */
  backupUntil: Map<string, number>
}

export function createFailoverState(): FailoverState {
  return { backupUntil: new Map() }
}

/** When — if at all — the backup should be tried first for this primary. Null means the
 *  primary goes first. Expired entries are lazily ignored (and pruned on the next write). */
export function backupPreferredUntil(
  state: FailoverState,
  primary: string,
  now: number
): number | null {
  const until = state.backupUntil.get(primary)
  if (until === undefined) return null
  if (now >= until) return null
  return until
}

/** Records that the primary failed hard enough to need its backup, so the next requests skip
 *  straight to the backup until the cooldown is out. Prunes expired entries and caps the map,
 *  evicting the soonest-expiring first. */
export function notePrimaryFailure(
  state: FailoverState,
  primary: string,
  now: number,
  cooldownMs: number = FAILOVER_COOLDOWN_MS
): void {
  for (const [key, until] of state.backupUntil) {
    if (now >= until) state.backupUntil.delete(key)
  }
  state.backupUntil.set(primary, now + cooldownMs)
  while (state.backupUntil.size > FAILOVER_STATE_LIMIT) {
    let earliest: string | null = null
    let earliestUntil = Infinity
    for (const [key, until] of state.backupUntil) {
      if (until < earliestUntil) {
        earliest = key
        earliestUntil = until
      }
    }
    if (earliest === null) break
    state.backupUntil.delete(earliest)
  }
}

/** Records that the primary answered — a transport answer in the 2xx/3xx/4xx range, i.e. a
 *  portal that is alive even if it refused this particular request. Clears any cooldown so
 *  traffic returns to the primary immediately. */
export function notePrimarySuccess(state: FailoverState, primary: string): void {
  state.backupUntil.delete(primary)
}
