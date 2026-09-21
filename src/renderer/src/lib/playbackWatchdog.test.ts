import { describe, it, expect } from 'vitest'
import { isBufferStallError, playbackSignature, nextStallAction } from './playbackWatchdog'

describe('isBufferStallError', () => {
  it('recognises the "no data at the playhead" family hls.js emits once its own nudge ladder gives up', () => {
    expect(isBufferStallError('bufferStalledError')).toBe(true)
    expect(isBufferStallError('bufferSeekOverHole')).toBe(true)
    expect(isBufferStallError('bufferNudgeOnStall')).toBe(true)
  })

  it('does not claim decode failures or unrelated errors', () => {
    for (const details of ['bufferAppendError', 'bufferAddCodecError', 'fragParsingError', 'fragLoadError', 'manifestLoadError', '']) {
      expect(isBufferStallError(details)).toBe(false)
    }
  })
})

describe('playbackSignature', () => {
  it('is stable across sub-quarter-second jitter, which is what a stateless watchdog needs', () => {
    // All three land in the same quarter-second bucket ("4:40").
    expect(playbackSignature(4, 10.001)).toBe('4:40')
    expect(playbackSignature(4, 10.09)).toBe('4:40')
    expect(playbackSignature(4, 10.12)).toBe('4:40')
  })

  it('changes for real movement, and for a readiness change at the same position', () => {
    expect(playbackSignature(4, 10.3)).not.toBe(playbackSignature(4, 10.001))
    expect(playbackSignature(2, 10.001)).not.toBe(playbackSignature(4, 10.001))
  })
})

describe('nextStallAction', () => {
  it('starts cheap and escalates: nudge, then bounded reloads, then gives up', () => {
    expect(nextStallAction(0)).toBe('nudge')
    expect(nextStallAction(1)).toBe('reload')
    expect(nextStallAction(2)).toBe('reload')
    expect(nextStallAction(3)).toBe('giveUp')
    expect(nextStallAction(99)).toBe('giveUp')
  })

  it('honours a custom reload budget (0 = never reload, one nudge then give up)', () => {
    expect(nextStallAction(0, 0)).toBe('nudge')
    expect(nextStallAction(1, 0)).toBe('giveUp')
  })
})
