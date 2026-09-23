import { describe, it, expect } from 'vitest'
import {
  channelKey,
  channelKeyBelongsToPlaylist,
  channelKeyCandidates,
  isChannelKeyFor
} from './channelIdentity'

describe('channelKey', () => {
  it('keys a primary-playlist channel by its plain id — exactly as it always did', () => {
    // The whole point of the rule: nothing already on disk has to be rewritten.
    expect(channelKey('primary', 42, 'primary')).toBe('42')
    expect(channelKey(null, 42, 'primary')).toBe('42')
    expect(channelKey(undefined, 42, 'primary')).toBe('42')
  })

  it('qualifies a channel belonging to another playlist', () => {
    expect(channelKey('second', 42, 'primary')).toBe('second:42')
  })

  it('treats everything as primary when no primary is known (pre-multi-playlist data)', () => {
    expect(channelKey('anything', 42, null)).toBe('42')
  })

  it('can never confuse the two forms — an id is numeric, so ": " cannot appear in one', () => {
    expect(channelKey('7', 42, 'primary')).not.toBe('742')
    expect(channelKey('7', 42, 'primary')).toBe('7:42')
  })
})

describe('isChannelKeyFor', () => {
  it('matches the channel in its own playlist and not the same id in another', () => {
    expect(isChannelKeyFor('42', 'primary', 42, 'primary')).toBe(true)
    expect(isChannelKeyFor('42', 'second', 42, 'primary')).toBe(false)
    expect(isChannelKeyFor('second:42', 'second', 42, 'primary')).toBe(true)
  })
})

describe('channelKeyCandidates', () => {
  it('returns just the one key for a primary channel', () => {
    expect(channelKeyCandidates('primary', 42, 'primary')).toEqual(['42'])
  })

  it('also offers the bare id for another playlist, so a stale entry predating the playlist is still cleared', () => {
    expect(channelKeyCandidates('second', 42, 'primary')).toEqual(['second:42', '42'])
  })
})

describe('channelKeyBelongsToPlaylist', () => {
  it('gives a bare key to the primary, and a qualified key to its own playlist', () => {
    expect(channelKeyBelongsToPlaylist('42', 'primary', 'primary')).toBe(true)
    expect(channelKeyBelongsToPlaylist('42', 'second', 'primary')).toBe(false)
    expect(channelKeyBelongsToPlaylist('second:42', 'second', 'primary')).toBe(true)
    expect(channelKeyBelongsToPlaylist('second:42', 'primary', 'primary')).toBe(false)
  })
})
