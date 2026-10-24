import type { ErrorData } from 'hls.js'

// The count-first half of "what does 'broken channel' mean beyond the manifest" (0.16.1): the
// health probe answers "is this feed live?", and the audio-fix transcode rescues the AC-3/E-AC-3
// family — what nothing records is a channel that is LIVE but whose VIDEO this machine cannot
// decode. This module is deliberately a COUNT, not detection or handling: the roadmap's own rule
// is to measure whether the population exists before building for it. When a codec-shaped video
// error fires, the channel's composite key lands in a bounded persisted set and the EPG panel
// shows the count; a channel that later plays (its video decode counters move while watching)
// self-heals out of the set.

/**
 * A codec-shaped VIDEO failure: the SourceBuffer refused an append for a non-audio track —
 * the video mirror of `isUnsupportedAudioCodecError`. No amount of retrying fixes this, and
 * the audio-fix transcode never intercepts it (its classifier only matches audio mimeTypes),
 * so anything matching here is exactly the "live but undecodable video" population.
 */
export function isUnsupportedVideoCodecError(data: ErrorData): boolean {
  return (
    (data.details === 'bufferAddCodecError' || data.details === 'bufferAppendError') &&
    typeof data.mimeType === 'string' &&
    !data.mimeType.toLowerCase().includes('audio')
  )
}

export interface UndecodableVideoEntry {
  failedAt: number
}

export const UNDECODABLE_VIDEO_MAX_ENTRIES = 500

/**
 * Keep-newest by failedAt, the same shape as `pruneTranscodeMemory`: returns the same reference
 * while under the cap (the common case — most machines will hold a handful at most), otherwise
 * drops the oldest failures first.
 */
export function pruneUndecodableVideo(
  record: Record<string, UndecodableVideoEntry>,
  cap = UNDECODABLE_VIDEO_MAX_ENTRIES
): Record<string, UndecodableVideoEntry> {
  const keys = Object.keys(record)
  if (keys.length <= cap) return record
  const newestFirst = keys.sort((a, b) => (record[b]?.failedAt ?? 0) - (record[a]?.failedAt ?? 0))
  const kept: Record<string, UndecodableVideoEntry> = {}
  for (const key of newestFirst.slice(0, cap)) kept[key] = record[key]
  return kept
}
