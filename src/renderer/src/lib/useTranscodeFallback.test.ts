import { describe, it, expect } from 'vitest'
import {
  isUnsupportedAudioCodecError,
  isRawStreamManifestError,
  shouldRestartRemuxChain,
  MAX_REMUX_CHAIN_RESTARTS
} from './useTranscodeFallback'
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

  it('accepts the whole "that was not a usable playlist" family', () => {
    // Widened 2026-09-27 after reproducing both shapes in a real Chromium: a raw-TS body the
    // panel *ends* surfaces as manifestParsingError, but a genuinely live one never reaches the
    // parser at all and surfaces as manifestLoadTimeOut once the manifest load policy is spent —
    // which is the shape the original single-detail check could never match.
    expect(isRawStreamManifestError(errorData({ details: 'manifestLoadTimeOut' as never }))).toBe(true)
    expect(isRawStreamManifestError(errorData({ details: 'manifestLoadError' as never }))).toBe(true)
    expect(isRawStreamManifestError(errorData({ details: 'levelEmptyError' as never }))).toBe(true)
  })

  it('ignores failures that are not about the playlist at all', () => {
    // These are the ones that must NOT spend the channel's single remux attempt — a failed
    // *fragment* (or a codec append) is not a missing playlist, and treating it as one is what
    // left the player with no recovery and a terminal "gave up after N retries" message.
    expect(isRawStreamManifestError(errorData({ details: 'fragLoadError' as never }))).toBe(false)
    expect(isRawStreamManifestError(errorData({ details: 'bufferAddCodecError' as never }))).toBe(false)
  })
})

// The bounded-restart decision behind attemptRemuxRecovery: the provider kills paced live
// reader connections at unpredictable intervals (measured live 2026-09-27, one remux dead at
// 11s while the identical invocation ran 75s+ minutes later), so a dead remux must be
// restartable — but never unboundedly, or a genuinely dead channel would spin forever.
describe('shouldRestartRemuxChain', () => {
  it('restarts while the budget lasts', () => {
    expect(shouldRestartRemuxChain(false, 0)).toBe(true)
    expect(shouldRestartRemuxChain(false, MAX_REMUX_CHAIN_RESTARTS - 1)).toBe(true)
  })

  it('refuses once the budget is spent', () => {
    expect(shouldRestartRemuxChain(false, MAX_REMUX_CHAIN_RESTARTS)).toBe(false)
    expect(shouldRestartRemuxChain(false, MAX_REMUX_CHAIN_RESTARTS + 5)).toBe(false)
  })

  it('never double-starts while a recovery is already in flight', () => {
    // The still-attached hls instance keeps raising fatal errors while the replacement remux
    // spins up; absorbing those without spending budget is what makes the restart survive
    // its own startup window.
    expect(shouldRestartRemuxChain(true, 0)).toBe(false)
  })
})
