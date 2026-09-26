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
import { execFile } from 'child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

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
    channelResidue: number
    movieId: number
    seriesId: number
  }
  close: () => Promise<void>
}

// Programme times are generated RELATIVE to now, not hard-coded. A fixed future date (2030, say)
// parses and matches perfectly but renders as an empty grid — the app's timeline shows the current
// window — which makes the fixture useless for anything UI-facing. Relative times mean the grid,
// the preview's now/next and the EPG mapping editor all show real blocks.
function xmltvTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`
}

function isoLocal(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

const NOW = Math.floor(Date.now() / 1000)
const PROGRAMME_START = NOW - 1800 // started half an hour ago
const PROGRAMME_END = NOW + 1800 // …and runs for another half hour
const NEXT_START = PROGRAMME_END
const NEXT_END = PROGRAMME_END + 3600

// The provider's own guide: covers two of the three channels (one by matching epg_channel_id, one
// by the relaxed name tier), and deliberately says nothing about a third.
const PROVIDER_GUIDE = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="one.hd"><display-name>One HD</display-name></channel>
  <channel id="two.uk"><display-name>Two</display-name></channel>
  <channel id="one.news"><display-name>Channel One News</display-name></channel>
  <programme start="${xmltvTime(PROGRAMME_START)}" stop="${xmltvTime(PROGRAMME_END)}" channel="one.hd"><title>One's Show</title></programme>
  <programme start="${xmltvTime(NEXT_START)}" stop="${xmltvTime(NEXT_END)}" channel="one.hd"><title>One's Next</title></programme>
  <programme start="${xmltvTime(PROGRAMME_START)}" stop="${xmltvTime(PROGRAMME_END)}" channel="two.uk"><title>Two's Show</title></programme>
  <programme start="${xmltvTime(PROGRAMME_START)}" stop="${xmltvTime(PROGRAMME_END)}" channel="one.news"><title>News at One</title></programme>
</tv>`

// A user-added third-party guide, reachable through the app's `/__fetch/` passthrough. It is the
// only source that knows about the channel the provider's guide misses.
const CUSTOM_GUIDE = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="custom.missing"><display-name>Unmatched Channel</display-name></channel>
  <programme start="${xmltvTime(PROGRAMME_START)}" stop="${xmltvTime(PROGRAMME_END)}" channel="custom.missing"><title>Found Only Here</title></programme>
  <channel id="custom.news"><display-name>Channel One News</display-name></channel>
  <programme start="${xmltvTime(PROGRAMME_START)}" stop="${xmltvTime(PROGRAMME_END)}" channel="custom.news"><title>News Elsewhere</title></programme>
</tv>`

const ids = {
  categoryLive: '10',
  channelMatchedById: 101,
  channelMatchedByFuzzyName: 102,
  channelUnmatchedByProviderGuide: 103,
  channelOnlyInCustomSource: 'custom.missing',
  channelResidue: 105,
  movieId: 201,
  seriesId: 301
}

const LIVE_STREAMS = [
  live(ids.channelMatchedById, 'One HD', 'one.hd', '10'),
  // Residue by construction: "Channel One News Extra" shares two of its three loose tokens with the
  // guide's "Channel One News", so it is NOT an exact or relaxed match — but it scores 0.8, which is
  // what the bulk-suggestion planner exists to place. Without a channel like this the bulk apply
  // has nothing to do and any check of it would be vacuous.
  live(ids.channelResidue, 'Channel One News Extra', null, '10'),
  // No epg_channel_id, and a name carrying a channel-list position and a quality tag: only the
  // relaxed tier can join this one to the guide's "Two" — which is exactly what it's here to prove.
  live(ids.channelMatchedByFuzzyName, '101 Two HD', null, '10'),
  live(ids.channelUnmatchedByProviderGuide, 'Unmatched Channel', null, '10'),
  // Sports fixtures for the Sports tab: one fixture spread across two football categories with
  // different feed annotations (the real providers' shape — one game, many channels), a
  // no-separator "TeamA HH:MM TeamB" name, a second sport, and a carrier channel that must
  // never parse as a game.
  live(910, 'FBL01: Arsenal vs Chelsea ( Sky Sports Main Event Feed ) @ 3:00 pm', null, '40'),
  live(911, 'FBL02: Arsenal vs Chelsea (TNT Sports Feed) @ 3:00 pm', null, '40'),
  live(920, 'FBL-B1: Arsenal vs Chelsea (Backup) @ 3:00 pm', null, '50'),
  live(930, 'FBL04: Spurs 20:00 Liverpool', null, '40'),
  live(940, 'NFL01: Chiefs vs Ravens @ 8:15 PM', null, '60'),
  live(950, '401 Sky Sports Main Event HD', null, '40')
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
  /**
   * Absolute path to an ffmpeg binary. When supplied, the fixture generates a small playable HLS
   * stream (test pattern + tone) lazily on first request and serves it at the Xtream stream path
   * `/live/<user>/<pass>/<id>.m3u8` — which is what makes an END-TO-END playback assertion
   * possible: an Electron/Chromium upgrade can break decoding while every other check still
   * passes. Left out, stream URLs 404, so tests that don't play anything never pay for media
   * generation (and never depend on ffmpeg being present).
   *
   * The path is passed in rather than imported here because this file gets bundled by esbuild for
   * the standalone runner, and ffmpeg-static resolves its binary relative to its own module
   * directory — bundling would break that resolution.
   */
  ffmpegPath?: string
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

    // Xtream stream paths — the app plays live TV as /live/<user>/<pass>/<id>.m3u8 through its own
    // proxy, so serving the same shape here lets real playback run against the fixture.
    if (url.pathname.startsWith('/live/')) {
      const name = url.pathname.split('/').pop() ?? ''
      if (!mediaDir) {
        res.writeHead(404)
        res.end('playback fixtures not configured')
        return
      }
      const variant = name.endsWith('.m3u8')
        ? variantForStreamId(name.replace(/\.m3u8$/, ''))
        : name.startsWith('dolby')
          ? 'dolby'
          : 'aac'
      void ensureMedia(variant)
        .then(() => {
          if (name.endsWith('.m3u8')) {
            text(readFileSync(join(mediaDir, `${variant}.m3u8`), 'utf8'), 'application/vnd.apple.mpegurl')
            return
          }
          if (name.endsWith('.ts')) {
            res.writeHead(200, { 'content-type': 'video/mp2t' })
            res.end(readFileSync(join(mediaDir, name)))
            return
          }
          res.writeHead(404)
          res.end('not found')
        })
        .catch(() => {
          res.writeHead(500)
          res.end('media generation failed')
        })
      return
    }

    // VOD (movie) media at the Xtream VOD path. The app plays VOD as a plain video.src assignment
    // and probes the file's own streams with ffmpeg before offering audio/subtitle pickers, so an
    // MP4 that actually carries a subtitle track is what makes that half of the path verifiable —
    // nothing here previously had one, which left the subtitle probe, the picker and the
    // transcode-with-subtitles rendition entirely unexercised by machine.
    if (url.pathname.startsWith('/movie/') || url.pathname.startsWith('/series/')) {
      if (!mediaDir) {
        res.writeHead(404)
        res.end('playback fixtures not configured')
        return
      }
      void ensureMovie()
        .then(() => {
          const file = readFileSync(join(mediaDir, 'movie.mp4'))
          // Chromium asks for byte ranges on a progressive MP4 (and for seeking); answering 206
          // with the requested slice keeps duration/seek behaving like a real origin. A plain 200
          // body also plays, but then the element can't seek at all.
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
          if (range) {
            const start = range[1] ? Number(range[1]) : 0
            const end = range[2] ? Number(range[2]) : file.length - 1
            const slice = file.subarray(start, Math.min(end, file.length - 1) + 1)
            res.writeHead(206, {
              'content-type': 'video/mp4',
              'content-range': `bytes ${start}-${start + slice.length - 1}/${file.length}`,
              'content-length': String(slice.length),
              'accept-ranges': 'bytes'
            })
            res.end(slice)
            return
          }
          res.writeHead(200, {
            'content-type': 'video/mp4',
            'content-length': String(file.length),
            'accept-ranges': 'bytes'
          })
          res.end(file)
        })
        .catch(() => {
          res.writeHead(500)
          res.end('media generation failed')
        })
      return
    }

    // The user-added guide. The app fetches custom sources through its own proxy's /__fetch/
    // passthrough, which means the fixture sees a request for the *registered* URL's path — so any
    // path mentioning "custom" serves that guide, the same rule the /__fetch/ branch below uses.
    if (url.pathname.includes('custom')) {
      text(CUSTOM_GUIDE)
      return
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
        json([
          { category_id: '10', category_name: 'Live News', parent_id: 0 },
          { category_id: '40', category_name: 'Live | Football', parent_id: 0 },
          { category_id: '50', category_name: 'Live | Football Backup', parent_id: 0 },
          { category_id: '60', category_name: 'USA | NFL', parent_id: 0 }
        ])
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
                    start: isoLocal(PROGRAMME_START),
                    end: isoLocal(PROGRAMME_END),
                    description: Buffer.from('Desc').toString('base64'),
                    channel_id: 'one.hd',
                    start_timestamp: String(PROGRAMME_START),
                    stop_timestamp: String(PROGRAMME_END)
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

  // Lazily generated playable media (see the ffmpegPath option): two streams, because the app has
  // two playback paths worth exercising — AAC (normal) and E-AC-3, the "Dolby" audio the app's
  // ffmpeg audio-fix fallback exists for. Segment names are prefixed per variant so both live in
  // one directory and can be served by name.
  const mediaDir = options.ffmpegPath ? mkdtempSync(join(tmpdir(), 'mock-hls-')) : null
  const mediaReady = new Map<string, Promise<void>>()
  let movieReady: Promise<void> | null = null
  const ensureMedia = (variant: 'aac' | 'dolby'): Promise<void> => {
    if (!options.ffmpegPath || !mediaDir) return Promise.resolve()
    let pending = mediaReady.get(variant)
    if (!pending) {
      pending = new Promise<void>((resolve, reject) => {
        execFile(
          options.ffmpegPath!,
          [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
            '-f', 'lavfi', '-i', 'sine=frequency=440',
            '-t', '6',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '25',
            '-c:a', variant === 'dolby' ? 'eac3' : 'aac',
            ...(variant === 'dolby' ? ['-b:a', '192k'] : []),
            '-hls_time', '2', '-hls_list_size', '0',
            '-hls_segment_filename', join(mediaDir, `${variant}%d.ts`),
            join(mediaDir, `${variant}.m3u8`)
          ],
          (err) => (err ? reject(err) : resolve())
        )
      })
      mediaReady.set(variant, pending)
    }
    return pending
  }

  // VOD media: one MP4 carrying video, AAC audio and a single text (mov_text) subtitle track with
  // an English language tag — the language is what the app's picker actually displays, so tagging
  // it makes the rendered option assertable. mov_text is deliberately a member of the app's own
  // TEXT_SUBTITLE_CODECS: a bitmap track (PGS/VobSub) can't be converted to WebVTT at all and
  // crashes the whole transcode, which is a different, separately-handled code path.
  const ensureMovie = (): Promise<void> => {
    if (!options.ffmpegPath || !mediaDir) return Promise.resolve()
    let pending = movieReady
    if (!pending) {
      const srtPath = join(mediaDir, 'movie.srt')
      writeFileSync(srtPath, '1\n00:00:00,500 --> 00:00:05,500\nSubtitle fixture line.\n')
      pending = new Promise<void>((resolve, reject) => {
        execFile(
          options.ffmpegPath!,
          [
            '-hide_banner', '-loglevel', 'error',
            '-y',
            '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
            '-f', 'lavfi', '-i', 'sine=frequency=440',
            '-i', srtPath,
            '-t', '6',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-c:s', 'mov_text',
            '-metadata:s:s:0', 'language=eng',
            '-movflags', '+faststart',
            join(mediaDir, 'movie.mp4')
          ],
          (err) => (err ? reject(err) : resolve())
        )
      })
      movieReady = pending
    }
    return pending
  }

  /** Which variant a stream id plays — the unmatched-channel id carries the Dolby audio, so the
   * audio-fix fallback can be exercised without disturbing the channels the other checks use. */
  const variantForStreamId = (streamId: string): 'aac' | 'dolby' =>
    streamId === String(ids.channelUnmatchedByProviderGuide) ? 'dolby' : 'aac' 

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
