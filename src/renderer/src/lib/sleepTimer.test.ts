import { describe, expect, it } from 'vitest'
import { nextSleepMode, sleepModeLabel, sleepOptions } from './sleepTimer'

describe('sleep timer cycle', () => {
  it('cycles through the presets and back to off', () => {
    expect(nextSleepMode(null, false)).toBe(15)
    expect(nextSleepMode(15, false)).toBe(30)
    expect(nextSleepMode(90, false)).toBeNull()
  })

  it('offers "end of title" only where there is a title to end', () => {
    expect(sleepOptions(false)).toEqual([null, 15, 30, 60, 90])
    expect(sleepOptions(true)).toEqual([null, 'end', 15, 30, 60, 90])
    expect(nextSleepMode(null, true)).toBe('end')
    expect(nextSleepMode('end', true)).toBe(15)
    expect(nextSleepMode(90, true)).toBeNull()
  })

  it('resets to off from an unknown mode rather than sticking', () => {
    // A mode outside the cycle can only come from a bug or a stale shape; turning the timer off
    // is the harmless answer, and the next click starts the cycle properly.
    expect(nextSleepMode(7 as never, false)).toBeNull()
  })
})

describe('sleep timer labels', () => {
  it('names the two kinds of mode and counts the rest down', () => {
    expect(sleepModeLabel(null, null)).toBe('Sleep Timer')
    expect(sleepModeLabel('end', null)).toBe('Sleep: End of title')
    expect(sleepModeLabel(15, 900)).toBe('15:00')
    expect(sleepModeLabel(15, 65)).toBe('1:05')
    expect(sleepModeLabel(15, null)).toBe('15m')
  })
})
