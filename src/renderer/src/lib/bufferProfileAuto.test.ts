import { describe, it, expect } from 'vitest'
import { adaptBufferProfile, AUTO_MIN_SWITCH_INTERVAL_MS } from './bufferProfileAuto'

const NOW = 1_000_000_000

describe('adaptBufferProfile', () => {
  it('holds smooth with no recent events', () => {
    expect(adaptBufferProfile({ recoveryEvents: [], current: 'smooth', lastSwitchAt: null, now: NOW })).toBeNull()
  })

  it('escalates to resilient after two recoveries inside five minutes', () => {
    const events = [NOW - 60_000, NOW - 120_000]
    expect(adaptBufferProfile({ recoveryEvents: events, current: 'smooth', lastSwitchAt: null, now: NOW })).toBe('resilient')
  })

  it('holds smooth when the events are too old or too few', () => {
    // One event inside the window.
    expect(adaptBufferProfile({ recoveryEvents: [NOW - 60_000], current: 'smooth', lastSwitchAt: null, now: NOW })).toBeNull()
    // Two events, but outside the window.
    expect(
      adaptBufferProfile({ recoveryEvents: [NOW - 6 * 60_000, NOW - 7 * 60_000], current: 'smooth', lastSwitchAt: null, now: NOW })
    ).toBeNull()
  })

  it('de-escalates to smooth only after ten quiet minutes on resilient', () => {
    expect(adaptBufferProfile({ recoveryEvents: [NOW - 9 * 60_000], current: 'resilient', lastSwitchAt: null, now: NOW })).toBeNull()
    expect(adaptBufferProfile({ recoveryEvents: [NOW - 11 * 60_000], current: 'resilient', lastSwitchAt: null, now: NOW })).toBe('smooth')
    // No events at all reads as quiet since forever.
    expect(adaptBufferProfile({ recoveryEvents: [], current: 'resilient', lastSwitchAt: null, now: NOW })).toBe('smooth')
  })

  it('honours the per-switch cool-down once this session has already switched', () => {
    const events = [NOW - 60_000, NOW - 120_000]
    const recentSwitch = { recoveryEvents: events, current: 'smooth' as const, lastSwitchAt: NOW - 60_000, now: NOW }
    expect(adaptBufferProfile(recentSwitch)).toBeNull()
    // …but a switch older than the cool-down window escalates again.
    const oldSwitch = { ...recentSwitch, lastSwitchAt: NOW - AUTO_MIN_SWITCH_INTERVAL_MS - 1 }
    expect(adaptBufferProfile(oldSwitch)).toBe('resilient')
    // And a session that NEVER switched (started on smooth) escalates on first evidence.
    expect(adaptBufferProfile({ ...recentSwitch, lastSwitchAt: null })).toBe('resilient')
  })

  it('respects the cool-down on the de-escalation side too', () => {
    const justSwitched = { recoveryEvents: [NOW - 11 * 60_000], current: 'resilient' as const, lastSwitchAt: NOW - 60_000, now: NOW }
    expect(adaptBufferProfile(justSwitched)).toBeNull()
  })
})
