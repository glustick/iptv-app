import { describe, expect, it } from 'vitest'
import { findLiveAudioFact, withLiveAudioFact } from './liveAudioFacts'

const KEY = 'p1:41154'

describe('findLiveAudioFact', () => {
  it('returns the fact when the source matches on host and pathname (token rotation tolerated)', () => {
    const facts = withLiveAudioFact({}, KEY, 'https://edge.example.com/live/1/seg.m3u8?token=aaa', 'eac3')
    expect(
      findLiveAudioFact(facts, KEY, 'https://edge.example.com/live/1/seg.m3u8?token=bbb')?.firstAudioCodec
    ).toBe('eac3')
  })

  it('answers null when nothing was learned for the channel', () => {
    expect(findLiveAudioFact({}, KEY, 'https://edge.example.com/live/1/seg.m3u8')).toBeNull()
  })

  it('answers null when the fact was learned against a different source (a rotated host or path)', () => {
    const facts = withLiveAudioFact({}, KEY, 'https://edge.example.com/live/1/seg.m3u8', 'aac')
    expect(findLiveAudioFact(facts, KEY, 'https://edge-two.example.com/live/1/seg.m3u8')).toBeNull()
    expect(findLiveAudioFact(facts, KEY, 'https://edge.example.com/live/2/seg.m3u8')).toBeNull()
  })
})

describe('withLiveAudioFact', () => {
  it('records and overwrites one channel without touching others', () => {
    let facts = withLiveAudioFact({}, KEY, 'https://a.example/1.m3u8', 'eac3')
    facts = withLiveAudioFact(facts, 'p1:41155', 'https://a.example/2.m3u8', null)
    expect(Object.keys(facts).sort()).toEqual(['p1:41154', 'p1:41155'])
    facts = withLiveAudioFact(facts, KEY, 'https://a.example/1.m3u8', 'aac')
    expect(facts[KEY]?.firstAudioCodec).toBe('aac')
    expect(facts['p1:41155']?.firstAudioCodec).toBeNull()
  })

  it('keeps a null codec as a real answer (learned "no audio/unknown", not "never asked")', () => {
    const facts = withLiveAudioFact({}, KEY, 'https://a.example/1.m3u8', null)
    expect(facts[KEY]?.firstAudioCodec).toBeNull()
    expect(findLiveAudioFact(facts, KEY, 'https://a.example/1.m3u8')).not.toBeNull()
  })
})
