import { describe, it, expect } from 'vitest'
import {
  nextReconnectDelayMs,
  shouldResetReconnectAttempts,
  RECONNECT_MAX_ATTEMPTS
} from './reconnectBackoff'

describe('nextReconnectDelayMs', () => {
  it('spaces attempts 2s, 4s, 8s, then holds at the cap', () => {
    expect(nextReconnectDelayMs(1)).toBe(2000)
    expect(nextReconnectDelayMs(2)).toBe(4000)
    expect(nextReconnectDelayMs(3)).toBe(8000)
    expect(nextReconnectDelayMs(4)).toBe(8000)
    expect(nextReconnectDelayMs(5)).toBe(8000)
  })

  it('answers null once the budget is spent — the signal to stop auto-retrying', () => {
    expect(nextReconnectDelayMs(RECONNECT_MAX_ATTEMPTS + 1)).toBeNull()
    expect(nextReconnectDelayMs(99)).toBeNull()
  })

  it('rejects non-positive attempt numbers', () => {
    expect(nextReconnectDelayMs(0)).toBeNull()
    expect(nextReconnectDelayMs(-1)).toBeNull()
  })
})

describe('shouldResetReconnectAttempts', () => {
  it('retires the budget only after a full 30s of unbroken playback', () => {
    expect(shouldResetReconnectAttempts(29_999)).toBe(false)
    expect(shouldResetReconnectAttempts(30_000)).toBe(true)
    expect(shouldResetReconnectAttempts(120_000)).toBe(true)
  })
})
