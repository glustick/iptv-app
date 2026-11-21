import { describe, expect, it } from 'vitest'
import { planConnectionRelease, releaseCandidates, type ReleaseCandidate } from './connectionRelease'
import type { LiveStream } from './types'

const stream = (id: number, name: string): LiveStream =>
  ({ stream_id: id, name } as unknown as LiveStream)

const cand = (slotIndex: number, isAudible = false): ReleaseCandidate => ({
  slotIndex,
  channelName: `Tile ${slotIndex + 1}`,
  isAudible
})

describe('planConnectionRelease', () => {
  it('names the earliest silent tile, with a note that says which and why', () => {
    const plan = planConnectionRelease([cand(0), cand(1), cand(2)], true)
    expect(plan?.slotIndex).toBe(0)
    expect(plan?.note).toContain('Tile 1')
    expect(plan?.note).toContain('only one connection')
  })

  it('never stops the audible tile, however early its slot is', () => {
    const plan = planConnectionRelease([cand(0, true), cand(1)], true)
    expect(plan?.slotIndex).toBe(1)
  })

  it('returns null when the only filled tile is the audible one — nothing honest to stop', () => {
    expect(planConnectionRelease([cand(1, true)], true)).toBeNull()
  })

  it('returns null at zero filled tiles — nothing to release, nothing blocked', () => {
    expect(planConnectionRelease([], true)).toBeNull()
  })

  it('returns null when the account is not at its ceiling (multi-connection accounts unchanged)', () => {
    expect(planConnectionRelease([cand(0), cand(1)], false)).toBeNull()
  })

  it('breaks a silent tie on slot index — the earlier tile goes first', () => {
    const plan = planConnectionRelease([cand(1), cand(3)], true)
    expect(plan?.slotIndex).toBe(1)
  })
})

describe('releaseCandidates', () => {
  it('builds candidates from filled slots only, marking the audible one', () => {
    const candidates = releaseCandidates(
      [stream(1, 'News'), null, stream(3, 'Sport')],
      2
    )
    expect(candidates).toEqual([
      { slotIndex: 0, channelName: 'News', isAudible: false },
      { slotIndex: 2, channelName: 'Sport', isAudible: true }
    ])
  })

  it('with no audible slot every filled tile is a silent candidate', () => {
    const candidates = releaseCandidates([stream(1, 'News')], null)
    expect(candidates).toEqual([{ slotIndex: 0, channelName: 'News', isAudible: false }])
  })
})
