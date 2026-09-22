/**
 * Classifying a live channel's feed from its own HLS media playlist.
 *
 * Why this exists: several providers answer a *live* channel's URL with a playlist that is
 * already finished — `#EXT-X-ENDLIST` on a live URL — which is a fixed clip on repeat, not a
 * live feed. Measured on this app's own provider (2026-09-21): three unrelated channels returned
 * byte-identical media, the same 12-segment / 120.3s playlist, every one carrying ENDLIST. hls.js
 * reads ENDLIST as "this asset is complete" and plays it as VOD, so such a channel quietly
 * behaves differently from every other channel — it can even end and stop (which is why the
 * player now restarts it). Nothing in the UI said so until now.
 *
 * ENDLIST is the right signal rather than a content fingerprint: it is exact (a playlist with
 * ENDLIST cannot grow, so the channel cannot be live), it needs one small manifest request rather
 * than downloading segments, and it catches any fixed-clip feed — not just this one provider's
 * shared placeholder — while never mislabelling a genuinely advancing stream.
 *
 * Pure and dependency-free; the fetching lives in the store (see probeChannelHealth).
 */

export type ChannelHealth =
  /** Not checked yet (or not checkable) — render nothing. */
  | 'unknown'
  /** An advancing live playlist: the normal case. */
  | 'ok'
  /** A finished playlist on a live channel — a fixed clip on repeat. */
  | 'loop'
  /** Something was fetched, but it wasn't a usable playlist. */
  | 'unavailable'

export interface MediaPlaylistAnalysis {
  hasEndList: boolean
  /** A master playlist (variant streams) rather than a media playlist — see classifyChannelHealth. */
  isMaster: boolean
  mediaSequence: number | null
  segmentCount: number
  durationSeconds: number
}

const MEDIA_SEQUENCE_PREFIX = '#EXT-X-MEDIA-SEQUENCE:'
const EXTINF_PREFIX = '#EXTINF:'

/**
 * Parses just enough of an HLS playlist to classify it, or null if this isn't a playlist at all
 * (an HTML error page, a JSON error body, an empty response).
 */
export function analyzeMediaPlaylist(text: string): MediaPlaylistAnalysis | null {
  // #EXTM3U must be the FIRST line of a playlist — the one cheap, reliable way to tell a real
  // playlist from whatever else a panel might hand back for a stream URL.
  if (!text.trimStart().startsWith('#EXTM3U')) return null

  let hasEndList = false
  let isMaster = false
  let mediaSequence: number | null = null
  let segmentCount = 0
  let durationSeconds = 0

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#EXT-X-ENDLIST')) {
      hasEndList = true
    } else if (line.startsWith('#EXT-X-STREAM-INF')) {
      isMaster = true
    } else if (line.startsWith(MEDIA_SEQUENCE_PREFIX)) {
      const value = Number.parseInt(line.slice(MEDIA_SEQUENCE_PREFIX.length), 10)
      mediaSequence = Number.isFinite(value) ? value : null
    } else if (line.startsWith(EXTINF_PREFIX)) {
      // "#EXTINF:10.000,Some title" — the title (if any) is after the first comma.
      const value = Number.parseFloat(line.slice(EXTINF_PREFIX.length))
      if (Number.isFinite(value) && value > 0) durationSeconds += value
    } else if (!line.startsWith('#')) {
      // A bare line: a segment URI in a media playlist, a variant URI in a master one.
      segmentCount += 1
    }
  }

  // Neither segments nor variants: a playlist header followed by nothing useful.
  if (segmentCount === 0) return null
  return {
    hasEndList,
    isMaster,
    mediaSequence,
    // One decimal is plenty for a duration that only ever appears as "a 2-minute clip".
    durationSeconds: Math.round(durationSeconds * 10) / 10,
    segmentCount
  }
}

/**
 * Turns an analysis into a verdict.
 *
 * A master playlist is deliberately called `ok`: it hands off to variant playlists this function
 * has not seen, so there is nothing here to judge — and refusing to guess is the whole point of
 * only ever flagging what is certain.
 */
export function classifyChannelHealth(analysis: MediaPlaylistAnalysis | null): ChannelHealth {
  if (!analysis) return 'unavailable'
  if (analysis.isMaster) return 'ok'
  return analysis.hasEndList ? 'loop' : 'ok'
}

/** Compound-adjective form ("2-minute", "45-second") — built for the sentence below it. */
function formatLengthWords(seconds: number): string {
  if (seconds < 60) {
    const rounded = Math.max(1, Math.round(seconds))
    return `${rounded}-second`
  }
  return `${Math.round(seconds / 60)}-minute`
}

/**
 * User-facing explanation for a flagged channel, or null when there is nothing worth saying.
 * Shared by the grid's badge tooltip and the preview panel's note so the wording can't drift.
 */
export function describeChannelHealth(health: ChannelHealth, durationSeconds?: number | null): string | null {
  if (health === 'loop') {
    const length = durationSeconds && durationSeconds > 0 ? ` ${formatLengthWords(durationSeconds)}` : ''
    return `This channel is currently serving a fixed${length} loop rather than a live feed`
  }
  if (health === 'unavailable') {
    return "This channel's playlist couldn't be read — it may be offline or restricted right now"
  }
  return null
}
