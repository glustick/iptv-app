import { describe, it, expect } from 'vitest'
import { parseM3u } from './m3u'

describe('parseM3u', () => {
  it('parses channels with tvg attributes and a group title', () => {
    const { channels } = parseM3u(`#EXTM3U
#EXTINF:-1 tvg-id="bbc1.uk" tvg-logo="http://x/bbc1.png" group-title="News",BBC One
http://provider.example/live/user/pass/1.ts
#EXTINF:-1 tvg-id="itv.uk" tvg-logo="http://x/itv.png" group-title="News",ITV
http://provider.example/live/user/pass/2.ts`)

    expect(channels).toEqual([
      { name: 'BBC One', tvgId: 'bbc1.uk', tvgLogo: 'http://x/bbc1.png', groupTitle: 'News', url: 'http://provider.example/live/user/pass/1.ts' },
      { name: 'ITV', tvgId: 'itv.uk', tvgLogo: 'http://x/itv.png', groupTitle: 'News', url: 'http://provider.example/live/user/pass/2.ts' }
    ])
  })

  it('discovers the EPG URL from #EXTM3U\'s own url-tvg/x-tvg-url attribute', () => {
    const { epgUrl } = parseM3u('#EXTM3U url-tvg="http://provider.example/epg.xml"\n#EXTINF:-1,Ch\nhttp://x/1.ts')
    expect(epgUrl).toBe('http://provider.example/epg.xml')
  })

  it('returns null for the EPG URL when #EXTM3U carries no tvg attribute', () => {
    const { epgUrl } = parseM3u('#EXTM3U\n#EXTINF:-1,Ch\nhttp://x/1.ts')
    expect(epgUrl).toBeNull()
  })

  it('finds the name-separating comma correctly even when an attribute value contains one', () => {
    const { channels } = parseM3u('#EXTINF:-1 tvg-name="Show, The" group-title="Drama",Show, The (HD)\nhttp://x/1.ts')
    expect(channels[0].name).toBe('Show, The (HD)')
    expect(channels[0].groupTitle).toBe('Drama')
  })

  it('falls back to tvg-name when there is no display name after the comma', () => {
    const { channels } = parseM3u('#EXTINF:-1 tvg-name="Fallback Name",\nhttp://x/1.ts')
    expect(channels[0].name).toBe('Fallback Name')
  })

  it('defaults missing tvg-id/tvg-logo/group-title to null rather than throwing', () => {
    const { channels } = parseM3u('#EXTINF:-1,Bare Channel\nhttp://x/1.ts')
    expect(channels[0]).toEqual({ name: 'Bare Channel', tvgId: null, tvgLogo: null, groupTitle: null, url: 'http://x/1.ts' })
  })

  it('skips #EXTGRP/#EXTVLCOPT and other comment lines between #EXTINF and its URL', () => {
    const { channels } = parseM3u('#EXTINF:-1,Ch\n#EXTGRP:News\n#EXTVLCOPT:http-user-agent=Foo\nhttp://x/1.ts')
    expect(channels).toHaveLength(1)
    expect(channels[0].url).toBe('http://x/1.ts')
  })

  it('ignores a URL with no preceding #EXTINF instead of guessing a channel for it', () => {
    const { channels } = parseM3u('#EXTM3U\nhttp://x/orphan.ts\n#EXTINF:-1,Real Channel\nhttp://x/1.ts')
    expect(channels).toHaveLength(1)
    expect(channels[0].name).toBe('Real Channel')
  })

  it('handles CRLF line endings and a leading UTF-8 BOM', () => {
    const { channels } = parseM3u('﻿#EXTM3U\r\n#EXTINF:-1,Ch\r\nhttp://x/1.ts\r\n')
    expect(channels).toHaveLength(1)
    expect(channels[0].name).toBe('Ch')
  })

  it('returns an empty channel list for a playlist with no #EXTINF entries', () => {
    expect(parseM3u('#EXTM3U\n').channels).toEqual([])
  })
})
