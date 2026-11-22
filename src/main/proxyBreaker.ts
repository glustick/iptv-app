// Per-origin-host failure circuit breaker, kept pure so the decision is testable without a
// proxy (0.38.0).
//
// The per-request machinery (upstream timeout → same-target retry → backup-portal failover)
// already answers "is THIS request salvageable" — but when a host is genuinely down, every
// fragment pays the full worst case: attempt (45s) → retry (45s) → failover attempt → 502.
// A live HLS session reloads every few seconds and fetches several fragments each round, so a
// dead host means a dozen requests hanging for ~90s each, all while the player's own ladder
// waits on answers that were never coming. The breaker remembers consecutive transport
// failures per HOST (hostname — the granularity the Chromium-side "every request to this host
// hangs" failure mode actually happens at, see proxyServer's own comment): after
// BREAKER_THRESHOLD in a row, the host is open for BREAKER_COOLDOWN_MS — requests fast-fail
// to the backup portal (or 502 immediately when none), and the cooldown expiry lets the next
// request through as the probe. One success closes the breaker; one failure re-opens it for
// another cooldown. Counters reset on success — the breaker remembers a dead host, never a
// single unlucky blip.

/** Consecutive transport failures before a host is opened. */
export const BREAKER_THRESHOLD = 5

/** How long an opened host stays open. Short enough that a quick origin recovery costs one
 *  probe request; long enough that a dead host's fragments fail in microseconds instead of
 *  hanging ~90s each across a whole playlist refresh round. */
export const BREAKER_COOLDOWN_MS = 30_000

/** Bounded: profiles come and go, and a long-running proxy must not accumulate entries for
 *  hosts nothing addresses any more. */
export const BREAKER_STATE_LIMIT = 64

export interface BreakerState {
  /** Hostname → consecutive failure count (reset on any success). */
  failures: Map<string, number>
  /** Hostname → epoch ms the breaker opened at (present exactly while open). */
  openedAt: Map<string, number>
}

export function createBreakerState(): BreakerState {
  return { failures: new Map(), openedAt: new Map() }
}

/** Whether requests to this host should fast-fail right now. An expired open cools back to
 *  closed lazily — the next request is the half-open probe. */
export function breakerIsOpen(state: BreakerState, host: string, now: number, cooldownMs: number = BREAKER_COOLDOWN_MS): boolean {
  const opened = state.openedAt.get(host)
  if (opened === undefined) return false
  if (now - opened >= cooldownMs) return false
  return true
}

/** Records one transport failure for the host. At the threshold, opens the breaker (or, while
 *  already past it, re-opens for a fresh cooldown — the probe's own failure). Prunes expired
 *  opens and caps the map on the write path, evicting the stalest failure counters first. */
export function noteHostFailure(
  state: BreakerState,
  host: string,
  now: number,
  threshold: number = BREAKER_THRESHOLD,
  cooldownMs: number = BREAKER_COOLDOWN_MS
): void {
  const count = (state.failures.get(host) ?? 0) + 1
  state.failures.set(host, count)
  if (count >= threshold) state.openedAt.set(host, now)
  for (const [key, opened] of state.openedAt) {
    if (now - opened >= cooldownMs && key !== host) state.openedAt.delete(key)
  }
  while (state.failures.size > BREAKER_STATE_LIMIT) {
    let stalest: string | null = null
    let lowest = Infinity
    for (const [key, count] of state.failures) {
      if (count < lowest) {
        stalest = key
        lowest = count
      }
    }
    if (stalest === null) break
    state.failures.delete(stalest)
    state.openedAt.delete(stalest)
  }
}

/** Records any usable answer from the host (anything below 500, transport-level). Resets the
 *  failure count and closes an open breaker immediately — one real answer outranks all the
 *  remembered failures, because it is the newest fact about the host. */
export function noteHostSuccess(state: BreakerState, host: string): void {
  state.failures.delete(host)
  state.openedAt.delete(host)
}
