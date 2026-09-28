import { describe, it, expect } from 'vitest'
import {
  transcodeMemoryKey,
  sameSourceUrl,
  pruneTranscodeMemory,
  rememberedAudioIndex,
  TRANSCODE_MEMORY_MAX_ENTRIES
} from './transcodeMemory'
import type { TranscodeMemoryEntry } from './types'

describe('transcodeMemoryKey', () => {
  it('keys a live channel through channelIdentity — the same id on two playlists is two channels', () => {
    expect(
      transcodeMemoryKey({ kind: 'live', playlistId: 'primary', streamId: 42, primaryPlaylistId: 'primary' })
    ).toBe('42')
    expect(
      transcodeMemoryKey({ kind: 'live', playlistId: 'second', streamId: 42, primaryPlaylistId: 'primary' })
    ).toBe('second:42')
    // No playlist known at all counts as the primary — the convention every stored per-channel
    // entry predating multi-playlist already follows.
    expect(transcodeMemoryKey({ kind: 'live', streamId: 42, primaryPlaylistId: null })).toBe('42')
  })

  it('keys a movie by its stream id under the movie namespace', () => {
    expect(transcodeMemoryKey({ kind: 'movie', streamId: 1234 })).toBe('movie:1234')
  })

  it('keys a series episode by its own id — the decision belongs to the episode, not the series', () => {
    expect(transcodeMemoryKey({ kind: 'series', episodeId: '54321' })).toBe('series:54321')
  })

  it('keeps the three namespaces apart — a live 42, a movie 42 and an episode "42" are three memories', () => {
    expect(transcodeMemoryKey({ kind: 'live', streamId: 42 })).toBe('42')
    expect(transcodeMemoryKey({ kind: 'movie', streamId: 42 })).toBe('movie:42')
    expect(transcodeMemoryKey({ kind: 'series', episodeId: '42' })).toBe('series:42')
  })
})

describe('sameSourceUrl', () => {
  it('still matches after the provider rotates the token — same host and path, different query', () => {
    expect(
      sameSourceUrl(
        'http://provider.example:8080/live/user/pass/12345.ts?token=aaa111',
        'http://provider.example:8080/live/user/pass/12345.ts?token=bbb222&expires=999'
      )
    ).toBe(true)
  })

  it('does not match a different channel on the same provider', () => {
    expect(
      sameSourceUrl(
        'http://provider.example:8080/live/user/pass/12345.ts?token=aaa111',
        'http://provider.example:8080/live/user/pass/99999.ts?token=aaa111'
      )
    ).toBe(false)
  })

  it('does not match a different host or port even with an identical path', () => {
    expect(sameSourceUrl('http://a.example/live/1.ts', 'http://b.example/live/1.ts')).toBe(false)
    expect(sameSourceUrl('http://a.example:8080/live/1.ts', 'http://a.example:9090/live/1.ts')).toBe(false)
  })

  it('falls back to plain string comparison for unparseable input instead of throwing', () => {
    expect(sameSourceUrl('not a url', 'not a url')).toBe(true)
    expect(sameSourceUrl('not a url', 'http://a.example/live/1.ts')).toBe(false)
  })
})

// The write-time prune: settings.transcodeMemory grows an entry per distinct channel/title ever
// played, so every write caps it — oldest by confirmedAt dropped first.
describe('pruneTranscodeMemory', () => {
  function direct(confirmedAt: number): TranscodeMemoryEntry {
    return { kind: 'direct', url: 'http://provider.example/live/1.ts', confirmedAt }
  }

  it('leaves a record within the cap untouched — same reference, nothing rewritten', () => {
    const memory = { a: direct(1), b: direct(2) }
    expect(pruneTranscodeMemory(memory, 5)).toBe(memory)
  })

  it('drops the oldest entries first once the cap is exceeded', () => {
    const memory = { oldest: direct(1), middle: direct(2), newest: direct(3) }
    const pruned = pruneTranscodeMemory(memory, 2)
    expect(Object.keys(pruned).sort()).toEqual(['middle', 'newest'])
    expect(pruned.oldest).toBeUndefined()
  })

  it('enforces the real 2000-entry cap, keeping the newest', () => {
    const memory: Record<string, TranscodeMemoryEntry> = {}
    for (let i = 0; i <= TRANSCODE_MEMORY_MAX_ENTRIES; i++) memory[`movie:${i}`] = direct(i)
    const pruned = pruneTranscodeMemory(memory)
    expect(Object.keys(pruned)).toHaveLength(TRANSCODE_MEMORY_MAX_ENTRIES)
    expect(pruned['movie:0']).toBeUndefined()
    expect(pruned['movie:1']).toBeDefined()
    expect(pruned[`movie:${TRANSCODE_MEMORY_MAX_ENTRIES}`]).toBeDefined()
  })
})

// The read decision at the heart of the memory: which remembered outcome may start playback a
// way NOT taken by default, and which must never suppress detection.
describe('rememberedAudioIndex', () => {
  it('matches an audio entry across a rotated token — the remembered fix still applies', () => {
    const memory = {
      'movie:1234': {
        kind: 'audio' as const,
        audioIndex: 2,
        url: 'http://provider.example:8080/movie/u/p/1234.mkv?token=***',
        confirmedAt: 1
      }
    }
    expect(
      rememberedAudioIndex(memory, 'movie:1234', 'http://provider.example:8080/movie/u/p/1234.mkv?token=***&expires=9')
    ).toBe(2)
  })

  it('returns 0 for an entry whose fix is track 0 — 0 is a real index, distinct from "no match"', () => {
    const memory = {
      'series:55': { kind: 'audio' as const, audioIndex: 0, url: 'http://provider.example/series/55.mkv', confirmedAt: 1 }
    }
    expect(rememberedAudioIndex(memory, 'series:55', 'http://provider.example/series/55.mkv')).toBe(0)
  })

  it('ignores a direct record — detection must keep running for a file that may have changed', () => {
    const memory = {
      'movie:1234': { kind: 'direct' as const, url: 'http://provider.example/movie/1234.mkv', confirmedAt: 1 }
    }
    expect(rememberedAudioIndex(memory, 'movie:1234', 'http://provider.example/movie/1234.mkv')).toBeNull()
  })

  it('ignores an entry confirmed against a different source, and a missing key', () => {
    const memory = {
      'movie:1234': { kind: 'audio' as const, audioIndex: 2, url: 'http://provider.example/movie/1.mkv', confirmedAt: 1 }
    }
    expect(rememberedAudioIndex(memory, 'movie:1234', 'http://provider.example/movie/9999.mkv')).toBeNull()
    expect(rememberedAudioIndex(memory, 'movie:9999', 'http://provider.example/movie/9999.mkv')).toBeNull()
  })
})
