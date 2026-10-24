import { describe, expect, it } from 'vitest'
import { isUnsupportedVideoCodecError, pruneUndecodableVideo } from './undecodableVideo.js'

// hls.js types ErrorDetails as an enum; the string literals are what actually arrive at runtime.
const errorData = (partial: Record<string, unknown>): Parameters<typeof isUnsupportedVideoCodecError>[0] =>
  partial as unknown as Parameters<typeof isUnsupportedVideoCodecError>[0]

// The count-first diagnostic for live-but-undecodable-video channels (0.16.1).

describe('isUnsupportedVideoCodecError', () => {
  it('matches a refused append for a video track', () => {
    expect(
      isUnsupportedVideoCodecError(errorData({ details: 'bufferAddCodecError', mimeType: 'video/mp4; codecs="hvc1.1.6.L93.B0"' }))
    ).toBe(true)
    expect(isUnsupportedVideoCodecError(errorData({ details: 'bufferAppendError', mimeType: 'video/mp2t' }))).toBe(true)
  })

  it('never matches the audio family — those are the audio fix\'s to rescue, not ours to count', () => {
    expect(isUnsupportedVideoCodecError(errorData({ details: 'bufferAddCodecError', mimeType: 'audio/mp4; codecs="ec-3"' }))).toBe(false)
    expect(isUnsupportedVideoCodecError(errorData({ details: 'fragParsingError', reason: 'Failed to parse EC-3' }))).toBe(false)
  })

  it('ignores everything that is not a codec-shaped append failure', () => {
    expect(isUnsupportedVideoCodecError(errorData({ details: 'manifestLoadError' }))).toBe(false)
    expect(isUnsupportedVideoCodecError(errorData({ details: 'fragParsingError' }))).toBe(false)
    expect(isUnsupportedVideoCodecError(errorData({}))).toBe(false)
  })
})

describe('pruneUndecodableVideo', () => {
  const entry = (failedAt: number): { failedAt: number } => ({ failedAt })

  it('returns the same reference while under the cap', () => {
    const record = { a: entry(1), b: entry(2) }
    expect(pruneUndecodableVideo(record, 5)).toBe(record)
  })

  it('past the cap, keeps the newest failures and drops the oldest', () => {
    const record: Record<string, { failedAt: number }> = {}
    for (let i = 0; i < 6; i++) record[`ch${i}`] = entry(i)
    const pruned = pruneUndecodableVideo(record, 4)
    expect(Object.keys(pruned).sort()).toEqual(['ch2', 'ch3', 'ch4', 'ch5'])
  })
})
