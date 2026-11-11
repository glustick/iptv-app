import { describe, it, expect } from 'vitest'
import {
  clampRestorePosition,
  isBufferStallError,
  playbackSignature,
  nextStallAction,
  stallRecoveryDelayMs
} from './playbackWatchdog'

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

describe('nextStallAction with the live-edge rung (0.30.0)', () => {
  it('gives live content one cheapest-first jump-to-edge before the old ladder, VOD unchanged', () => {
    expect(nextStallAction(0, 2, true)).toBe('liveEdge')
    expect(nextStallAction(1, 2, true)).toBe('nudge')
    expect(nextStallAction(2, 2, true)).toBe('reload')
    expect(nextStallAction(3, 2, true)).toBe('reload')
    expect(nextStallAction(4, 2, true)).toBe('giveUp')
  })

  it('keeps the VOD ladder byte-identical to pre-0.30.0 for the same inputs', () => {
    expect(nextStallAction(0, 2, false)).toBe('nudge')
    expect(nextStallAction(1, 2, false)).toBe('reload')
    expect(nextStallAction(2, 2, false)).toBe('reload')
    expect(nextStallAction(3, 2, false)).toBe('giveUp')
  })
})

describe('stallRecoveryDelayMs (0.30.0)', () => {
  it('waits the full patience while the buffer is draining — data may still arrive', () => {
    expect(stallRecoveryDelayMs(0, false, 10000)).toBe(10000)
  })

  it('halves the wait when data is buffered ahead or the browser raised stalled', () => {
    expect(stallRecoveryDelayMs(1.2, false, 10000)).toBe(5000)
    expect(stallRecoveryDelayMs(0, true, 10000)).toBe(5000)
  })

  it('treats a sub-quarter-second buffer sliver as no buffer, not as buffered-ahead', () => {
    expect(stallRecoveryDelayMs(0.2, false, 10000)).toBe(10000)
  })
})

describe('playbackSignature buffer-health component (0.30.0)', () => {
  it('keeps the two-component format for callers with no buffer information', () => {
    expect(playbackSignature(4, 10.001)).toBe('4:40')
  })

  it('counts buffer growth as movement — data arriving is not a stall', () => {
    expect(playbackSignature(4, 10.0, 12.0)).not.toBe(playbackSignature(4, 10.0, 20.0))
    expect(playbackSignature(4, 10.0, 12.0)).toBe(playbackSignature(4, 10.0, 12.05))
  })
})

describe('clampRestorePosition (0.30.0)', () => {
  it('clamps into the seekable range, keeping one second of headroom at the end', () => {
    expect(clampRestorePosition(50, 0, 100)).toBe(50)
    expect(clampRestorePosition(120, 0, 100)).toBe(99)
    expect(clampRestorePosition(5, 10, 100)).toBe(10)
  })

  it('answers null when there is nothing sensible to seek to', () => {
    expect(clampRestorePosition(0, 0, 100)).toBeNull()
    expect(clampRestorePosition(-5, 0, 100)).toBeNull()
    expect(clampRestorePosition(Number.NaN, 0, 100)).toBeNull()
    expect(clampRestorePosition(50, 0, 0)).toBeNull()
    expect(clampRestorePosition(50, Number.NaN, 100)).toBeNull()
  })
})
