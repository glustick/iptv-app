// @vitest-environment jsdom
//
// The order lives in the renderer's own localStorage (per device, per kind), validated on read
// so a corrupt value can never reorder a catalogue by accident. jsdom gives each test file a
// real localStorage.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  listOrderOptions,
  loadListOrder,
  parseProviderTimestamp,
  saveListOrder,
  sortSeries,
  sortVodStreams
} from './listOrder'
import type { SeriesItem, VodStream } from './types'

const film = (id: number, name: string, added: string): VodStream => ({
  num: id,
  name,
  stream_type: 'movie',
  stream_id: id,
  stream_icon: '',
  rating: '',
  rating_5based: 0,
  added,
  category_id: '1',
  container_extension: 'mp4'
})

const show = (id: number, name: string, releaseDate: string): SeriesItem => ({
  num: id,
  name,
  series_id: id,
  cover: '',
  plot: '',
  cast: '',
  director: '',
  genre: '',
  releaseDate,
  rating: '',
  category_id: '1'
})

describe('list order storage', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults to provider order when nothing was ever saved', () => {
    expect(loadListOrder('movie')).toBe('provider')
    expect(loadListOrder('series')).toBe('provider')
  })

  it('round-trips each kind separately', () => {
    saveListOrder('movie', 'az')
    saveListOrder('series', 'newest')
    expect(loadListOrder('movie')).toBe('az')
    expect(loadListOrder('series')).toBe('newest')
  })

  it('provider order removes the stored key, so absence stays the default', () => {
    saveListOrder('movie', 'newest')
    saveListOrder('movie', 'provider')
    expect(loadListOrder('movie')).toBe('provider')
    expect(window.localStorage.getItem('allisoniptv-list-order-movie')).toBeNull()
  })

  it('reads a corrupt stored value as provider order', () => {
    window.localStorage.setItem('allisoniptv-list-order-movie', 'not json')
    expect(loadListOrder('movie')).toBe('provider')
    window.localStorage.setItem('allisoniptv-list-order-movie', JSON.stringify('random'))
    expect(loadListOrder('movie')).toBe('provider')
  })

  it('labels the newest option by what the date actually is', () => {
    expect(listOrderOptions('movie').map((o) => o.label)).toEqual(['Provider order', 'A–Z', 'Newest added'])
    expect(listOrderOptions('series').map((o) => o.label)).toEqual(['Provider order', 'A–Z', 'Newest release'])
  })
})

describe('parseProviderTimestamp', () => {
  it('reads the three shapes a panel actually sends', () => {
    // Unix seconds as a string, milliseconds, and a date string.
    expect(parseProviderTimestamp('1621234567')).toBe(1621234567000)
    expect(parseProviderTimestamp(1621234567)).toBe(1621234567000)
    expect(parseProviderTimestamp('1621234567000')).toBe(1621234567000)
    expect(parseProviderTimestamp('2023-05-17T10:00:00Z')).toBe(Date.parse('2023-05-17T10:00:00Z'))
    expect(parseProviderTimestamp('2023-05-17 10:00:00')).not.toBeNull()
  })

  it('answers null for absent or nonsense dates rather than pretending it was 1970', () => {
    expect(parseProviderTimestamp('')).toBeNull()
    expect(parseProviderTimestamp('   ')).toBeNull()
    expect(parseProviderTimestamp('0000-00-00')).toBeNull()
    expect(parseProviderTimestamp('not a date')).toBeNull()
    expect(parseProviderTimestamp(null)).toBeNull()
    expect(parseProviderTimestamp(0)).toBeNull()
    expect(parseProviderTimestamp(-5)).toBeNull()
  })
})

describe('sortVodStreams', () => {
  const films = [
    film(1, 'Zulu', '1621234567'),
    film(2, 'Amélie', '1621234568'),
    film(3, 'Café Society', ''),
    film(4, 'Avatar', '1621234569')
  ]

  it('returns the provider array untouched, by identity, for provider order', () => {
    expect(sortVodStreams(films, 'provider')).toBe(films)
  })

  it('sorts A–Z, folded, without mutating the input', () => {
    const sorted = sortVodStreams(films, 'az')
    expect(sorted.map((f) => f.name)).toEqual(['Amélie', 'Avatar', 'Café Society', 'Zulu'])
    expect(films.map((f) => f.name)).toEqual(['Zulu', 'Amélie', 'Café Society', 'Avatar'])
  })

  it('sorts newest first, with an undated title last', () => {
    expect(sortVodStreams(films, 'newest').map((f) => f.name)).toEqual([
      'Avatar',
      'Amélie',
      'Zulu',
      'Café Society'
    ])
  })

  it('keeps provider order between titles that tie', () => {
    const tied = [film(1, 'B', '1621234567'), film(2, 'A', '1621234567')]
    expect(sortVodStreams(tied, 'newest').map((f) => f.stream_id)).toEqual([1, 2])
    const sameName = [film(1, 'Café', '1621234567'), film(2, 'Cafe', '1621234568')]
    expect(sortVodStreams(sameName, 'az').map((f) => f.stream_id)).toEqual([1, 2])
  })
})

describe('sortSeries', () => {
  it('orders by release date, newest first, undated last', () => {
    const shows = [
      show(1, 'Old Show', '2015-01-01'),
      show(2, 'New Show', '2024-06-01'),
      show(3, 'No Date', ''),
      show(4, 'Middle Show', '2020-01-01')
    ]
    expect(sortSeries(shows, 'newest').map((s) => s.name)).toEqual([
      'New Show',
      'Middle Show',
      'Old Show',
      'No Date'
    ])
  })

  it('sorts A–Z as well as films do', () => {
    const shows = [show(1, 'Zeta', ''), show(2, 'álpha', '')]
    expect(sortSeries(shows, 'az').map((s) => s.name)).toEqual(['álpha', 'Zeta'])
  })
})
