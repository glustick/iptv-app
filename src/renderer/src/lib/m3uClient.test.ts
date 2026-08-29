import { describe, it, expect, vi, afterEach } from 'vitest'
import { M3uClient } from './m3uClient'

const SAMPLE_M3U = `#EXTM3U
#EXTINF:-1 tvg-id="bbc1.uk" tvg-logo="http://x/bbc1.png" group-title="News",BBC One
http://provider.example/1.ts
#EXTINF:-1 tvg-id="itv.uk" tvg-logo="http://x/itv.png" group-title="News",ITV
http://provider.example/2.ts
#EXTINF:-1 tvg-id="mtv.uk" tvg-logo="" group-title="Music",MTV
http://provider.example/3.ts`

// XMLTV timestamps as `YYYYMMDDHHMMSS +0000`, built relative to "now" rather than a fixed date
// so this fixture never quietly becomes "a programme from the past" as time goes on.
function xmltvStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`
}

function sampleEpg(): string {
  const now = new Date()
  const pastStart = new Date(now.getTime() - 3_600_000)
  const currentStop = new Date(now.getTime() + 1_800_000)
  const futureStart = new Date(now.getTime() + 1_800_000)
  const futureStop = new Date(now.getTime() + 5_400_000)
  return `<?xml version="1.0"?>
<tv>
  <channel id="bbc1.uk"><display-name>BBC One</display-name></channel>
  <programme channel="bbc1.uk" start="${xmltvStamp(pastStart)}" stop="${xmltvStamp(currentStop)}">
    <title>Now Playing</title>
    <desc>Currently on.</desc>
  </programme>
  <programme channel="bbc1.uk" start="${xmltvStamp(futureStart)}" stop="${xmltvStamp(futureStop)}">
    <title>Coming Up</title>
    <desc>Later today.</desc>
  </programme>
</tv>`
}

function mockFetchText(byUrl: (url: string) => { ok: boolean; status?: number; text: string }): void {
  global.fetch = vi.fn((url: string) => {
    const result = byUrl(url)
    return Promise.resolve({
      ok: result.ok,
      status: result.status ?? (result.ok ? 200 : 500),
      statusText: result.ok ? 'OK' : 'Error',
      text: () => Promise.resolve(result.text)
    })
  }) as unknown as typeof fetch
}

function decodeFetchedUrl(proxyRequestUrl: string): string {
  return decodeURIComponent(proxyRequestUrl.replace(/^http:\/\/proxy\/__fetch\//, ''))
}

describe('M3uClient', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('routes the playlist fetch through the proxy /__fetch/ passthrough', async () => {
    mockFetchText(() => ({ ok: true, text: SAMPLE_M3U }))
    const client = new M3uClient('http://proxy', 'http://provider.example/playlist.m3u', null)

    await client.authenticate()

    expect(global.fetch).toHaveBeenCalledWith('http://proxy/__fetch/' + encodeURIComponent('http://provider.example/playlist.m3u'))
  })

  it('parses live channels grouped into categories by group-title', async () => {
    mockFetchText(() => ({ ok: true, text: SAMPLE_M3U }))
    const client = new M3uClient('http://proxy', 'http://provider.example/playlist.m3u', null)
    await client.authenticate()

    const categories = await client.getLiveCategories()
    expect(categories.map((c) => c.category_name).sort()).toEqual(['Music', 'News'])

    const newsChannels = await client.getLiveStreams('News')
    expect(newsChannels.map((c) => c.name)).toEqual(['BBC One', 'ITV'])
    expect(newsChannels.every((c) => c.tv_archive === 0)).toBe(true)
  })

  it('assigns each channel a stable, unique numeric stream_id', async () => {
    mockFetchText(() => ({ ok: true, text: SAMPLE_M3U }))
    const client = new M3uClient('http://proxy', 'http://provider.example/playlist.m3u', null)
    await client.authenticate()

    const all = await client.getLiveStreams()
    expect(new Set(all.map((c) => c.stream_id)).size).toBe(all.length)
  })

  it('returns a proxied stream URL for a known channel and throws for VOD/series kinds', async () => {
    mockFetchText(() => ({ ok: true, text: SAMPLE_M3U }))
    const client = new M3uClient('http://proxy', 'http://provider.example/playlist.m3u', null)
    await client.authenticate()
    const [channel] = await client.getLiveStreams('News')

    expect(client.getStreamUrl('live', channel.stream_id, 'ts')).toBe(
      `http://proxy/__fetch/${encodeURIComponent('http://provider.example/1.ts')}`
    )
    expect(() => client.getStreamUrl('movie', channel.stream_id, 'mp4')).toThrow(/live-TV only/)
  })

  it('reports max_connections as unknown (0) rather than assuming a single-connection cap', async () => {
    mockFetchText(() => ({ ok: true, text: SAMPLE_M3U }))
    const client = new M3uClient('http://proxy', 'http://provider.example/playlist.m3u', null)

    const auth = await client.authenticate()

    expect(auth.user_info.max_connections).toBe('0')
  })

  it('throws a descriptive error when the playlist has no channels', async () => {
    mockFetchText(() => ({ ok: true, text: '#EXTM3U\n' }))
    const client = new M3uClient('http://proxy', 'http://provider.example/playlist.m3u', null)

    await expect(client.authenticate()).rejects.toThrow('No channels found')
  })

  it('returns empty VOD/series catalogs instead of throwing', async () => {
    mockFetchText(() => ({ ok: true, text: SAMPLE_M3U }))
    const client = new M3uClient('http://proxy', 'http://provider.example/playlist.m3u', null)
    await client.authenticate()

    expect(await client.getVodCategories()).toEqual([])
    expect(await client.getVodStreams()).toEqual([])
    expect(await client.getSeriesCategories()).toEqual([])
    expect(await client.getSeries()).toEqual([])
  })

  it('derives short-EPG listings for a channel from the explicit EPG URL, matched by tvg-id', async () => {
    mockFetchText((url) => {
      const real = decodeFetchedUrl(url)
      return { ok: true, text: real.includes('playlist') ? SAMPLE_M3U : sampleEpg() }
    })
    const client = new M3uClient('http://proxy', 'http://provider.example/playlist.m3u', 'http://provider.example/epg.xml')
    await client.authenticate()
    const [bbcOne] = await client.getLiveStreams('News')

    const listings = await client.getShortEpg(bbcOne.stream_id, 10)

    // Only the current and future programmes should survive get_short_epg's own "now onward"
    // contract — the currently-playing one is included since it hasn't stopped yet.
    expect(listings.map((l) => l.title)).toEqual(['Now Playing', 'Coming Up'])
    expect(listings[0].channel_id).toBe('bbc1.uk')
  })

  it('caps short-EPG results at the requested limit', async () => {
    mockFetchText((url) => {
      const real = decodeFetchedUrl(url)
      return { ok: true, text: real.includes('playlist') ? SAMPLE_M3U : sampleEpg() }
    })
    const client = new M3uClient('http://proxy', 'http://provider.example/playlist.m3u', 'http://provider.example/epg.xml')
    await client.authenticate()
    const [bbcOne] = await client.getLiveStreams('News')

    const listings = await client.getShortEpg(bbcOne.stream_id, 1)

    expect(listings).toHaveLength(1)
  })

  it('returns an empty short-EPG list for a channel with no tvg-id or no EPG URL configured', async () => {
    mockFetchText(() => ({ ok: true, text: SAMPLE_M3U }))
    const client = new M3uClient('http://proxy', 'http://provider.example/playlist.m3u', null)
    await client.authenticate()
    const [mtv] = await client.getLiveStreams('Music')

    expect(await client.getShortEpg(mtv.stream_id)).toEqual([])
  })

  it('throws for getSeriesInfo and getTimeshiftUrl, which have no M3U equivalent', async () => {
    mockFetchText(() => ({ ok: true, text: SAMPLE_M3U }))
    const client = new M3uClient('http://proxy', 'http://provider.example/playlist.m3u', null)
    await client.authenticate()

    await expect(client.getSeriesInfo(1)).rejects.toThrow()
    expect(() => client.getTimeshiftUrl(1, new Date(), 30)).toThrow()
  })
})
