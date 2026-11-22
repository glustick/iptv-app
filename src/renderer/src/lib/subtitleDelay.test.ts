import { describe, expect, it } from 'vitest'
import { applySubtitleDelay, clearSubtitleDelay, computeCueShift, type CueLike, type DelayableTrack } from './subtitleDelay'

// Plain cue-shaped objects, not real VTTCue: everything this module touches is the two mutable
// numbers, and in Chromium a real VTTCue's startTime/endTime are exactly that — writable doubles.
// The structural types keep the lib honest about that without needing a DOM to test it.
function cue(start: number, end: number): CueLike {
  return { startTime: start, endTime: end }
}

function track(...cues: CueLike[]): DelayableTrack & { cues: CueLike[] } {
  // A real TextTrack.cues is an indexable list; an array satisfies the same shape and stays
  // mutable so tests can push "newly parsed" cues into it.
  return { cues }
}

describe('computeCueShift', () => {
  it('moves a cue by the offset, converting ms to the cue seconds', () => {
    expect(computeCueShift(10, 12, 300)).toEqual({ start: 10.3, end: 12.3 })
    expect(computeCueShift(4, 6.5, -500)).toEqual({ start: 3.5, end: 6 })
    expect(computeCueShift(2, 3, 0)).toEqual({ start: 2, end: 3 })
  })

  it('rounds to millisecond precision so repeated shifts cannot accumulate float noise', () => {
    expect(computeCueShift(1.234567, 2.234567, 250)).toEqual({ start: 1.485, end: 2.485 })
  })

  it('treats a non-finite offset as none', () => {
    expect(computeCueShift(1, 2, Number.NaN)).toEqual({ start: 1, end: 2 })
  })
})

describe('applySubtitleDelay', () => {
  it('shifts every cue the track holds and reports the shifted times', () => {
    const a = cue(1, 3)
    const b = cue(5, 6)
    const t = track(a, b)

    applySubtitleDelay(t, 300)

    expect(a.startTime).toBe(1.3)
    expect(a.endTime).toBe(3.3)
    expect(b.startTime).toBe(5.3)
    expect(b.endTime).toBe(6.3)
  })

  it('clearing restores the original times exactly', () => {
    const a = cue(1, 3)
    const t = track(a)

    applySubtitleDelay(t, -250)
    clearSubtitleDelay(t)

    expect(a.startTime).toBe(1)
    expect(a.endTime).toBe(3)
  })

  it('an offset of 0 is itself the restore', () => {
    const a = cue(2, 4)
    const t = track(a)

    applySubtitleDelay(t, 100)
    applySubtitleDelay(t, 0)

    expect(a.startTime).toBe(2)
    expect(a.endTime).toBe(4)
  })

  it('a changed offset re-shifts from the ORIGINAL times, never compounding the last delta', () => {
    const a = cue(1, 3)
    const t = track(a)

    applySubtitleDelay(t, 100)
    expect(a.startTime).toBe(1.1)
    applySubtitleDelay(t, 500)
    // +100 then +500 must be +500 in total, not +600: the second click rebuilds from the cue's
    // own time, which is the difference between a control and an accumulator.
    expect(a.startTime).toBe(1.5)
    expect(a.endTime).toBe(3.5)
    applySubtitleDelay(t, -500)
    expect(a.startTime).toBe(0.5)
    expect(a.endTime).toBe(2.5)
  })

  it('cues parsed after the first apply shift once, and the already-shifted ones do not move again', () => {
    const first = cue(1, 3)
    const t = track(first)

    applySubtitleDelay(t, 300)
    // The next WebVTT fragment arrives: a fresh cue at its own parsed (unshifted) time, and the
    // cuechange handler calls apply again with the same offset.
    const second = cue(8, 10)
    t.cues.push(second)
    applySubtitleDelay(t, 300)

    expect(first.startTime).toBe(1.3)
    expect(second.startTime).toBe(8.3)
    // ...and a later offset change moves BOTH from their originals.
    applySubtitleDelay(t, -100)
    expect(first.startTime).toBe(0.9)
    expect(second.startTime).toBe(7.9)
  })

  it('a track that never had cues just does nothing', () => {
    const t = track()
    expect(() => applySubtitleDelay(t, 300)).not.toThrow()
    expect(t.cues).toEqual([])
  })

  it('a null cue list does not throw', () => {
    expect(() => applySubtitleDelay({ cues: null }, 300)).not.toThrow()
  })
})

describe('clearSubtitleDelay', () => {
  it('a track that was never shifted is a no-op', () => {
    const a = cue(1, 3)
    const t = track(a)

    clearSubtitleDelay(t)

    expect(a.startTime).toBe(1)
    expect(a.endTime).toBe(3)
  })

  it('a cleared track starts its snapshot over, so a fresh apply is not polluted by the past', () => {
    const a = cue(1, 3)
    const t = track(a)

    applySubtitleDelay(t, 100)
    clearSubtitleDelay(t)
    applySubtitleDelay(t, 100)

    expect(a.startTime).toBe(1.1)
    expect(a.endTime).toBe(3.1)
  })
})

describe('multiple tracks', () => {
  it('shift independently: one track\'s offset never leaks into another\'s cues', () => {
    const a = cue(1, 3)
    const b = cue(1, 3)
    const tA = track(a)
    const tB = track(b)

    applySubtitleDelay(tA, 300)

    expect(a.startTime).toBe(1.3)
    expect(b.startTime).toBe(1)

    applySubtitleDelay(tB, -100)

    expect(a.startTime).toBe(1.3)
    expect(b.startTime).toBe(0.9)

    // Clearing one leaves the other's shift standing.
    clearSubtitleDelay(tA)
    expect(a.startTime).toBe(1)
    expect(b.startTime).toBe(0.9)
  })
})
