// A synthetic Xtream Codes provider, served over real HTTP by a real Node server.
//
// Why it exists: everything in the EPG pipeline (client → XMLTV parse → matching → pool) can only
// be exercised end-to-end against *a* provider, and the real one is a third party that can be
// down, rate-limited, or simply unavailable in CI. This fixture answers the exact subset of
// `player_api.php`/`xmltv.php` the app uses, so integration tests can drive the real client and
// the real store over a real socket — no mocking of fetch, no stubbing of the client — and assert
// the whole chain including its tier-by-tier matching behaviour.
//
// Deliberately dependency-free (node:http) and entirely local: it binds 127.0.0.1 on an ephemeral
// port and is closed by the tests that start it.
import { createServer } from 'http'
import type { AddressInfo } from 'net'

export interface MockXtreamServer {
  /** Base URL to hand to XtreamClient / the store's proxyBase. */
  url: string
  /** Ids the fixtures use, so tests don't hardcode magic numbers in two places. */
  ids: {
    categoryLive: string
    channelMatchedById: number
    channelMatchedByFuzzyName: number
    channelUnmatchedByProviderGuide: number
    channelOnlyInCustomSource: string
    movieId: number
    seriesId: number
  }
  close: () => Promise<void>
}

// The provider's own guide: covers two of the three channels (one by matching epg_channel_id, one
// by the relaxed name tier), and deliberately says nothing about a third.
const PROVIDER_GUIDE = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="one.hd"><display-name>One HD</display-name></channel>
  <channel id="two.uk"><display-name>Two</display-name></channel>
  <programme start="20300101120000 +0000" stop="20300101130000 +0000" channel="one.hd"><title>One's Show</title></programme>
  <programme start="20300101130000 +0000" stop="20300101140000 +0000" channel="one.hd"><title>One's Next</title></programme>
  <programme start="20300101120000 +0000" stop="20300101130000 +0000" channel="two.uk"><title>Two's Show</title></programme>
</tv>`

// A user-added third-party guide, reachable through the app's `/__fetch/` passthrough. It is the
// only source that knows about the channel the provider's guide misses.
const CUSTOM_GUIDE = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="custom.missing"><display-name>Unmatched Channel</display-name></channel>
  <programme start="20300101120000 +0000" stop="20300101130000 +0000" channel="custom.missing"><title>Found Only Here</title></programme>
</tv>`

const ids = {
  categoryLive: '10',
  channelMatchedById: 101,
  channelMatchedByFuzzyName: 102,
  channelUnmatchedByProviderGuide: 103,
  channelOnlyInCustomSource: 'custom.missing',
  movieId: 201,
  seriesId: 301
}

const LIVE_STREAMS = [
  live(ids.channelMatchedById, 'One HD', 'one.hd', '10'),
  // No epg_channel_id, and a name carrying a channel-list position and a quality tag: only the
  // relaxed tier can join this one to the guide's "Two" — which is exactly what it's here to prove.
  live(ids.channelMatchedByFuzzyName, '101 Two HD', null, '10'),
  live(ids.channelUnmatchedByProviderGuide, 'Unmatched Channel', null, '10')
]

function live(streamId: number, name: string, epgChannelId: string | null, categoryId: string) {
  return {
    num: streamId,
    name,
    stream_type: 'live',
    stream_id: streamId,
    stream_icon: '',
    epg_channel_id: epgChannelId,
    added: '0',
    category_id: categoryId,
    custom_sid: null,
    tv_archive: 0,
    direct_source: '',
    tv_archive_duration: 0
  }
}

export interface MockXtreamServerOptions {
  /** Fixed port for running the fixture as a standalone dev server (tests use the default 0 =
   * ephemeral, so parallel test files can't collide). */
  port?: number
}

export async function startMockXtreamServer(options: MockXtreamServerOptions = {}): Promise<MockXtreamServer> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const text = (body: string, type = 'application/xml'): void => {
      res.writeHead(200, { 'content-type': type })
      res.end(body)
    }

    if (url.pathname === '/xmltv.php') {
      text(PROVIDER_GUIDE)
      return
    }

    // The app fetches user-added sources through its own proxy's passthrough route; this stands in
    // for the far end of that hop so the custom-source path is exercised too.
    if (url.pathname.startsWith('/__fetch/')) {
      const target = decodeURIComponent(url.pathname.slice('/__fetch/'.length))
      if (target.includes('custom')) {
        text(CUSTOM_GUIDE)
        return
      }
      res.writeHead(404)
      res.end('Not found')
      return
    }

    if (url.pathname !== '/player_api.php') {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const action = url.searchParams.get('action')
    if (!action) {
      json({
        user_info: {
          username: url.searchParams.get('username') ?? '',
          password: url.searchParams.get('password') ?? '',
          auth: 1,
          status: 'Active',
          exp_date: null,
          is_trial: '0',
          active_cons: '1',
          created_at: '0',
          max_connections: '2'
        },
        server_info: {
          url: '127.0.0.1',
          port: String(url.port),
          https_port: '',
          server_protocol: 'http',
          timezone: 'UTC'
        }
      })
      return
    }

    switch (action) {
      case 'get_live_categories':
        json([{ category_id: '10', category_name: 'Live News', parent_id: 0 }])
        return
      case 'get_live_streams': {
        const categoryId = url.searchParams.get('category_id')
        json(categoryId ? LIVE_STREAMS.filter((s) => s.category_id === categoryId) : LIVE_STREAMS)
        return
      }
      case 'get_vod_categories':
        json([{ category_id: '20', category_name: 'Movies', parent_id: 0 }])
        return
      case 'get_vod_streams':
        json([
          {
            num: 1,
            name: 'A Movie',
            stream_type: 'movie',
            stream_id: ids.movieId,
            stream_icon: '',
            rating: '7.0',
            rating_5based: 3.5,
            added: '0',
            category_id: '20',
            container_extension: 'mp4'
          }
        ])
        return
      case 'get_series_categories':
        json([{ category_id: '30', category_name: 'Series', parent_id: 0 }])
        return
      case 'get_series':
        json([
          {
            num: 1,
            name: 'A Series',
            series_id: ids.seriesId,
            cover: '',
            plot: '',
            cast: '',
            director: '',
            genre: '',
            releaseDate: '',
            rating: '8.0',
            category_id: '30'
          }
        ])
        return
      case 'get_series_info':
        json({ seasons: [], episodes: {}, info: {}, available_episodes: 0 })
        return
      case 'get_short_epg': {
        const streamId = url.searchParams.get('stream_id')
        json({
          epg_listings:
            streamId === String(ids.channelMatchedById)
              ? [
                  {
                    id: '1',
                    epg_id: 'one.hd',
                    title: Buffer.from('Short EPG Title').toString('base64'),
                    lang: '',
                    start: '2030-01-01 12:00:00',
                    end: '2030-01-01 13:00:00',
                    description: Buffer.from('Desc').toString('base64'),
                    channel_id: 'one.hd',
                    start_timestamp: '1893456000',
                    stop_timestamp: '1893459600'
                  }
                ]
              : []
        })
        return
      }
      default:
        json([])
    }
  })

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    ids,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}
