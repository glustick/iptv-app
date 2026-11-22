import { describe, expect, it } from 'vitest'
import { defaultSeasonFor, nextEpisode, orderedEpisodes, orderedSeasonKeys } from './nextEpisode'
import type { SeriesEpisode, SeriesInfo } from './types'

const episode = (id: string, episodeNum: number, season: number): SeriesEpisode => ({
  id,
  episode_num: episodeNum,
  title: `Episode ${episodeNum}`,
  container_extension: 'mp4',
  season
})

const info = (episodes: Record<string, SeriesEpisode[]>): SeriesInfo => ({
  seasons: Object.keys(episodes).map((key) => ({ season_number: Number(key), name: `Season ${key}`, cover: '' })),
  episodes
})

describe('orderedEpisodes', () => {
  it('sorts seasons numerically, not by object key order', () => {
    // The provider's own mapping is neither sorted nor contiguous; "10" must follow "2".
    const series = info({
      '10': [episode('s10e1', 1, 10)],
      '2': [episode('s2e1', 1, 2)],
      '1': [episode('s1e2', 2, 1), episode('s1e1', 1, 1)]
    })
    expect(orderedEpisodes(series).map((e) => e.id)).toEqual(['s1e1', 's1e2', 's2e1', 's10e1'])
  })

  it('skips an empty season rather than stopping at it', () => {
    const series = info({ '1': [episode('a', 1, 1), episode('b', 2, 1)], '2': [], '3': [episode('c', 1, 3)] })
    expect(orderedEpisodes(series).map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('is empty for a series with no episode data', () => {
    expect(orderedEpisodes(null)).toEqual([])
    expect(orderedEpisodes(undefined)).toEqual([])
    expect(orderedEpisodes(info({}))).toEqual([])
  })
})

describe('nextEpisode', () => {
  it('names the following episode in the same season', () => {
    const series = info({ '1': [episode('a', 1, 1), episode('b', 2, 1), episode('c', 3, 1)] })
    expect(nextEpisode(series, 'a')?.id).toBe('b')
  })

  it('crosses into the next season that actually has episodes', () => {
    const series = info({ '1': [episode('a', 1, 1)], '2': [], '3': [episode('c', 1, 3)] })
    expect(nextEpisode(series, 'a')?.id).toBe('c')
  })

  it('stops at the end of the series rather than wrapping to the pilot', () => {
    const series = info({ '1': [episode('a', 1, 1), episode('b', 2, 1)] })
    expect(nextEpisode(series, 'b')).toBeNull()
  })

  it('answers null for an id that is not in the list, instead of guessing', () => {
    const series = info({ '1': [episode('a', 1, 1)] })
    expect(nextEpisode(series, 'unknown')).toBeNull()
    expect(nextEpisode(null, 'a')).toBeNull()
  })

  it('matches a numeric id against the provider\'s string id', () => {
    const series = info({ '1': [episode('11', 1, 1), episode('12', 2, 1)] })
    expect(nextEpisode(series, 11)?.id).toBe('12')
  })
})

describe('orderedSeasonKeys', () => {
  it('lists the season keys in watch order', () => {
    const series = info({ '10': [episode('s10e1', 1, 10)], '2': [episode('s2e1', 1, 2)], '1': [episode('a', 1, 1)] })
    expect(orderedSeasonKeys(series)).toEqual(['1', '2', '10'])
  })

  it('is empty for no data and drops non-numeric keys, like orderedEpisodes', () => {
    expect(orderedSeasonKeys(null)).toEqual([])
    expect(orderedSeasonKeys(info({}))).toEqual([])
    expect(orderedSeasonKeys(info({ special: [episode('x', 1, 0)] }))).toEqual([])
  })
})

describe('defaultSeasonFor (0.48.0)', () => {
  it('names the season holding the next unwatched episode — where a returning viewer left off', () => {
    const series = info({ '1': [episode('a', 1, 1), episode('b', 2, 1)], '2': [episode('c', 1, 2), episode('d', 2, 2)] })
    expect(defaultSeasonFor(series, (e) => e.id === 'a')).toBe(1)
    // The last episode of season 1 watched: the default crosses the season boundary, exactly
    // where nextEpisode would take the Next button.
    expect(defaultSeasonFor(series, (e) => e.id === 'a' || e.id === 'b')).toBe(2)
  })

  it('walks past an empty season to the one that has episodes', () => {
    const series = info({ '1': [episode('a', 1, 1)], '2': [], '3': [episode('c', 1, 3)] })
    expect(defaultSeasonFor(series, () => false)).toBe(1)
    expect(defaultSeasonFor(series, (e) => e.id === 'a')).toBe(3)
  })

  it('answers the first season when everything is watched — rewatching starts at the pilot', () => {
    const series = info({ '1': [episode('a', 1, 1), episode('b', 2, 1)], '2': [episode('c', 1, 2)] })
    expect(defaultSeasonFor(series, () => true)).toBe(1)
  })

  it('answers null for a single season or no data — no tabs to pick', () => {
    const single = info({ '1': [episode('a', 1, 1)] })
    expect(defaultSeasonFor(single, () => false)).toBeNull()
    expect(defaultSeasonFor(null, () => false)).toBeNull()
    expect(defaultSeasonFor(undefined, () => false)).toBeNull()
    expect(defaultSeasonFor(info({}), () => false)).toBeNull()
  })

  it('answers the first season even when every season is empty — nothing unwatched to find', () => {
    const empty = info({ '1': [], '2': [] })
    expect(defaultSeasonFor(empty, () => false)).toBe(1)
  })
})
