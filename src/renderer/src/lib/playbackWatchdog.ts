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
export function playbackSignature(readyState: number, currentTime: number, bufferedEnd?: number): string {
  // The buffer-health component (0.30.0): buffered-ahead, quantised like the playhead. Two
  // stalls that look identical from the playhead alone — the picture frozen with data already
  // buffered ahead (a render/decode wedge) versus frozen with the buffer draining to nothing
  // (the network died) — differ here, and only the first wants the hastened recovery delay.
  // Omitted for callers that have no buffer (and in the pre-0.30.0 tests), keeping the
  // two-component format those already assert on.
  const health = bufferedEnd === undefined ? '' : `:${Math.max(0, Math.round((bufferedEnd - currentTime) * 4))}`
  return `${readyState}:${Math.round(currentTime * 4)}${health}`
}

/**
 * The recovery wait when the picture is frozen *with data already buffered ahead* (a
 * render-side wedge — the network is fine, the player just isn't moving) or when the browser
 * itself has raised `stalled`: half the normal patience, because there is nothing left to wait
 * for. A frozen playhead with the buffer draining is the opposite case — data may still arrive
 * — so it keeps the full STALL_RECOVERY_AFTER_MS.
 */
export function stallRecoveryDelayMs(bufferAheadSeconds: number, stalledEventSeen: boolean, baseMs = 10000): number {
  return stalledEventSeen || bufferAheadSeconds > 0.25 ? baseMs / 2 : baseMs
}

export type StallAction = 'liveEdge' | 'nudge' | 'reload' | 'giveUp'

/**
 * The escalation ladder for a confirmed stall, given how many recovery attempts have already
 * been made since playback last progressed:
 *   0 attempts  → nudge   (resume loading and step off the wedged point — cheap, invisible)
 *   1..maxReloads → reload (re-attach the source from scratch — a second of black screen)
 *   beyond that → giveUp  (a genuinely dead stream; stop pretending anything is coming)
 */
export function nextStallAction(completedRecoveries: number, maxReloads = 2, isLive = false, flavor: NetworkFlavor = null): StallAction {
  // Live content gets one extra, cheapest-first rung (0.30.0): a live channel that stops
  // progressing is most often simply parked behind the live edge (a finished placeholder
  // playlist, a DVR window that slid, a brief feed gap the player never chased) — and jumping
  // back to the live edge fixes exactly that, invisibly, without spending a provider
  // connection on a reload. Only if the playhead still refuses to move does the ladder
  // continue up the old nudge → reload → give-up sequence, unchanged for VOD (where there is
  // no live edge to rejoin, and the first rung stays the nudge).
  if (isLive && completedRecoveries <= 0) return 'liveEdge'
  const vodRung = completedRecoveries - (isLive ? 1 : 0)
  // Measured network flavor (0.39.0): a stall with fragments SLOW to arrive is a starved
  // buffer — the nudge's +0.1s and startLoad cannot conjure data, so skip straight to the
  // reload. Fast-or-unknown keeps the original shape (nudge first — the render-side wedge the
  // nudge exists to fix is most likely exactly when data is arriving fine).
  if (vodRung <= 0) return flavor === 'slow' ? 'reload' : 'nudge'
  if (vodRung <= maxReloads) return 'reload'
  return 'giveUp'
}

// ---- fragment telemetry (0.39.0) --------------------------------------------------------------
// hls.js reports per-fragment load timings on FRAG_LOADED (frag.stats.loading: start/first/end,
// performance.now()-based). The watchdog's stall triage wants one number out of that stream:
// the recent median time-to-first-byte. Median, not mean — one slow fragment behind a big seek
// must not color the whole window.

export type NetworkFlavor = 'slow' | 'fast' | null

/** TTFB for one loaded fragment, or null when the timing record is not usable. */
export function fragmentTtfbMs(stats: { loading: { start: number; first: number; end?: number } } | undefined | null): number | null {
  if (!stats || !stats.loading) return null
  const { start, first } = stats.loading
  if (!Number.isFinite(start) || !Number.isFinite(first) || first < start) return null
  return first - start
}

/** Median of the recent samples, or null with too few to mean anything. */
export function medianTtfb(samples: number[]): number | null {
  if (samples.length < 3) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Slow vs fast, with the threshold reasoned once: healthy delivery on this app's own
 *  transcode path and CDN-fronted live origins lands well under 500ms to first byte; a
 *  starved/origin-throttled feed routinely measures in the seconds. 2s sits far enough above
 *  the healthy band that only genuinely starved delivery reads as slow. */
export const SLOW_TTFB_THRESHOLD_MS = 2000

export function networkFlavor(medianMs: number | null, slowThresholdMs = SLOW_TTFB_THRESHOLD_MS): NetworkFlavor {
  if (medianMs === null) return null
  return medianMs >= slowThresholdMs ? 'slow' : 'fast'
}

/**
 * Clamp a remembered VOD position into the new instance's seekable range (0.30.0). A position
 * captured before an internal reload can sit past the new instance's buffer window (or before
 * its start, after a seekable-range shift), so restoring it verbatim would throw or seek into
 * a hole. Returns null when there is nothing sensible to seek to — not seekable yet, or a
 * degenerate range — leaving the caller to just play from the default position.
 */
export function clampRestorePosition(positionSeconds: number, seekableStart: number, seekableEnd: number): number | null {
  if (!Number.isFinite(positionSeconds) || positionSeconds <= 0) return null
  if (!Number.isFinite(seekableStart) || !Number.isFinite(seekableEnd) || seekableEnd <= seekableStart) return null
  return Math.min(Math.max(positionSeconds, seekableStart), Math.max(seekableStart, seekableEnd - 1))
}
