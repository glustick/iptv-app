import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordRecoveryEvent,
  recentRecoveryEvents,
  allRecoveryEvents,
  clearRecoveryLog,
  recoverySummary,
  formatRecoveryTime
} from './recoveryLog'

describe('recoveryLog', () => {
  beforeEach(() => clearRecoveryLog())

  it('records, lists newest-first in the tail, oldest-first overall', () => {
    recordRecoveryEvent('stall-nudge', '+0.1s', 1000)
    recordRecoveryEvent('stall-reload', 'attempt 1', 2000)
    recordRecoveryEvent('stall-remux', 'fresh session', 3000)
    expect(allRecoveryEvents().map((e) => e.kind)).toEqual(['stall-nudge', 'stall-reload', 'stall-remux'])
    expect(recentRecoveryEvents(2).map((e) => e.kind)).toEqual(['stall-remux', 'stall-reload'])
    expect(recentRecoveryEvents(2)[0].detail).toBe('fresh session')
  })

  it('is capped — a stall-reload storm cannot grow it without bound', () => {
    for (let i = 0; i < 500; i++) recordRecoveryEvent('stall-reload', `#${i}`, i * 1000)
    expect(allRecoveryEvents().length).toBeLessThan(500)
    // Newest survive the cap.
    expect(allRecoveryEvents()[allRecoveryEvents().length - 1].detail).toBe('#499')
  })

  it('the summary counts by kind and names the most recent action with its age', () => {
    recordRecoveryEvent('stall-nudge', undefined, 1000)
    recordRecoveryEvent('stall-reload', 'attempt 1', 2000)
    recordRecoveryEvent('network-retry', undefined, 4000)
    const line = recoverySummary(10_000)
    expect(line).toContain('3 recoveries')
    expect(line).toContain('1× stall-reload')
    expect(line).toContain('last: network-retry')
    expect(line).toContain('6s ago')
  })

  it('an empty session answers honestly', () => {
    expect(recoverySummary(1000)).toBe('No recoveries this session')
  })

  it('clears on demand (new playback starts a fresh history)', () => {
    recordRecoveryEvent('stall-nudge', undefined, 1000)
    clearRecoveryLog()
    expect(allRecoveryEvents()).toEqual([])
    expect(recoverySummary(1000)).toBe('No recoveries this session')
  })

  it('formats wall-clock stamps zero-padded', () => {
    // Local-time formatting, so build the expectation from the same clock.
    const d = new Date(2026, 0, 15, 9, 7, 3)
    expect(formatRecoveryTime(d.getTime())).toBe('09:07:03')
  })
})
