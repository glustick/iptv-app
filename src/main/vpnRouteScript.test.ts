import { describe, it, expect } from 'vitest'
import { buildRouteScriptText, normalizeRouteIps, MAX_TUNNELED_ADDRESSES } from './vpnRouteScript'

const darwinAdd = (ips: string[], gateway: string | null = '192.168.1.1'): string =>
  buildRouteScriptText({ platform: 'darwin', ips, action: 'add', originalGateway: gateway })

describe('normalizeRouteIps', () => {
  it('keeps only IPv4 literals, in order, de-duplicated', () => {
    expect(normalizeRouteIps(['10.0.0.9', '10.0.0.9', '10.0.0.8'])).toEqual(['10.0.0.9', '10.0.0.8'])
  })

  it('drops anything that is not a plain IPv4 address', () => {
    expect(normalizeRouteIps(['example.com', 'fd00::1', '10.0.0.5;rm -rf /', ''])).toEqual([])
  })

  it('caps the list so a resolver returning hundreds of records cannot write a giant root script', () => {
    const many = Array.from({ length: 50 }, (_, i) => `10.0.0.${i + 1}`)
    expect(normalizeRouteIps(many).length).toBe(MAX_TUNNELED_ADDRESSES)
  })
})

describe('buildRouteScriptText (macOS)', () => {
  it('adds one host route per address through the tunnel gateway', () => {
    const script = darwinAdd(['10.0.0.5', '10.0.0.6'])
    expect(script).toContain('#!/bin/sh\n')
    expect(script).toContain('/sbin/route -n add -host 10.0.0.5 "$route_vpn_gateway"\n')
    expect(script).toContain('/sbin/route -n add -host 10.0.0.6 "$route_vpn_gateway"\n')
  })

  it('restores the captured default gateway exactly once, before any route line', () => {
    const script = darwinAdd(['10.0.0.5', '10.0.0.6'])
    expect(script.match(/route -n delete -net 0\.0\.0\.0\/1/g)?.length).toBe(1)
    expect(script.indexOf('route -n delete -net 0.0.0.0/1')).toBeLessThan(script.indexOf('route -n add -host'))
    expect(script).toContain('route -n add default 192.168.1.1 2>/dev/null\n')
  })

  it('omits the restore entirely when no gateway was captured', () => {
    const script = darwinAdd(['10.0.0.5'], null)
    expect(script).not.toContain('0.0.0.0/1')
    expect(script).toContain('/sbin/route -n add -host 10.0.0.5')
  })

  it('deletes each host route on teardown', () => {
    const script = buildRouteScriptText({
      platform: 'darwin',
      ips: ['10.0.0.5', '10.0.0.6'],
      action: 'delete',
      originalGateway: null
    })
    expect(script).toContain('/sbin/route -n delete -host 10.0.0.5')
    expect(script).toContain('/sbin/route -n delete -host 10.0.0.6')
    expect(script).not.toContain('route -n add')
  })
})

describe('buildRouteScriptText (Windows)', () => {
  it('uses batch syntax with CRLF endings, per address', () => {
    const script = buildRouteScriptText({ platform: 'win32', ips: ['10.0.0.5'], action: 'add', originalGateway: '192.168.1.1' })
    expect(script.startsWith('@echo off\r\n')).toBe(true)
    expect(script).toContain('route add 10.0.0.5 mask 255.255.255.255 %route_vpn_gateway%\r\n')
    expect(script).toContain('route add 0.0.0.0 mask 0.0.0.0 192.168.1.1 metric 1 >nul 2>&1\r\n')
  })

  it('deletes with the mask form Windows route needs', () => {
    const script = buildRouteScriptText({ platform: 'win32', ips: ['10.0.0.5'], action: 'delete', originalGateway: null })
    expect(script).toContain('route delete 10.0.0.5 mask 255.255.255.255 >nul 2>&1\r\n')
  })
})

describe('buildRouteScriptText (Linux)', () => {
  it('adds via ip route with a BSD route fallback, per address', () => {
    const script = buildRouteScriptText({ platform: 'linux', ips: ['10.0.0.5', '10.0.0.6'], action: 'add', originalGateway: null })
    expect(script).toContain('ip route add 10.0.0.5/32 via "$route_vpn_gateway" 2>/dev/null || route add -host 10.0.0.5 gw "$route_vpn_gateway"\n')
    expect(script).toContain('ip route add 10.0.0.6/32 via "$route_vpn_gateway"')
  })

  it('restores the default gateway via ip route replace', () => {
    const script = buildRouteScriptText({ platform: 'linux', ips: ['10.0.0.5'], action: 'add', originalGateway: '192.168.1.1' })
    expect(script).toContain('ip route replace default via 192.168.1.1 2>/dev/null\n')
  })
})

describe('buildRouteScriptText (empty list)', () => {
  it('throws rather than writing a script that routes nothing', () => {
    expect(() => darwinAdd([])).toThrow()
    expect(() => darwinAdd(['not-an-ip'])).toThrow()
  })
})
