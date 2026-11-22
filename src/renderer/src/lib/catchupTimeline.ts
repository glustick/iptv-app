import type { ShortEpgProgram } from './types'

/**
 * The catch-up timeline (0.47.0): turns a live stream's DVR seekable window and its channel's
 * programme listings into the marker strip PlayerSeekBar renders above its progress bar —
 * which programme occupies which fraction of the buffer, so a rewound live stream shows what
 * you've landed on instead of just how far behind you are.
 *
 * THE EPOCH MAPPING — read this before touching the math.
 *
 * The two timelines this joins speak different units:
 *
 *  - The <video> element's `seekable` range is in MEDIA-RELATIVE SECONDS. hls.js does not map
 *    it onto wall-clock time on the element (program-date-time tags live on hls.js's own
 *    events, not on HTMLMediaElement.seekable), and PlayerSeekBar has always read the raw
 *    range — its progress, thumb and wheel-scrub are all fractions of that range.
 *  - ShortEpgProgram's start/stop timestamps are epoch SECONDS (the Xtream API's unit —
 *    converted here, ONCE, immediately on entry; nothing below sees seconds again).
 *
 * The bridge this lib draws, and the one PlayerSeekBar feeds it: anchor the seekable window's
 * END at "now" and span it backwards across its own duration. The end of the seekable range IS
 * the live edge — Player.tsx's goToLive has always treated seekable.end as exactly that, for
 * the same reason (hls.js keeps extending it as segments arrive). So a window measured
 * [start, end] seconds corresponds to the epoch span [now - duration, now], and each marker's
 * fraction-of-window is the same fraction whether measured in media seconds or epoch ms — the
 * two ends are anchored, the span is linear, and PlayerSeekBar positions progress and markers
 * with one consistent fraction. For a genuine live DVR stream this is exact to within the
 * segment duration; the ROADMAP records that real-provider DVR windows are unverified against
 * this math (the fixture's catch-up stream is a bounded file, not a sliding window).
 *
 * Every input is epoch MILLISECONDS except the ShortEpgProgram timestamps; every output
 * fraction is 0..1 across the window, directly comparable with the bar's own progress
 * fraction. Programmes extending past either end of the window are clipped to it — the bar
 * cannot show what the buffer does not contain — and programmes with no overlap are dropped
 * (an honest empty, not a marker squashed onto an edge).
 */

/** One programme's slice of the seek bar, as fractions of the seekable window. */
export interface CatchupMarker {
  title: string
  startFraction: number
  endFraction: number
  /** True when this programme's window contains `nowMs` — the "what's on" slice to highlight. */
  isCurrent: boolean
  /** The programme's OWN epoch window (unclipped) — the marker tooltip names the real air
   *  times, not the clipped-on-buffer ones. */
  startMs: number
  stopMs: number
}

const HOUR_MS = 3_600_000

/** The seekable window in epoch ms — PlayerSeekBar derives it from the raw media-second range
 *  anchored at now (see the header's epoch mapping). */
export interface CatchupSeekableWindow {
  startMs: number
  endMs: number
}

/** Below this depth the buffer has no meaningful catch-up window: the label says so rather
 *  than showing "0m behind live" for the few seconds of live-edge slack every HLS stream
 *  carries anyway. */
export const WINDOW_EXTENT_MIN_MS = 60_000

/**
 * The marker list for the seek bar: programmes clipped onto the seekable window, ordered left
 * to right. No listings (M3U profiles never fetch any; a provider with no guide returns none)
 * or no overlap with the buffer yields an empty list — PlayerSeekBar keeps the plain bar, no
 * empty chrome.
 */
export function buildCatchupTimeline(
  seekable: CatchupSeekableWindow,
  programmes: ShortEpgProgram[],
  nowMs: number
): CatchupMarker[] {
  const windowMs = seekable.endMs - seekable.startMs
  if (!(windowMs > 0)) return []
  const markers: CatchupMarker[] = []
  for (const programme of programmes) {
    const startMs = Number(programme.start_timestamp) * 1000
    const stopMs = Number(programme.stop_timestamp) * 1000
    if (Number.isNaN(startMs) || Number.isNaN(stopMs)) continue // unparseable — drop rather than misplace
    const clippedStart = Math.max(startMs, seekable.startMs)
    const clippedStop = Math.min(stopMs, seekable.endMs)
    if (clippedStop <= clippedStart) continue // outside the buffer entirely — nothing to show
    markers.push({
      title: programme.title || 'Untitled programme',
      startFraction: Math.min(1, Math.max(0, (clippedStart - seekable.startMs) / windowMs)),
      endFraction: Math.min(1, Math.max(0, (clippedStop - seekable.startMs) / windowMs)),
      isCurrent: startMs <= nowMs && nowMs < stopMs,
      startMs,
      stopMs
    })
  }
  return markers.sort((a, b) => a.startFraction - b.startFraction)
}

/**
 * What the buffer's depth is worth in words, shown beside the marker strip: how far behind the
 * live edge the seekable window actually reaches. "3.2h behind live" for a real archive
 * window; "2m" for the shallow windows a just-started timeshift or a small buffer carries;
 * "at live" when there is no meaningful depth (below WINDOW_EXTENT_MIN_MS, or — the degenerate
 * window — an end at or before the start). The extent never counts buffer beyond `nowMs`: a
 * window end after now is future slack, not reachable depth.
 */
export function windowExtentLabel(seekable: CatchupSeekableWindow, nowMs: number): string {
  const extentMs = Math.min(seekable.endMs, nowMs) - seekable.startMs
  if (!(extentMs >= WINDOW_EXTENT_MIN_MS)) return 'at live'
  const extentHours = extentMs / HOUR_MS
  if (extentHours >= 1) return `${extentHours.toFixed(1)}h behind live`
  return `${Math.floor(extentMs / 60_000)}m behind live`
}
