// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { formatPlaybackSpeed, loadPlaybackSpeed, savePlaybackSpeed } from './playbackSpeed'

describe('playback speed', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults to 1x when nothing was ever chosen', () => {
    expect(loadPlaybackSpeed()).toBe(1)
  })

  it('round-trips every speed', () => {
    for (const speed of [0.75, 1.25, 1.5] as const) {
      savePlaybackSpeed(speed)
      expect(loadPlaybackSpeed()).toBe(speed)
    }
  })

  it('treats 1x as the absence of a choice', () => {
    savePlaybackSpeed(1.5)
    savePlaybackSpeed(1)
    expect(loadPlaybackSpeed()).toBe(1)
    expect(window.localStorage.getItem('allisoniptv-playback-speed')).toBeNull()
  })

  it('reads a corrupt or unsupported stored speed as 1x', () => {
    window.localStorage.setItem('allisoniptv-playback-speed', 'not json')
    expect(loadPlaybackSpeed()).toBe(1)
    window.localStorage.setItem('allisoniptv-playback-speed', JSON.stringify(2))
    expect(loadPlaybackSpeed()).toBe(1)
    window.localStorage.setItem('allisoniptv-playback-speed', JSON.stringify('1.5'))
    expect(loadPlaybackSpeed()).toBe(1)
  })

  it('labels speeds the way a player does', () => {
    expect(formatPlaybackSpeed(1)).toBe('1×')
    expect(formatPlaybackSpeed(1.25)).toBe('1.25×')
  })
})
