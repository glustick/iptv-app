import { describe, expect, it } from 'vitest'

import { extractProviderHost, isTunneledNowPlaying, playingProviderHosts } from './vpnPlayback'
import type { XtreamProfile } from './types'

describe('extractProviderHost', () => {
  it('returns the lowercased hostname of a provider server URL', () => {
    expect(extractProviderHost('http://Panel.Example.com:8080')).toBe('panel.example.com')
    expect(extractProviderHost('https://provider.tv/')).toBe('provider.tv')
  })

  it('ignores port, path, credentials and query', () => {
    expect(extractProviderHost('http://user:pass@some.host:99/some/path?x=1')).toBe('some.host')
  })

  it('returns null for an unparseable URL rather than throwing', () => {
    expect(extractProviderHost('not a url at all')).toBeNull()
    expect(extractProviderHost('')).toBeNull()
  })
})

function profile(overrides: Partial<XtreamProfile>): XtreamProfile {
  return { id: 'p1', name: 'Primary', server: 'http://provider.example:8080', username: 'u', password: 'p', ...overrides }
}

describe('playingProviderHosts', () => {
  const profiles = [
    profile({ id: 'xt1', name: 'Xtream one', server: 'http://One.Provider.example:8080' }),
    profile({ id: 'xt2', name: 'Xtream two', server: 'https://two.example.tv' }),
    profile({ id: 'm3u1', name: 'M3U one', kind: 'm3u' }),
    profile({ id: 'noserver', name: 'Broken', kind: 'xtream', server: undefined })
  ]

  it('maps the playing playlist to its profile provider host, lowercased', () => {
    expect(playingProviderHosts('xt1', profiles)).toEqual(['one.provider.example'])
    expect(playingProviderHosts('xt2', profiles)).toEqual(['two.example.tv'])
  })

  it('returns empty for an M3U playlist — its per-channel hosts are unroutable and unknown', () => {
    expect(playingProviderHosts('m3u1', profiles)).toEqual([])
  })

  it('returns empty for a profile without a server URL, an unknown id, or no id at all', () => {
    expect(playingProviderHosts('noserver', profiles)).toEqual([])
    expect(playingProviderHosts('missing', profiles)).toEqual([])
    expect(playingProviderHosts(null, profiles)).toEqual([])
  })

  it('deliberately ignores backupServer — the tunnel routes primary servers only', () => {
    const withBackup = [profile({ id: 'xt1', backupServer: 'http://backup.example:8080' })]
    expect(playingProviderHosts('xt1', withBackup)).toEqual(['provider.example'])
  })
})

describe('isTunneledNowPlaying', () => {
  it('matches case-insensitively on both sides', () => {
    expect(isTunneledNowPlaying(['Provider.Example.com'], ['provider.example.com'])).toBe(true)
    expect(isTunneledNowPlaying(['provider.example.com'], ['Provider.Example.com'])).toBe(true)
  })

  it('is true when any of the playing playlist hosts is routed', () => {
    expect(isTunneledNowPlaying(['other.host', 'provider.example.com'], ['provider.example.com'])).toBe(true)
  })

  it('is false when the hosts do not overlap', () => {
    expect(isTunneledNowPlaying(['provider.example.com'], ['different.example.com'])).toBe(false)
  })

  it('is false when either side is empty — no evidence of tunneling means no tunneling', () => {
    expect(isTunneledNowPlaying([], ['provider.example.com'])).toBe(false)
    expect(isTunneledNowPlaying(['provider.example.com'], [])).toBe(false)
    expect(isTunneledNowPlaying([], [])).toBe(false)
  })
})
