import { describe, it, expect } from 'vitest'
import { isUnsupportedAudioCodecError, isRawStreamManifestError } from './useTranscodeFallback'
import type { ErrorData } from 'hls.js'

// Only the fields these detectors actually read — a real ErrorData carries a lot more, but
// this is what the detection logic keys off.
function errorData(overrides: Partial<ErrorData>): ErrorData {
  return { type: 'mediaError', fatal: true, ...overrides } as ErrorData
}

describe('isUnsupportedAudioCodecError', () => {
  it('detects a fragParsingError whose reason mentions EC-3', () => {
    expect(
      isUnsupportedAudioCodecError(errorData({ details: 'fragParsingError' as never, reason: 'Unsupported EC-3 in M2TS found' }))
    ).toBe(true)
  })

  it('detects a fragParsingError whose reason mentions AC-3 (no hyphen)', () => {
    expect(isUnsupportedAudioCodecError(errorData({ details: 'fragParsingError' as never, reason: 'unsupported ac3 track' }))).toBe(
      true
    )
  })

  it('ignores a fragParsingError for an unrelated reason', () => {
    expect(
      isUnsupportedAudioCodecError(errorData({ details: 'fragParsingError' as never, reason: 'invalid NAL unit' }))
    ).toBe(false)
  })

  it('detects a bufferAddCodecError on an audio mimeType', () => {
    expect(
      isUnsupportedAudioCodecError(errorData({ details: 'bufferAddCodecError' as never, mimeType: 'audio/mp4; codecs="ec-3"' }))
    ).toBe(true)
  })

  it('detects a bufferAppendError on an audio mimeType', () => {
    expect(isUnsupportedAudioCodecError(errorData({ details: 'bufferAppendError' as never, mimeType: 'audio/mp4' }))).toBe(true)
  })

  it('ignores a bufferAddCodecError on a video mimeType', () => {
    expect(
      isUnsupportedAudioCodecError(errorData({ details: 'bufferAddCodecError' as never, mimeType: 'video/mp4; codecs="hvc1"' }))
    ).toBe(false)
  })

  it('ignores unrelated error details entirely', () => {
    expect(isUnsupportedAudioCodecError(errorData({ details: 'manifestLoadError' as never }))).toBe(false)
  })
})

// See isRawStreamManifestError's own doc comment: the provider's panel answers every live
// stream URL with raw MPEG-TS bytes (confirmed live 2026-09-26), which hls.js — a text-playlist
// parser — can only ever report as a manifest parsing failure.
describe('isRawStreamManifestError', () => {
  it('detects a manifestParsingError', () => {
    expect(isRawStreamManifestError(errorData({ details: 'manifestParsingError' as never, type: 'networkError' as never }))).toBe(
      true
    )
  })

  it('ignores the audio-codec failures the other detector owns', () => {
    expect(
      isRawStreamManifestError(errorData({ details: 'fragParsingError' as never, reason: 'Unsupported EC-3 in M2TS found' }))
    ).toBe(false)
    expect(isRawStreamManifestError(errorData({ details: 'bufferAppendError' as never, mimeType: 'audio/mp4' }))).toBe(false)
  })

  it('ignores load/other failures — a failed download is not a broken playlist', () => {
    expect(isRawStreamManifestError(errorData({ details: 'manifestLoadError' as never }))).toBe(false)
    expect(isRawStreamManifestError(errorData({ details: 'levelEmptyError' as never }))).toBe(false)
  })
})
