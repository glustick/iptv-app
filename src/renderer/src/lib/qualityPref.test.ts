// @vitest-environment jsdom
//
// The quality pref lives in the renderer's own localStorage (per device — it is a statement
// about this machine's playback), validated on both write and load so a garbage value can never
// travel to the encoder's filter chain. jsdom provides a real localStorage per test file.
import { describe, it, expect, beforeEach } from 'vitest'
import { isValidMaxHeight, loadQualityMaxHeight, saveQualityMaxHeight } from './qualityPref'

describe('qualityPref', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults to Source when nothing was ever saved', () => {
    expect(loadQualityMaxHeight()).toBeNull()
  })

  it('round-trips a chosen ceiling', () => {
    saveQualityMaxHeight(720)
    expect(loadQualityMaxHeight()).toBe(720)
    saveQualityMaxHeight(1080)
    expect(loadQualityMaxHeight()).toBe(1080)
  })

  it('Source clears the stored choice entirely', () => {
    saveQualityMaxHeight(720)
    saveQualityMaxHeight(null)
    expect(loadQualityMaxHeight()).toBeNull()
    expect(window.localStorage.getItem('allisoniptv-quality-pref')).toBeNull()
  })

  it('normalizes on write: garbage becomes Source, never a stored bad value', () => {
    saveQualityMaxHeight(5000)
    expect(loadQualityMaxHeight()).toBeNull()
    saveQualityMaxHeight(720.6)
    expect(loadQualityMaxHeight()).toBe(721)
  })

  it('reads a corrupt or out-of-bounds stored value as Source', () => {
    window.localStorage.setItem('allisoniptv-quality-pref', 'not json')
    expect(loadQualityMaxHeight()).toBeNull()
    window.localStorage.setItem('allisoniptv-quality-pref', JSON.stringify(5000))
    expect(loadQualityMaxHeight()).toBeNull()
    window.localStorage.setItem('allisoniptv-quality-pref', JSON.stringify('720'))
    expect(loadQualityMaxHeight()).toBeNull()
  })

  it('isValidMaxHeight mirrors the main process bounds', () => {
    expect(isValidMaxHeight(240)).toBe(true)
    expect(isValidMaxHeight(2160)).toBe(true)
    expect(isValidMaxHeight(239)).toBe(false)
    expect(isValidMaxHeight(2161)).toBe(false)
    expect(isValidMaxHeight(Number.NaN)).toBe(false)
    expect(isValidMaxHeight('720')).toBe(false)
  })
})
