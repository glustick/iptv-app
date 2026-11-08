// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { isViewMode, loadLastViewMode, saveLastViewMode } from './lastView'

describe('last view mode', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('has no opinion until a tab is chosen', () => {
    expect(loadLastViewMode()).toBeNull()
  })

  it('round-trips every real tab and refuses anything else', () => {
    for (const mode of ['live', 'movies', 'series', 'sports', 'favorites', 'history', 'multiview'] as const) {
      saveLastViewMode(mode)
      expect(loadLastViewMode()).toBe(mode)
    }
    expect(isViewMode('settings')).toBe(false)
    expect(isViewMode(7)).toBe(false)
  })

  it('reads corrupt storage as no opinion rather than as a broken tab', () => {
    window.localStorage.setItem('allisoniptv-last-view', 'not json')
    expect(loadLastViewMode()).toBeNull()
    window.localStorage.setItem('allisoniptv-last-view', JSON.stringify('nowhere'))
    expect(loadLastViewMode()).toBeNull()
  })
})
