/**
 * Pure helpers behind Player.tsx's playback watchdog and its stall-error handling.
 *
 * Kept separate (and unit-tested) rather than inlined because the interesting part is the
 * *decision* — when a frozen picture counts as a stall, and how far to escalate — not the
 * timers around it. Everything here is dependency-free on purpose.
 */

/**
 * True for the hls.js MEDIA_ERROR details that really mean "there is no data at the playhead"
 * rather than "this media cannot be decoded".
 *
 * The distinction matters because the two want opposite responses: a decode failure is fixed by
 * resetting the decode pipeline (`recoverMediaError()`), while a data gap is fixed by getting the
 * loader going again. Calling `recoverMediaError()` for a gap resets the SourceBuffer and
 * re-seeks — a visible flicker — and burns one of only a handful of decode-recovery attempts on
 * something that was never a decode problem. All three of these are emitted by hls.js's own gap
 * controller / buffer controller once *their* internal nudge ladder gives up.
 */
export function isBufferStallError(details: string): boolean {
  return details === 'bufferStalledError' || details === 'bufferSeekOverHole' || details === 'bufferNudgeOnStall'
}

/**
 * A coarse fingerprint of "is playback actually getting anywhere" — the buffer's readiness plus
 * the playhead, quantised to a quarter second.
 *
 * Quantised because `currentTime` is a jittery float that can tick by a thousandth of a second
 * without the stream having delivered anything; unquantised, that jitter would keep resetting a
 * watchdog whose entire job is to notice when nothing is really moving.
 */
export function playbackSignature(readyState: number, currentTime: number): string {
  return `${readyState}:${Math.round(currentTime * 4)}`
}

export type StallAction = 'nudge' | 'reload' | 'giveUp'

/**
 * The escalation ladder for a confirmed stall, given how many recovery attempts have already
 * been made since playback last progressed:
 *   0 attempts  → nudge   (resume loading and step off the wedged point — cheap, invisible)
 *   1..maxReloads → reload (re-attach the source from scratch — a second of black screen)
 *   beyond that → giveUp  (a genuinely dead stream; stop pretending anything is coming)
 */
export function nextStallAction(completedRecoveries: number, maxReloads = 2): StallAction {
  if (completedRecoveries <= 0) return 'nudge'
  if (completedRecoveries <= maxReloads) return 'reload'
  return 'giveUp'
}
