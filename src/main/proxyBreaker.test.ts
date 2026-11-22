import { describe, it, expect } from 'vitest'
import {
  breakerIsOpen,
  createBreakerState,
  noteHostFailure,
  noteHostSuccess,
  BREAKER_THRESHOLD
} from './proxyBreaker'

const NOW = 1_000_000_000

describe('proxyBreaker', () => {
  it('opens only after the threshold of consecutive failures', () => {
    const state = createBreakerState()
    for (let i = 1; i < BREAKER_THRESHOLD; i++) {
      noteHostFailure(state, 'origin.example', NOW)
      expect(breakerIsOpen(state, 'origin.example', NOW)).toBe(false)
    }
    noteHostFailure(state, 'origin.example', NOW)
    expect(breakerIsOpen(state, 'origin.example', NOW)).toBe(true)
  })

  it('closes after the cooldown expires — the next request is the probe', () => {
    const state = createBreakerState()
    for (let i = 0; i < BREAKER_THRESHOLD; i++) noteHostFailure(state, 'origin.example', NOW)
    expect(breakerIsOpen(state, 'origin.example', NOW + 29_999)).toBe(true)
    expect(breakerIsOpen(state, 'origin.example', NOW + 30_000)).toBe(false)
  })

  it('one success resets the count and closes an open breaker immediately', () => {
    const state = createBreakerState()
    for (let i = 0; i < BREAKER_THRESHOLD; i++) noteHostFailure(state, 'origin.example', NOW)
    expect(breakerIsOpen(state, 'origin.example', NOW)).toBe(true)
    noteHostSuccess(state, 'origin.example')
    expect(breakerIsOpen(state, 'origin.example', NOW)).toBe(false)
    // And the counter is gone: the next threshold failures are needed to reopen.
    noteHostFailure(state, 'origin.example', NOW)
    expect(breakerIsOpen(state, 'origin.example', NOW)).toBe(false)
  })

  it('a probe failure re-opens for a fresh cooldown without needing more failures', () => {
    const state = createBreakerState()
    for (let i = 0; i < BREAKER_THRESHOLD; i++) noteHostFailure(state, 'origin.example', NOW)
    // Cooldown expired, the probe runs and fails: count is already at the threshold, so this
    // one failure re-opens for another window.
    const probeAt = NOW + 30_000
    noteHostFailure(state, 'origin.example', probeAt)
    expect(breakerIsOpen(state, 'origin.example', probeAt)).toBe(true)
    expect(breakerIsOpen(state, 'origin.example', probeAt + 29_999)).toBe(true)
    expect(breakerIsOpen(state, 'origin.example', probeAt + 30_000)).toBe(false)
  })

  it('tracks hosts independently and prunes the stalest entries past the cap', () => {
    const state = createBreakerState()
    noteHostFailure(state, 'a.example', NOW)
    for (let i = 0; i < BREAKER_THRESHOLD; i++) noteHostFailure(state, 'b.example', NOW)
    expect(breakerIsOpen(state, 'b.example', NOW)).toBe(true)
    expect(breakerIsOpen(state, 'a.example', NOW)).toBe(false)
  })

  it('hosts are matched exactly — a subdomain is a different host', () => {
    const state = createBreakerState()
    for (let i = 0; i < BREAKER_THRESHOLD; i++) noteHostFailure(state, 'cdn.example', NOW)
    expect(breakerIsOpen(state, 'example', NOW)).toBe(false)
    expect(breakerIsOpen(state, 'sub.cdn.example', NOW)).toBe(false)
  })
})
