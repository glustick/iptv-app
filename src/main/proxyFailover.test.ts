import { describe, it, expect } from 'vitest'
import {
  FAILOVER_STATE_LIMIT,
  backupPreferredUntil,
  createFailoverState,
  notePrimaryFailure,
  notePrimarySuccess
} from './proxyFailover'

describe('proxyFailover', () => {
  it('has no cooldown recorded for a primary that never failed', () => {
    const state = createFailoverState()
    expect(backupPreferredUntil(state, 'http://primary:8080', 1000)).toBeNull()
  })

  it('prefers the backup for the cooldown window after a primary failure, then expires', () => {
    const state = createFailoverState()
    notePrimaryFailure(state, 'http://primary:8080', 1_000, 60_000)

    expect(backupPreferredUntil(state, 'http://primary:8080', 1_001)).toBe(61_000)
    expect(backupPreferredUntil(state, 'http://primary:8080', 60_999)).toBe(61_000)
    expect(backupPreferredUntil(state, 'http://primary:8080', 61_000)).toBeNull()
  })

  it('keys the cooldown on the primary, not globally', () => {
    const state = createFailoverState()
    notePrimaryFailure(state, 'http://primary:8080', 1_000)

    expect(backupPreferredUntil(state, 'http://other-portal:8080', 2_000)).toBeNull()
  })

  it('a primary answer clears the cooldown immediately', () => {
    const state = createFailoverState()
    notePrimaryFailure(state, 'http://primary:8080', 1_000)
    notePrimarySuccess(state, 'http://primary:8080')

    expect(backupPreferredUntil(state, 'http://primary:8080', 2_000)).toBeNull()
  })

  it('clearing a primary with no cooldown is a no-op', () => {
    const state = createFailoverState()
    notePrimarySuccess(state, 'http://primary:8080')
    expect(backupPreferredUntil(state, 'http://primary:8080', 1_000)).toBeNull()
  })

  it('prunes expired entries when a new failure is recorded', () => {
    const state = createFailoverState()
    notePrimaryFailure(state, 'http://stale:8080', 0, 1_000)
    // Far past the stale entry's expiry.
    notePrimaryFailure(state, 'http://fresh:8080', 500_000, 60_000)

    expect(state.backupUntil.has('http://stale:8080')).toBe(false)
    expect(state.backupUntil.has('http://fresh:8080')).toBe(true)
  })

  it('stays bounded, evicting the soonest-expiring entry first', () => {
    const state = createFailoverState()
    // Fill to the cap with staggered expiries.
    for (let i = 0; i < FAILOVER_STATE_LIMIT; i++) {
      notePrimaryFailure(state, `http://portal-${i}:8080`, 1_000 + i, 60_000)
    }
    expect(state.backupUntil.size).toBe(FAILOVER_STATE_LIMIT)
    // One more: portal-0 expires soonest, so it is the one evicted.
    notePrimaryFailure(state, 'http://portal-new:8080', 2_000, 60_000)
    expect(state.backupUntil.size).toBe(FAILOVER_STATE_LIMIT)
    expect(state.backupUntil.has('http://portal-0:8080')).toBe(false)
    expect(state.backupUntil.has('http://portal-new:8080')).toBe(true)
  })
})
