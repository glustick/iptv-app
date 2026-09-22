import { describe, it, expect } from 'vitest'
import { describeHlsLevel, hasInformativeLevelData } from './hlsLevels'

describe('describeHlsLevel', () => {
  it('leads with the resolution and adds the bitrate', () => {
    expect(describeHlsLevel({ height: 1080, bitrate: 4_800_000 }, 1)).toBe('1080p · 4800 kbps')
  })

  it('falls back to the level name, then to its index, when there is no resolution', () => {
    expect(describeHlsLevel({ name: 'high', bitrate: 2_000_000 }, 0)).toBe('high · 2000 kbps')
    expect(describeHlsLevel({}, 2)).toBe('Level 3')
  })

  it('omits a bitrate that is zero or missing rather than printing "0 kbps"', () => {
    expect(describeHlsLevel({ height: 720 }, 0)).toBe('720p')
  })
})

describe('hasInformativeLevelData', () => {
  it('is false for the flat single-rendition level these providers actually serve', () => {
    expect(hasInformativeLevelData({ width: 0, height: 0, bitrate: 0 })).toBe(false)
    expect(hasInformativeLevelData({})).toBe(false)
    expect(hasInformativeLevelData(null)).toBe(false)
  })

  it('is true as soon as any of the three is present', () => {
    expect(hasInformativeLevelData({ height: 1080 })).toBe(true)
    expect(hasInformativeLevelData({ width: 1920 })).toBe(true)
    expect(hasInformativeLevelData({ bitrate: 1 })).toBe(true)
  })
})
