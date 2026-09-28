import { describe, it, expect } from 'vitest'
import { transcodeMemoryKey, sameSourceUrl } from './transcodeMemory'

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
