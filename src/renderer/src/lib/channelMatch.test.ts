import { describe, it, expect } from 'vitest'
import { tierCandidates, pickDefaultMatchSource } from './channelMatch'

const candidates = (scores: number[]): { channelId: string; displayName: string; score: number }[] =>
  scores.map((score, i) => ({ channelId: `c${i}`, displayName: `Channel ${i}`, score }))

describe('tierCandidates', () => {
  it('calls a candidate strong at the score the bulk apply would trust, and keeps order', () => {
    const tiered = tierCandidates(candidates([0.85, 0.8, 0.55]))
    expect(tiered.map((t) => t.tier)).toEqual(['strong', 'strong', 'possible'])
    expect(tiered[0].displayName).toBe('Channel 0')
  })

  it('marks everything below the strong line as possible, not as a failure', () => {
    expect(tierCandidates(candidates([0.41, 0.41]))[0].tier).toBe('possible')
  })
})

describe('pickDefaultMatchSource', () => {
  const PROVIDER = 'Provider guide (xmltv.php)'

  it('starts on the source already supplying the channel', () => {
    expect(pickDefaultMatchSource([PROVIDER, 'a.xml', 'b.xml'], 'b.xml', PROVIDER)).toBe('b.xml')
  })

  it('never offers the provider guide as the target', () => {
    expect(pickDefaultMatchSource([PROVIDER], null, PROVIDER)).toBeNull()
    expect(pickDefaultMatchSource([PROVIDER, 'a.xml'], PROVIDER, PROVIDER)).toBe('a.xml')
  })

  it('skips hidden sources when choosing a default, but keeps them as a last resort', () => {
    const sources = [PROVIDER, 'a.xml', 'b.xml']
    expect(pickDefaultMatchSource(sources, null, PROVIDER, ['a.xml'])).toBe('b.xml')
    expect(pickDefaultMatchSource(sources, null, PROVIDER, ['a.xml', 'b.xml'])).toBe('a.xml')
  })
})
