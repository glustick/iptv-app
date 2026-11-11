/**
 * Pure helpers behind Player.tsx's offline→online auto-reconnect (0.30.0).
 *
 * Before this, coming back online bumped the player's reload immediately — and if the provider
 * was still down (a flapping link, or connectivity that returned before the *internet* did),
 * that reload died too and nothing ever retried: one shot, dead player until the user picked
 * the channel again. These helpers give that retry a schedule: exponential backoff, capped,
 * with a hard attempt budget per offline period and a reset once playback has demonstrably
 * been fine for a while. Dependency-free on purpose, like playbackWatchdog.
 */

export const RECONNECT_BASE_DELAY_MS = 2000
export const RECONNECT_MAX_DELAY_MS = 8000
export const RECONNECT_MAX_ATTEMPTS = 5
// A stretch of clean playback this long means whatever the reconnect loop was fighting is
// over — the next offline period starts from a fresh budget instead of inheriting attempts.
export const RECONNECT_RESET_AFTER_MS = 30000

/**
 * The delay before reconnect attempt number `attempt` (1-based): 2s, 4s, 8s, 8s, 8s…
 * Returns null once the attempt budget is spent — the caller should stop auto-retrying and
 * surface a manual action instead of looping forever against a provider that is simply down.
 */
export function nextReconnectDelayMs(attempt: number): number | null {
  if (attempt < 1 || attempt > RECONNECT_MAX_ATTEMPTS) return null
  const exponential = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1)
  return Math.min(exponential, RECONNECT_MAX_DELAY_MS)
}

/**
 * Whether the attempt budget should reset: after this long a *continuous* stretch of good
 * playback, the reconnect loop's history is stale and the next offline period deserves a full
 * set of attempts again.
 */
export function shouldResetReconnectAttempts(cleanPlaybackMs: number): boolean {
  return cleanPlaybackMs >= RECONNECT_RESET_AFTER_MS
}
