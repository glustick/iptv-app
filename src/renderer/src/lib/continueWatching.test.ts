import { describe, expect, it } from 'vitest'
import {
  CREDITS_MIN_DURATION_SECONDS,
  FINISHED_FRACTION,
  continueWatchingMovies,
  formatPlaybackPosition,
  isFinished,
  movieIdFromProgressKey,
  movieProgressKey,
  progressFraction
} from './continueWatching'
import type { EpisodeProgress } from './types'

const record = (positionSeconds: number, durationSeconds: number, updatedAt = 1): EpisodeProgress => ({
  positionSeconds,
  durationSeconds,
  updatedAt
})

describe('movie progress keys', () => {
  it('namespaces a movie so it cannot collide with an episode id', () => {
    // Movie 42 and episode 42 are different numbering spaces; the namespace is what keeps the
    // shelf from offering an episode's position as a film's.
    expect(movieProgressKey(42)).toBe('movie:42')
    expect(movieIdFromProgressKey('movie:42')).toBe(42)
    expect(movieIdFromProgressKey('42')).toBeNull()
    expect(movieIdFromProgressKey('series:42')).toBeNull()
    expect(movieIdFromProgressKey('movie:abc')).toBeNull()
    expect(movieIdFromProgressKey('movie:')).toBeNull()
  })

  it('shares the shape transcodeMemoryKey already gives a movie', () => {
    // Not a coincidence worth breaking: both records describe the same film, and one string
    // convention across the app is easier to reason about than two.
    expect(movieProgressKey(7)).toBe(`movie:${7}`)
  })
})

describe('isFinished', () => {
  it('calls a title finished at the 95% mark, and not a pixel before', () => {
    expect(isFinished(95, 100)).toBe(true)
    expect(isFinished(94.9, 100)).toBe(false)
    expect(isFinished(100, 100)).toBe(true)
  })

  it('counts the last two minutes of a film as credits, but never of a short clip', () => {
    // A 2-hour film at 1:58:30 is 90s from the end — credits.
    expect(isFinished(7110, 7200)).toBe(true)
    // A 5-minute clip at 4:30 is also 30s from the end, but calling that finished would mean
    // the credits rule fired before it started. The duration floor is what prevents that.
    expect(CREDITS_MIN_DURATION_SECONDS).toBeGreaterThan(300)
    expect(isFinished(270, 300)).toBe(false)
  })

  it('never claims a finished title without a real duration', () => {
    expect(isFinished(10, 0)).toBe(false)
    expect(isFinished(10, -5)).toBe(false)
    expect(isFinished(Number.NaN, 100)).toBe(false)
    expect(isFinished(10, Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('progressFraction', () => {
  it('is a 0–1 fraction, clamped against bad stored values', () => {
    expect(progressFraction(30, 120)).toBe(0.25)
    expect(progressFraction(500, 120)).toBe(1)
    expect(progressFraction(-5, 120)).toBe(0)
    expect(progressFraction(30, 0)).toBe(0)
  })
})

describe('formatPlaybackPosition', () => {
  it('reads like a clock', () => {
    expect(formatPlaybackPosition(0)).toBe('0:00')
    expect(formatPlaybackPosition(65)).toBe('1:05')
    expect(formatPlaybackPosition(3725)).toBe('1:02:05')
    expect(formatPlaybackPosition(Number.NaN)).toBe('0:00')
    expect(formatPlaybackPosition(-10)).toBe('0:00')
  })
})

describe('continueWatchingMovies', () => {
  it('offers only half-watched films, newest first, capped', () => {
    const progress: Record<string, EpisodeProgress> = {
      'movie:1': record(600, 7200, 10),
      'movie:2': record(30, 120, 30),
      // Finished in two different ways — neither belongs on a "continue" shelf.
      'movie:3': record(7190, 7200, 40),
      'movie:4': record(120, 120, 50),
      // A series episode's own key is bare, and must never leak into the films shelf.
      '101': record(500, 3000, 60),
      'movie:5': record(0, 5400, 70)
    }

    const shelf = continueWatchingMovies(progress, 8)
    expect(shelf.map((entry) => entry.streamId)).toEqual([2, 1])
    expect(shelf[0].fraction).toBeCloseTo(0.25)
    expect(shelf[0].key).toBe('movie:2')
  })

  it('caps at the requested number, dropping the oldest', () => {
    const progress: Record<string, EpisodeProgress> = {}
    for (let id = 1; id <= 12; id += 1) progress[`movie:${id}`] = record(60, 3600, id)
    expect(continueWatchingMovies(progress, 8).map((entry) => entry.streamId)).toEqual([12, 11, 10, 9, 8, 7, 6, 5])
  })

  it('ignores malformed records rather than painting a broken card', () => {
    const progress: Record<string, EpisodeProgress> = {
      'movie:9': { positionSeconds: Number.NaN, durationSeconds: 3600, updatedAt: 1 },
      'movie:10': { positionSeconds: 60, durationSeconds: 0, updatedAt: 2 },
      'movie:11': record(60, 3600, Number.NaN)
    }
    const shelf = continueWatchingMovies(progress)
    expect(shelf.map((entry) => entry.streamId)).toEqual([11])
    expect(shelf[0].updatedAt).toBe(0)
  })

  it('is empty when nothing has been started', () => {
    expect(continueWatchingMovies({})).toEqual([])
  })
})

describe('FINISHED_FRACTION', () => {
  it('is the web sibling\'s 95%, so both apps agree about watched', () => {
    expect(FINISHED_FRACTION).toBe(0.95)
  })
})
