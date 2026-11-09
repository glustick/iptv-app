import { describe, expect, it } from 'vitest'
import { countVideoFailed, hasVideoFailed, isUnsupportedVideoCodecError, pruneUndecodableVideo, videoKey } from './undecodableVideo.js'

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

describe('the video-failed verdict (0.22.0)', () => {
  const entry = (n: number) => ({ failedAt: n })
  const channels = [
    { stream_id: 1, playlistId: undefined },
    { stream_id: 2, playlistId: 'backup' },
    { stream_id: 3, playlistId: 'backup' }
  ]

  it('keys the primary playlist by the bare id and the others by playlist:id', () => {
    expect(videoKey(undefined, 7, undefined)).toBe('7')
    expect(videoKey('primary', 7, 'primary')).toBe('7')
    expect(videoKey('backup', 7, 'primary')).toBe('backup:7')
  })

  it('counts only the channels actually in the failed set', () => {
    const record = { '1': entry(1), 'backup:3': entry(2) }
    expect(countVideoFailed(channels, record, 'primary')).toBe(2)
    expect(countVideoFailed([], record, 'primary')).toBe(0)
  })

  it('asks the same question the badge and the filter ask', () => {
    const record = { 'backup:2': entry(1) }
    expect(hasVideoFailed(record, videoKey('backup', 2, 'primary'))).toBe(true)
    expect(hasVideoFailed(record, videoKey(undefined, 2, 'primary'))).toBe(false)
  })
})
