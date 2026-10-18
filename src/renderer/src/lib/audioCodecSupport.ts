// Whether this browser can decode the audio codec a stream declares. Live TV needs this
// because a Dolby (E-AC-3/AC-3) track is silently dropped by most browsers: the video plays
// perfectly and no error is raised anywhere, so nothing triggers the transcode fallback — the
// reported "channel has no audio" symptom. Deliberately a pure function (same convention as
// liveStreamRecovery.ts) so the decision is unit-testable without a browser or an hls.js
// instance; the caller injects the platform's own capability check.

export type TypeSupportProbe = (mimeType: string) => boolean

const DOLBY_CODECS = ['ec-3', 'ac-3', 'eac3', 'ac3']

/** The fMP4 codec string MSE expects for a Dolby audio codec hls.js reported. */
export function dolbyMseCodec(codec: string): string {
  const normalized = codec.toLowerCase()
  return normalized.includes('ec-3') || normalized.includes('eac3') ? 'ec-3' : 'ac-3'
}

/**
 * True when the codec is either absent, not a Dolby codec, or a Dolby codec this browser's
 * media stack actually reports support for (Safari does, most others don't).
 */
export function canDecodeAudioCodec(codec: string | undefined | null, probe: TypeSupportProbe): boolean {
  if (!codec) return true
  const normalized = codec.toLowerCase()
  if (!DOLBY_CODECS.some((name) => normalized.includes(name))) return true
  try {
    return probe(`audio/mp4;codecs="${dolbyMseCodec(normalized)}"`)
  } catch {
    return false
  }
}
