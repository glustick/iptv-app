import { describe, expect, it } from 'vitest'
import { countByKind, searchAll, type SearchEntry } from './globalSearch'

const entries: SearchEntry[] = [
  { kind: 'live', id: 1, name: 'Sky Sports Main Event' },
  { kind: 'live', id: 2, name: '101 BBC One HD' },
  { kind: 'movie', id: 3, name: 'Sports Night', extension: 'mkv' },
  { kind: 'series', id: 4, name: 'The Sporting Life' },
  { kind: 'movie', id: 5, name: 'Heat', extension: 'mp4' }
]

describe('one search across everything', () => {
  it('ranks a name that starts with the query above one that merely contains it', () => {
    const hits = searchAll(entries, 'sport')
    expect(hits[0].name).toBe('Sports Night') // starts with "sports"
    expect(hits.map((h) => h.name)).toContain('Sky Sports Main Event') // word boundary
    expect(hits.map((h) => h.name)).toContain('The Sporting Life') // substring ("sporting")
    expect(hits.map((h) => h.name)).not.toContain('Heat')
  })

  it('matches a word inside a numbered channel name', () => {
    expect(searchAll(entries, 'bbc').map((h) => h.name)).toEqual(['101 BBC One HD'])
  })

  it('ignores case and accents', () => {
    const accented: SearchEntry[] = [{ kind: 'movie', id: 9, name: 'Amélie' }]
    expect(searchAll(accented, 'amelie')).toHaveLength(1)
    expect(searchAll(accented, 'AMÉLIE')).toHaveLength(1)
  })

  it('asks for at least two characters', () => {
    expect(searchAll(entries, 's')).toEqual([])
    expect(searchAll(entries, '  ')).toEqual([])
  })

  it('keeps the catalogue order within a score and kind', () => {
    const same: SearchEntry[] = [
      { kind: 'movie', id: 1, name: 'Alpha One' },
      { kind: 'movie', id: 2, name: 'Alpha Two' }
    ]
    expect(searchAll(same, 'alpha').map((h) => h.name)).toEqual(['Alpha One', 'Alpha Two'])
  })

  it('caps the list and counts by kind', () => {
    const many: SearchEntry[] = Array.from({ length: 50 }, (_, i) => ({ kind: 'live', id: i, name: `Channel ${i}` }))
    expect(searchAll(many, 'channel', 10)).toHaveLength(10)
    expect(countByKind(searchAll(entries, 'sport'))).toEqual({ live: 1, movie: 1, series: 1 })
  })
})
