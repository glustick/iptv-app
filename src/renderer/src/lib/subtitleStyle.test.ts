// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import {
  DEFAULT_SUBTITLE_PREFS,
  SUBTITLE_SIZES,
  loadSubtitlePrefs,
  saveSubtitlePrefs,
  subtitleBackground,
  subtitleCssVariables,
  subtitleTextShadow
} from './subtitleStyle'

describe('subtitle preferences', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults to what the browser already drew: white on black, platform size, no outline', () => {
    expect(loadSubtitlePrefs()).toEqual(DEFAULT_SUBTITLE_PREFS)
    expect(DEFAULT_SUBTITLE_PREFS).toEqual({ size: 100, color: 'white', box: 'solid', outline: false })
  })

  it('round-trips every choice', () => {
    saveSubtitlePrefs({ size: 150, color: 'yellow', box: 'light', outline: true })
    expect(loadSubtitlePrefs()).toEqual({ size: 150, color: 'yellow', box: 'light', outline: true })
  })

  it('resets a corrupt field without discarding the good ones', () => {
    window.localStorage.setItem(
      'allisoniptv-subtitle-prefs',
      JSON.stringify({ size: 999, color: 'yellow', box: 'none', outline: 'yes' })
    )
    expect(loadSubtitlePrefs()).toEqual({ size: 100, color: 'yellow', box: 'none', outline: false })
  })

  it('reads unparseable storage as the default', () => {
    window.localStorage.setItem('allisoniptv-subtitle-prefs', 'not json')
    expect(loadSubtitlePrefs()).toEqual(DEFAULT_SUBTITLE_PREFS)
    window.localStorage.setItem('allisoniptv-subtitle-prefs', JSON.stringify('yellow'))
    expect(loadSubtitlePrefs()).toEqual(DEFAULT_SUBTITLE_PREFS)
  })

  it('normalizes on write, so a bad value never reaches storage', () => {
    saveSubtitlePrefs({ size: 130 as never, color: 'pink' as never, box: 'solid', outline: true })
    expect(loadSubtitlePrefs()).toEqual({ size: 100, color: 'white', box: 'solid', outline: true })
  })
})

describe('subtitleCssVariables', () => {
  it('maps every choice onto the properties the ::cue rule reads', () => {
    expect(subtitleCssVariables({ size: 125, color: 'cyan', box: 'light', outline: true })).toEqual({
      '--cue-color': '#7fe3ff',
      '--cue-font-size': '125%',
      '--cue-bg': 'rgba(0, 0, 0, 0.45)',
      '--cue-shadow': '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000'
    })
  })

  it('offers no box as a transparent background, not a missing property', () => {
    expect(subtitleBackground('none')).toBe('transparent')
    expect(subtitleTextShadow(false)).toBe('none')
  })

  it('keeps the size list honest', () => {
    expect(SUBTITLE_SIZES).toEqual([75, 100, 125, 150, 200])
  })
})
