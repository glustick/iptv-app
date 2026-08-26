import { describe, it, expect, vi, afterEach } from 'vitest'
import { XtreamClient } from './xtream'

function mockFetchJson(body: unknown, status = 200): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body)
  }) as unknown as typeof fetch
}

describe('XtreamClient', () => {
  const client = new XtreamClient('http://127.0.0.1:9999/', 'user', 'pass')

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('strips a trailing slash from the server base URL', () => {
    expect(client.getStreamUrl('live', 1, 'm3u8')).toBe('http://127.0.0.1:9999/live/user/pass/1.m3u8')
  })

  it('builds correctly-shaped stream URLs per media kind', () => {
    expect(client.getStreamUrl('movie', 42, 'mp4')).toBe('http://127.0.0.1:9999/movie/user/pass/42.mp4')
    expect(client.getStreamUrl('series', 7, 'mkv')).toBe('http://127.0.0.1:9999/series/user/pass/7.mkv')
  })

  it('builds a timeshift URL per the Xtream catch-up convention', () => {
    const start = new Date(2026, 0, 5, 9, 5) // Jan 5 2026, 09:05 local
    const url = client.getTimeshiftUrl(101, start, 90.4)
    expect(url).toBe('http://127.0.0.1:9999/timeshift/user/pass/90/2026-01-05:09-05/101.m3u8')
  })

  it('rejects authentication when the server reports auth: 0', async () => {
    mockFetchJson({ user_info: { auth: 0 }, server_info: {} })
    await expect(client.authenticate()).rejects.toThrow('Invalid Xtream credentials')
  })

  it('resolves authentication when the server reports auth: 1', async () => {
    mockFetchJson({ user_info: { auth: 1, username: 'user' }, server_info: { timezone: 'UTC' } })
    const result = await client.authenticate()
    expect(result.user_info.auth).toBe(1)
  })

  it('throws a descriptive error on a non-ok HTTP response', async () => {
    mockFetchJson({}, 502)
    await expect(client.getLiveCategories()).rejects.toThrow('Xtream request failed: 502')
  })

  it('base64-decodes get_short_epg title and description fields', async () => {
    const encode = (s: string): string => Buffer.from(s, 'utf-8').toString('base64')
    mockFetchJson({
      epg_listings: [
        {
          id: '1',
          epg_id: 'chan',
          title: encode('Evening News'),
          lang: '',
          start: '2026-01-01 18:00:00',
          end: '2026-01-01 19:00:00',
          description: encode('Today’s headlines.'),
          channel_id: 'chan',
          start_timestamp: '1',
          stop_timestamp: '2'
        }
      ]
    })
    const listings = await client.getShortEpg(55)
    expect(listings[0].title).toBe('Evening News')
    expect(listings[0].description).toBe('Today’s headlines.')
  })

  it('falls back to the raw value when a short-EPG field is not valid base64', async () => {
    mockFetchJson({
      epg_listings: [
        {
          id: '1',
          epg_id: 'chan',
          title: 'Not Base64 At All!!',
          lang: '',
          start: '',
          end: '',
          description: '',
          channel_id: 'chan',
          start_timestamp: '1',
          stop_timestamp: '2'
        }
      ]
    })
    const listings = await client.getShortEpg(55)
    expect(listings[0].title).toBe('Not Base64 At All!!')
  })
})
