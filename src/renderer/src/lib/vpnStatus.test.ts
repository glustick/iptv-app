import { describe, it, expect } from 'vitest'
import { shouldWarnOnVpnDisconnect } from './vpnStatus'

describe('shouldWarnOnVpnDisconnect', () => {
  it('warns when a connected tunnel drops unexpectedly', () => {
    expect(shouldWarnOnVpnDisconnect('connected', 'disconnected', false)).toBe(true)
    expect(shouldWarnOnVpnDisconnect('connected', 'error', false)).toBe(true)
    expect(shouldWarnOnVpnDisconnect('connected', 'connecting', false)).toBe(true)
  })

  it('does not warn for a deliberate Deactivate or profile switch', () => {
    expect(shouldWarnOnVpnDisconnect('connected', 'disconnected', true)).toBe(false)
    expect(shouldWarnOnVpnDisconnect('connected', 'error', true)).toBe(false)
  })

  it('does not warn when it was never connected in the first place', () => {
    expect(shouldWarnOnVpnDisconnect('connecting', 'error', false)).toBe(false)
    expect(shouldWarnOnVpnDisconnect('disconnected', 'error', false)).toBe(false)
  })

  it('does not warn when the status stays connected', () => {
    expect(shouldWarnOnVpnDisconnect('connected', 'connected', false)).toBe(false)
  })
})
