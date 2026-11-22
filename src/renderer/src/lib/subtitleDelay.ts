/**
 * When subtitles show — the 0.46.0 sync offset. Transcoded and rendition subtitles are built from
 * the stream's own timing, and when that timing disagrees with the audio (a broadcast mux offset,
 * a provider's sloppy transcode) every line lands a beat early or late for the whole title. This
 * is the fix: an offset in milliseconds that shifts every cue of the active track — and keeps
 * shifting the cues hls.js parses later, because a WebVTT rendition arrives fragment by fragment,
 * not all at once.
 *
 * The one rule that matters: a change of offset must re-shift from each cue's ORIGINAL times,
 * never from its already-shifted ones. Clicking +100ms then +500ms must land at +500 total, not
 * +600. So the first shift snapshots the untouched times, and every later change restores the
 * snapshot before applying the new delta. Offset 0 is the same restore, with the snapshot dropped.
 *
 * The offset is deliberately NOT persisted (unlike the appearance prefs next door): a delay tuned
 * against one stream's audio is simply wrong on the next one, and silently inheriting it is worse
 * than starting at zero. It lives and dies with the player's channel identity.
 *
 * Deliberately absent: an audio delay. Chromium cannot delay a decoded audio track without a
 * remux pipeline feeding it, so this moves the text toward the sound and the UI says so honestly.
 */

/** The cue shape this module touches: exactly the two mutable numbers that position it in time. */
export interface CueLike {
  startTime: number
  endTime: number
}

/** Just enough of TextTrackCueList to walk it: index access plus length (an array satisfies it). */
export interface CueListLike {
  readonly length: number
  [index: number]: CueLike | null
}

/** Just enough of TextTrack to find its cues. Real TextTracks satisfy this structurally. */
export interface DelayableTrack {
  readonly cues: CueListLike | null
}

/** A cue's new position, in the same seconds the cue times themselves use. */
export interface CueShift {
  start: number
  end: number
}

/**
 * The whole math of the feature, pure: where a cue moves for a given offset. Offsets are whole
 * milliseconds and cue times are seconds, and the result is rounded back to millisecond precision
 * so repeated shifts can never accumulate float noise into the times a viewer is watching.
 */
export function computeCueShift(originalStart: number, originalEnd: number, offsetMs: number): CueShift {
  const offsetSeconds = Number.isFinite(offsetMs) ? offsetMs / 1000 : 0
  return {
    start: shiftSeconds(originalStart, offsetSeconds),
    end: shiftSeconds(originalEnd, offsetSeconds)
  }
}

function shiftSeconds(seconds: number, offsetSeconds: number): number {
  return Math.round((seconds + offsetSeconds) * 1000) / 1000
}

interface StoredCue {
  cue: CueLike
  start: number
  end: number
}

interface DelayState {
  /** The offset the stored cues are CURRENTLY shifted by. */
  offsetMs: number
  cues: StoredCue[]
}

/** Keyed on the track object itself — hls.js swaps tracks on rendition/source changes, and a
 *  dead track's entry then garbage-collects with it instead of leaking into the next channel. */
const delayStates = new WeakMap<DelayableTrack, DelayState>()

function listCues(track: DelayableTrack): CueLike[] {
  const list = track.cues
  if (!list) return []
  const out: CueLike[] = []
  for (let i = 0; i < list.length; i += 1) {
    const cue = list[i]
    if (cue) out.push(cue)
  }
  return out
}

/**
 * Shifts every cue the track currently holds by `offsetMs`, and remembers the original times so
 * later calls never compound. Cues parsed after this call (the next WebVTT fragment) keep their
 * original parsed times until the player re-calls this — the cuechange handler does exactly that,
 * so a mid-title apply only touches the newcomers and the already-shifted lines stay put.
 *
 * A different offset restores the snapshot first, then applies the new delta from the originals;
 * offset 0 (or anything non-finite) restores and forgets. This is what the panel's Off button and
 * the channel-change reset both ride on.
 */
export function applySubtitleDelay(track: DelayableTrack, offsetMs: number): void {
  if (!track || !track.cues) return
  if (!Number.isFinite(offsetMs) || offsetMs === 0) {
    clearSubtitleDelay(track)
    return
  }
  const state = delayStates.get(track)
  const cuesNow = listCues(track)
  if (!state) {
    // First shift for this track: everything it holds right now is unshifted — snapshot, then move.
    const stored: StoredCue[] = cuesNow.map((cue) => ({ cue, start: cue.startTime, end: cue.endTime }))
    delayStates.set(track, { offsetMs, cues: stored })
    shiftStored(stored, offsetMs)
    return
  }
  if (state.offsetMs !== offsetMs) {
    // A changed offset: back to the originals first, so deltas add to the cue's own time, not to
    // the last choice's. Cues that arrived while an offset was active are already in the snapshot
    // with their original (pre-shift) times, so restoring them is correct too.
    for (const { cue, start, end } of state.cues) {
      cue.startTime = start
      cue.endTime = end
    }
    state.offsetMs = offsetMs
    shiftStored(state.cues, offsetMs)
    absorbNewCues(state, cuesNow)
    return
  }
  // Same offset as last time: only cues parsed since then need moving. Re-shifting the known ones
  // would compound, so identity — not position — decides what is new.
  absorbNewCues(state, cuesNow)
}

/** Stores and shifts the cues present in `cuesNow` that the state does not know yet. */
function absorbNewCues(state: DelayState, cuesNow: CueLike[]): void {
  const known = new Set<CueLike>()
  for (const entry of state.cues) known.add(entry.cue)
  for (const cue of cuesNow) {
    if (known.has(cue)) continue
    const entry: StoredCue = { cue, start: cue.startTime, end: cue.endTime }
    state.cues.push(entry)
    shiftEntry(entry, state.offsetMs)
  }
}

function shiftStored(cues: StoredCue[], offsetMs: number): void {
  for (const entry of cues) shiftEntry(entry, offsetMs)
}

function shiftEntry(entry: StoredCue, offsetMs: number): void {
  const shift = computeCueShift(entry.start, entry.end, offsetMs)
  entry.cue.startTime = shift.start
  entry.cue.endTime = shift.end
}

/**
 * Puts every stored cue back at its original time and forgets the track's snapshot. A track that
 * was never shifted is a no-op — the offset-clearing path calls this on every sync without ever
 * needing to check first.
 */
export function clearSubtitleDelay(track: DelayableTrack): void {
  if (!track) return
  const state = delayStates.get(track)
  if (!state) return
  for (const { cue, start, end } of state.cues) {
    cue.startTime = start
    cue.endTime = end
  }
  delayStates.delete(track)
}
