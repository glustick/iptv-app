import { describe, it, expect } from 'vitest'
import { pct } from './epgTime'

describe('pct', () => {
  it('maps a time to its percent position within the window', () => {
    expect(pct(50, 0, 100)).toBe(50)
    expect(pct(25, 0, 100)).toBe(25)
    expect(pct(0, 0, 100)).toBe(0)
    expect(pct(100, 0, 100)).toBe(100)
  })

  it('clamps below the window start to 0', () => {
    expect(pct(-50, 0, 100)).toBe(0)
  })

  it('clamps past the window end to 100', () => {
    expect(pct(150, 0, 100)).toBe(100)
  })

  it('returns 0 for a degenerate or inverted window instead of dividing by zero', () => {
    expect(pct(50, 100, 100)).toBe(0)
    expect(pct(50, 100, 0)).toBe(0)
  })

  it('works with real epoch-millisecond magnitudes, not just small numbers', () => {
    const start = 1_800_000_000_000
    const end = start + 3_600_000
    expect(pct(start + 1_800_000, start, end)).toBe(50)
  })
})
