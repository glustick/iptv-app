import { describe, it, expect } from 'vitest'
import { updateModeForPlatform, downloadPageUrl, RELEASES_URL } from './updateMode'

describe('updateModeForPlatform', () => {
  it('is manual on macOS, where an unsigned build cannot be updated in place', () => {
    expect(updateModeForPlatform('darwin')).toBe('manual')
  })

  it('keeps the in-app updater everywhere else, including Windows and Linux', () => {
    for (const platform of ['win32', 'linux', 'freebsd']) {
      expect(updateModeForPlatform(platform)).toBe('auto')
    }
  })

  it('defaults to auto when the platform is unknown — never hide an affordance that may work', () => {
    expect(updateModeForPlatform(null)).toBe('auto')
    expect(updateModeForPlatform(undefined)).toBe('auto')
  })
})

describe('downloadPageUrl', () => {
  it('points at the specific release when the version is a real one', () => {
    expect(downloadPageUrl('0.7.102')).toBe(`${RELEASES_URL}/tag/v0.7.102`)
  })

  it('falls back to the releases list rather than inventing a tag', () => {
    expect(downloadPageUrl(null)).toBe(RELEASES_URL)
    expect(downloadPageUrl('   ')).toBe(RELEASES_URL)
    expect(downloadPageUrl('latest')).toBe(RELEASES_URL)
    expect(downloadPageUrl('v0.7.102')).toBe(RELEASES_URL)
  })
})
