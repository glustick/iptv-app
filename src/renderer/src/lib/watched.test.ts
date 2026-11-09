import { describe, expect, it } from 'vitest'
import { isWatched, markWatched, pruneWatched, unmarkWatched, watchedKey } from './watched'

describe('the watched mark', () => {
  it('uses the same namespaces as progress: movie: prefix, bare episode id', () => {
    expect(watchedKey('movie', 42)).toBe('movie:42')
    expect(watchedKey('series', '4101')).toBe('4101')
  })

  it('marks, asks and unmarks', () => {
    const empty = {}
    const marked = markWatched(empty, 'movie', 42, 1000)
    expect(isWatched(marked, 'movie', 42)).toBe(true)
    expect(isWatched(marked, 'series', 42)).toBe(false)
    expect(isWatched(unmarkWatched(marked, 'movie', 42), 'movie', 42)).toBe(false)
    // The original is untouched — these are pure transforms.
    expect(isWatched(empty, 'movie', 42)).toBe(false)
  })

  it('marking twice keeps one entry and moves the timestamp forward', () => {
    const once = markWatched({}, 'movie', 7, 1000)
    const twice = markWatched(once, 'movie', 7, 2000)
    expect(Object.keys(twice)).toEqual(['movie:7'])
    expect(twice['movie:7'].watchedAt).toBe(2000)
  })

  it('prunes oldest-first once past the cap, and returns the same map under it', () => {
    const small = { 'movie:1': { watchedAt: 1 } }
    expect(pruneWatched(small, 5)).toBe(small)
    const record: Record<string, { watchedAt: number }> = {}
    for (let i = 0; i < 6; i++) record[`movie:${i}`] = { watchedAt: i }
    expect(Object.keys(pruneWatched(record, 3)).sort()).toEqual(['movie:3', 'movie:4', 'movie:5'])
  })
})
