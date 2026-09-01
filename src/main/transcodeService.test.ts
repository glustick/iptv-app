import { describe, it, expect, afterEach } from 'vitest'
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { spawn } from 'child_process'
import ffmpegStaticPath from 'ffmpeg-static'
import { createTranscodeService, type TranscodeService, type TranscodeServiceDeps } from './transcodeService'

const FAKE_FFMPEG = join(import.meta.dirname, 'test-fixtures/fake-ffmpeg.sh')
chmodSync(FAKE_FFMPEG, 0o755)

function resolverFor(path: string | null): () => Promise<string | null> {
  return () => Promise.resolve(path)
}

// Short deadlines throughout so tests exercise real timeout/poll behavior without actually
// waiting out startTranscode's real 20s/240s/2s production defaults.
function makeService(deps: Partial<TranscodeServiceDeps> & { resolveFfmpegPath: TranscodeServiceDeps['resolveFfmpegPath'] }): TranscodeService {
  return createTranscodeService({
    liveDeadlineMs: 2000,
    vodDeadlineMs: 2000,
    pollIntervalMs: 50,
    stopGraceMs: 300,
    ...deps
  })
}

function withFakeFfmpegMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.FAKE_FFMPEG_MODE
  process.env.FAKE_FFMPEG_MODE = mode
  return fn().finally(() => {
    if (previous === undefined) delete process.env.FAKE_FFMPEG_MODE
    else process.env.FAKE_FFMPEG_MODE = previous
  })
}

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  return fn().finally(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

const activeServices: TranscodeService[] = []
afterEach(() => {
  for (const service of activeServices.splice(0)) service.stopAll()
})

function track(service: TranscodeService): TranscodeService {
  activeServices.push(service)
  return service
}

describe('startTranscode', () => {
  it('throws when no ffmpeg binary is available', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(null) }))

    await expect(service.startTranscode('http://example.com/stream.ts', false, 's1')).rejects.toThrow(
      'ffmpeg binary not available'
    )
  })

  it('throws "Transcode cancelled" when stopTranscode already ran for this sessionId before it starts', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))
    await service.stopTranscode('s1') // marks s1 cancelled; nothing to actually stop yet

    await expect(service.startTranscode('http://example.com/stream.ts', false, 's1')).rejects.toThrow(
      'Transcode cancelled'
    )
  })

  it('resolves with a real playlist path once ffmpeg produces one', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))

    const result = await withFakeFfmpegMode('success', () => service.startTranscode('irrelevant-source', false, 's1'))

    expect(result.sessionId).toBe('s1')
    expect(existsSync(result.playlistPath)).toBe(true)
    expect(readFileSync(result.playlistPath, 'utf8')).toContain('#EXTM3U')
    await service.stopTranscode('s1')
  })

  it('rejects with the stderr tail when ffmpeg exits immediately with an error', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))

    await expect(
      withFakeFfmpegMode('fail_immediately', () => service.startTranscode('irrelevant-source', false, 's1'))
    ).rejects.toThrow(/simulated fatal error/)
  })

  it('times out and stops the process when ffmpeg never produces a playlist', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))

    await expect(
      withFakeFfmpegMode('hang_forever', () => service.startTranscode('irrelevant-source', false, 's1'))
    ).rejects.toThrow('Timed out waiting for ffmpeg')
  })

  it('returns the master playlist once both it and the subtitle rendition exist', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), subtitleGraceMs: 2000 }))

    const result = await withFakeFfmpegMode('success_with_subtitles', () =>
      service.startTranscode('irrelevant-source', true, 's1')
    )

    expect(result.playlistPath.endsWith('master.m3u8')).toBe(true)
    expect(result.subtitleTracks).toEqual([{ index: 0, language: 'eng', supported: true }])
    const master = readFileSync(result.playlistPath, 'utf8')
    expect(master).toContain('TYPE=SUBTITLES')
    expect(master).toContain('URI="playlist_vtt.m3u8"')
    expect(master).toContain('playlist.m3u8')
    await service.stopTranscode('s1')
  })

  // Selecting which language to carry through is the whole point of exposing subtitleTracks —
  // see ROADMAP.md for why this app's ffmpeg build can only ever map one at a time (every
  // attempt at more than one, via -var_stream_map or separate outputs, fails identically).
  it('reports every subtitle track found, in the source order ffmpeg\'s own -map specifier addresses them by', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), subtitleGraceMs: 2000 }))

    const result = await withFakeFfmpegMode('success_with_multiple_subtitles', () =>
      service.startTranscode('irrelevant-source', true, 's1')
    )

    expect(result.subtitleTracks).toEqual([
      { index: 0, language: 'eng', supported: true },
      { index: 1, language: 'fre', supported: true }
    ])
    await service.stopTranscode('s1')
  })

  it('maps the requested subtitleStreamIndex, not just the first track', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), subtitleGraceMs: 2000 }))

    const result = await withFakeFfmpegMode('success_with_multiple_subtitles', () =>
      service.startTranscode('irrelevant-source', true, 's1', 1)
    )

    // The fake ffmpeg's argv is fixed regardless of subtitleStreamIndex (see the fixture's own
    // comment) — what this actually confirms is that a *non-default* requested index doesn't
    // break the "does the mapped track exist" check that decides whether to wait for and build
    // the master playlist. The real -map argv wiring (0:s:{index}) is confirmed separately
    // against the genuine bundled ffmpeg binary, below.
    expect(result.playlistPath.endsWith('master.m3u8')).toBe(true)
    await service.stopTranscode('s1')
  })

  it('falls back to the plain playlist when the requested subtitleStreamIndex does not exist in the source', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), subtitleGraceMs: 2000 }))

    // Only track 0 exists in this fixture — requesting index 5 should behave exactly like "no
    // subtitle track" rather than hanging around waiting for a rendition that can't exist.
    const result = await withFakeFfmpegMode('success_with_subtitles', () =>
      service.startTranscode('irrelevant-source', true, 's1', 5)
    )

    expect(result.playlistPath.endsWith('playlist.m3u8')).toBe(true)
    expect(result.playlistPath.endsWith('master.m3u8')).toBe(false)
    await service.stopTranscode('s1')
  })

  // Confirmed live against a real Blu-ray-sourced movie (see ROADMAP.md): a bitmap subtitle
  // codec (PGS) crashes ffmpeg entirely — video and audio included — before it writes a single
  // frame, because its webvtt encoder can only convert text-to-text or bitmap-to-bitmap. This is
  // the safety net for that: retry once with no subtitle mapped at all rather than letting a
  // subtitle-format incompatibility take down the audio fix this whole fallback exists for.
  it('retries without any subtitle mapped when ffmpeg fails on an incompatible (bitmap) subtitle codec', async () => {
    const markerFile = join(mkdtempSync(join(tmpdir(), 'allisoniptv-marker-')), 'attempted')
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))

    const result = await withEnv({ FAKE_FFMPEG_MARKER_FILE: markerFile }, () =>
      withFakeFfmpegMode('subtitle_codec_incompatible_then_succeeds', () =>
        service.startTranscode('irrelevant-source', true, 's1', 0)
      )
    )

    expect(result.playlistPath.endsWith('playlist.m3u8')).toBe(true)
    expect(existsSync(markerFile)).toBe(true)
    await service.stopTranscode('s1')
  })

  it('does not retry forever if the identical incompatible-codec failure recurs on the retry itself', async () => {
    // Real ffmpeg genuinely can't hit this exact message twice in a row here — the retry maps
    // no subtitle at all — but this confirms the guard (subtitleStreamIndex >= 0) is what
    // actually prevents runaway recursion, not just "it happens not to recur in practice."
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))

    await expect(
      withFakeFfmpegMode('subtitle_codec_incompatible_always', () =>
        service.startTranscode('irrelevant-source', true, 's1', 0)
      )
    ).rejects.toThrow(/ffmpeg exited before producing output/)
  })

  it('falls back to the plain video playlist if the subtitle rendition never actually appears', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), subtitleGraceMs: 200 }))

    const result = await withFakeFfmpegMode('subtitle_detected_but_rendition_never_written', () =>
      service.startTranscode('irrelevant-source', true, 's1')
    )

    expect(result.playlistPath.endsWith('playlist.m3u8')).toBe(true)
    await service.stopTranscode('s1')
  })

  it('ignores a detected subtitle stream on a Live TV session and returns the plain playlist immediately', async () => {
    // Live's argv never requests a subtitle stream (see startTranscode) — this confirms the
    // source having one (which the fake ffmpeg's stderr line simulates regardless of argv,
    // matching how ffmpeg logs a source's real stream list either way) doesn't make a Live
    // session wait around for a rendition its own ffmpeg invocation was never going to produce.
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), subtitleGraceMs: 5000 }))

    const result = await withFakeFfmpegMode('success_with_subtitles', () =>
      service.startTranscode('irrelevant-source', false, 's1')
    )

    expect(result.playlistPath.endsWith('playlist.m3u8')).toBe(true)
    expect(result.playlistPath.endsWith('master.m3u8')).toBe(false)
    await service.stopTranscode('s1')
  })

  it('cleans up the temp directory once ffmpeg is stopped after producing output', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))
    const result = await withFakeFfmpegMode('success', () => service.startTranscode('irrelevant-source', false, 's1'))
    const dir = join(result.playlistPath, '..')

    await service.stopTranscode('s1')

    expect(existsSync(dir)).toBe(false)
  })
})

describe('stopTranscode', () => {
  it('is a safe no-op for a sessionId that was never started', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))
    await expect(service.stopTranscode('never-started')).resolves.toBeUndefined()
  })
})

describe('serveTranscodeFile', () => {
  function fakeResponse(): { res: ServerResponse; statusCode: () => number | undefined; body: () => string } {
    let status: number | undefined
    let body = ''
    const res = {
      writeHead: (code: number) => {
        status = code
      },
      end: (chunk?: unknown) => {
        if (chunk) body += chunk.toString()
      }
    } as unknown as ServerResponse
    return { res, statusCode: () => status, body: () => body }
  }

  it('returns 404 for a URL that does not match the expected shape', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))
    const { res, statusCode, body } = fakeResponse()

    await service.serveTranscodeFile('/__transcode/malformed', res)

    expect(statusCode()).toBe(404)
    expect(body()).toBe('Not found')
  })

  it('returns 404 for an unknown session even with a well-shaped URL', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))
    const { res, statusCode } = fakeResponse()

    await service.serveTranscodeFile('/__transcode/no-such-session/playlist.m3u8', res)

    expect(statusCode()).toBe(404)
  })

  it('serves the real playlist file for an active session with the right content type and CORS header', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))
    await withFakeFfmpegMode('success', () => service.startTranscode('irrelevant-source', false, 's1'))
    let headers: Record<string, string> = {}
    const res = {
      writeHead: (_code: number, h: Record<string, string>) => {
        headers = h
      },
      end: () => {}
    } as unknown as ServerResponse

    await service.serveTranscodeFile('/__transcode/s1/playlist.m3u8', res)

    expect(headers['content-type']).toBe('application/vnd.apple.mpegurl')
    expect(headers['access-control-allow-origin']).toBe('*')
    await service.stopTranscode('s1')
  })

  // A real live test against a real subtitle-carrying title caught this the hard way: without
  // a MIME entry for .vtt, every webvtt cue file ffmpeg writes (playlistN.vtt, referenced from
  // playlist_vtt.m3u8) 404s, and hls.js doesn't just play without captions — it treats that as
  // fatal and abandons the whole session (fragLoadError, gave up after retries), breaking
  // playback entirely for any title that happens to have subtitles.
  it('serves a WebVTT subtitle cue file with the right content type', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), subtitleGraceMs: 2000 }))
    const result = await withFakeFfmpegMode('success_with_subtitles', () =>
      service.startTranscode('irrelevant-source', true, 's1')
    )
    const dir = join(result.playlistPath, '..')
    writeFileSync(join(dir, 'playlist0.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nLine one\n')
    let headers: Record<string, string> = {}
    const res = {
      writeHead: (_code: number, h: Record<string, string>) => {
        headers = h
      },
      end: () => {}
    } as unknown as ServerResponse

    await service.serveTranscodeFile('/__transcode/s1/playlist0.vtt', res)

    expect(headers['content-type']).toBe('text/vtt')
    await service.stopTranscode('s1')
  })

  it('returns 404 for a known session but a filename with an unsupported extension', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))
    await withFakeFfmpegMode('success', () => service.startTranscode('irrelevant-source', false, 's1'))
    const { res, statusCode } = fakeResponse()

    await service.serveTranscodeFile('/__transcode/s1/notes.txt', res)

    expect(statusCode()).toBe(404)
    await service.stopTranscode('s1')
  })
})

describe('stopAll', () => {
  it('stops every currently active session', async () => {
    const service = createTranscodeService({
      resolveFfmpegPath: resolverFor(FAKE_FFMPEG),
      liveDeadlineMs: 2000,
      pollIntervalMs: 50,
      stopGraceMs: 300
    })
    const r1 = await withFakeFfmpegMode('success', () => service.startTranscode('src1', false, 's1'))
    const r2 = await withFakeFfmpegMode('success', () => service.startTranscode('src2', false, 's2'))

    service.stopAll()
    // stopAll is fire-and-forget by design (matches its one real caller, app 'before-quit') —
    // give the async stopTranscode calls it kicked off a moment to actually finish.
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(existsSync(join(r1.playlistPath, '..'))).toBe(false)
    expect(existsSync(join(r2.playlistPath, '..'))).toBe(false)
  })
})

describe('probeTracks', () => {
  it('throws when no ffmpeg binary is available', async () => {
    const service = createTranscodeService({ resolveFfmpegPath: resolverFor(null) })

    await expect(service.probeTracks('http://example.com/stream.ts')).rejects.toThrow('ffmpeg binary not available')
  })

  it('reports every audio track found, including one with no language tag', async () => {
    const service = createTranscodeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) })

    const result = await withFakeFfmpegMode('probe_multi_audio', () => service.probeTracks('irrelevant-source'))

    expect(result.audioTracks).toEqual([
      { index: 0, language: null, codec: 'aac', channelLayout: 'stereo' },
      { index: 1, language: null, codec: 'eac3', channelLayout: 'stereo' },
      { index: 2, language: null, codec: 'eac3', channelLayout: '5.1(side)' }
    ])
    expect(result.subtitleTracks).toEqual([])
  })

  it('reports a single audio track and no subtitles for an ordinary single-rendition source', async () => {
    const service = createTranscodeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) })

    const result = await withFakeFfmpegMode('probe_single_audio_no_subtitles', () =>
      service.probeTracks('irrelevant-source')
    )

    expect(result.audioTracks).toEqual([{ index: 0, language: null, codec: 'aac', channelLayout: 'stereo' }])
    expect(result.subtitleTracks).toEqual([])
  })

  it('reports both audio and subtitle tracks, each with correct language tags', async () => {
    const service = createTranscodeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) })

    const result = await withFakeFfmpegMode('probe_audio_and_subtitle', () => service.probeTracks('irrelevant-source'))

    expect(result.audioTracks).toEqual([
      { index: 0, language: 'eng', codec: 'aac', channelLayout: 'stereo' },
      { index: 1, language: 'fre', codec: 'aac', channelLayout: 'stereo' }
    ])
    expect(result.subtitleTracks).toEqual([{ index: 0, language: 'eng', supported: false }])
  })

  it('resolves with empty results (does not reject) when ffmpeg exits with nothing usable logged', async () => {
    const service = createTranscodeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) })

    const result = await withFakeFfmpegMode('fail_immediately', () => service.probeTracks('irrelevant-source'))

    expect(result).toEqual({ audioTracks: [], subtitleTracks: [] })
  })

  it('resolves with whatever was found so far once probeTimeoutMs elapses, for a hanging source', async () => {
    const service = createTranscodeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), probeTimeoutMs: 300 })

    const result = await withFakeFfmpegMode('hang_forever', () => service.probeTracks('irrelevant-source'))

    expect(result).toEqual({ audioTracks: [], subtitleTracks: [] })
  })
})

// The one integration test here: confirms this all genuinely works against the real bundled
// ffmpeg-static binary and a real (synthetic, network-free) input, not just the fake-ffmpeg
// fixture's hand-shaped behavior above — mirroring how this project has verified real ffmpeg
// muxer behavior elsewhere (e.g. the 0.7.10 subtitle investigation) rather than assuming it.
describe('real ffmpeg integration', () => {
  // Drip-feeds the file instead of piping it straight through. Confirmed the hard way: an
  // un-throttled local server lets a small `-c:v copy` remux finish — segments, playlist, and
  // process exit — in well under one poll interval, which raced against startTranscode's own
  // proc.on('exit', ...) handler (it deletes the whole temp dir on *every* exit, success
  // included) deleting the just-written playlist before the poll loop's existsSync ever ran.
  // That race is real but practically unreachable in production — an actual movie/episode
  // takes far longer than one poll interval to fully read+remux regardless of copy-mode
  // speed — so this throttles the fixture to be realistic instead of changing production
  // code to work around an artifact of an unrealistically tiny, instantly-served test input.
  async function startSyntheticOrigin(inputPath: string): Promise<{ url: string; server: Server }> {
    const fileData = readFileSync(inputPath)
    const CHUNK_SIZE = 32 * 1024
    const CHUNK_DELAY_MS = 100
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void req
      res.writeHead(200, { 'content-type': 'video/x-matroska' })
      let offset = 0
      const sendNextChunk = (): void => {
        if (offset >= fileData.byteLength) {
          res.end()
          return
        }
        res.write(fileData.subarray(offset, offset + CHUNK_SIZE))
        offset += CHUNK_SIZE
        setTimeout(sendNextChunk, CHUNK_DELAY_MS)
      }
      sendNextChunk()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return { url: `http://127.0.0.1:${port}/input.mkv`, server }
  }

  it('produces a genuinely playable HLS playlist from a real synthetic AC-3 input', async () => {
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static did not resolve a binary for this platform')

    // Build a synthetic input with the exact codec shape this fallback exists for (AC-3 audio
    // hls.js/native <video> can't handle) — network-free, written to a real temp dir (not this
    // source tree) since it's regenerated fresh on every run. -g 10 forces a keyframe every 10
    // frames (1s at this 10fps source) so the 12s clip spans multiple real segments once
    // remuxed — the real transcode uses -c:v copy, which can only cut a segment at an existing
    // keyframe, never re-encode one in, and libx264's own default keyframe interval (~25s at
    // this framerate) would otherwise make the whole clip a single segment — unlike any real
    // movie/episode this fallback actually runs against in production, which always has
    // frequent keyframes and is far longer than one HLS segment.
    const fixtureDir = mkdtempSync(join(tmpdir(), 'allisoniptv-test-fixture-'))
    const inputPath = join(fixtureDir, 'synthetic-ac3-input.mkv')
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegStaticPath as string, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=12:size=320x240:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=12',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '10',
        '-keyint_min',
        '10',
        '-c:a',
        'ac3',
        inputPath
      ])
      proc.on('error', reject)
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture build exited ${code}`))))
    })

    const { url: originUrl, server } = await startSyntheticOrigin(inputPath)
    try {
      const service = track(
        createTranscodeService({
          resolveFfmpegPath: resolverFor(ffmpegStaticPath as string),
          vodDeadlineMs: 30000,
          pollIntervalMs: 200
        })
      )

      const result = await service.startTranscode(originUrl, true, 'real-1')

      expect(readFileSync(result.playlistPath, 'utf8')).toContain('#EXTM3U')
      const dir = join(result.playlistPath, '..')
      const segment = readFileSync(join(dir, 'seg_00000.ts'))
      expect(segment.byteLength).toBeGreaterThan(0)

      await service.stopTranscode('real-1')
    } finally {
      server.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 20000)

  // The subtitle-mapping change this covers was added after a real, if less severe, prior
  // failure in this exact fallback (a deferred-write bug caused by a different ffmpeg command
  // shape — see ROADMAP.md) — so this validates the actual muxer behavior against the real
  // bundled binary rather than trusting the fake-ffmpeg fixture's hand-shaped stderr line alone.
  it('produces a master playlist with a working subtitle rendition from a real input that has one', async () => {
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static did not resolve a binary for this platform')

    const fixtureDir = mkdtempSync(join(tmpdir(), 'allisoniptv-test-fixture-'))
    const srtPath = join(fixtureDir, 'subs.srt')
    // Several short cues spread across the clip, not one long one — confirmed the hard way
    // (an isolated, non-live, real-time-paced `-re` ffmpeg run, no test-suite race involved):
    // a single cue spanning nearly the whole clip stalls ffmpeg's webvtt HLS segmenter, which
    // reproduces the exact deferred-playlist-write bug this whole feature exists to avoid —
    // not because subtitles-in-general trigger it, but because that shape isn't how a real
    // movie's subtitle track looks (a line every few seconds, same as this fixture now has).
    const pad = (n: number): string => String(n).padStart(2, '0')
    writeFileSync(
      srtPath,
      Array.from(
        { length: 6 },
        (_, i) => `${i + 1}\n00:00:${pad(i * 2)},000 --> 00:00:${pad(i * 2 + 2)},000\nLine ${i + 1}\n`
      ).join('\n')
    )
    const inputPath = join(fixtureDir, 'synthetic-subtitled-input.mkv')
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegStaticPath as string, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=12:size=320x240:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=12',
        '-i',
        srtPath,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '10',
        '-keyint_min',
        '10',
        '-c:a',
        'ac3',
        '-c:s',
        'srt',
        inputPath
      ])
      proc.on('error', reject)
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture build exited ${code}`))))
    })

    const { url: originUrl, server } = await startSyntheticOrigin(inputPath)
    try {
      const service = track(
        createTranscodeService({
          resolveFfmpegPath: resolverFor(ffmpegStaticPath as string),
          vodDeadlineMs: 30000,
          pollIntervalMs: 200,
          subtitleGraceMs: 15000
        })
      )

      const result = await service.startTranscode(originUrl, true, 'real-2')

      expect(result.playlistPath.endsWith('master.m3u8')).toBe(true)
      const master = readFileSync(result.playlistPath, 'utf8')
      expect(master).toContain('TYPE=SUBTITLES')
      expect(master).toContain('URI="playlist_vtt.m3u8"')
      const dir = join(result.playlistPath, '..')
      expect(readFileSync(join(dir, 'playlist.m3u8'), 'utf8')).toContain('#EXTM3U')
      const vtt = readFileSync(join(dir, 'playlist_vtt.m3u8'), 'utf8')
      expect(vtt).toContain('#EXTM3U')

      await service.stopTranscode('real-2')
    } finally {
      server.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 30000)

  // Confirms subtitleStreamIndex genuinely selects a *specific* track from a source with more
  // than one, not just "a" subtitle track — by checking the actual cue text that comes through,
  // not just that some master playlist got built. This is the strongest possible check that the
  // requested index threads correctly into the real `-map 0:s:N?` argv against genuine ffmpeg.
  it('selects the requested language track, not just the first one, from a real multi-subtitle input', async () => {
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static did not resolve a binary for this platform')

    const fixtureDir = mkdtempSync(join(tmpdir(), 'allisoniptv-test-fixture-'))
    const pad = (n: number): string => String(n).padStart(2, '0')
    const buildSrt = (lines: string[]): string =>
      lines.map((text, i) => `${i + 1}\n00:00:${pad(i * 2)},000 --> 00:00:${pad(i * 2 + 2)},000\n${text}\n`).join('\n')
    const engSrtPath = join(fixtureDir, 'eng.srt')
    const freSrtPath = join(fixtureDir, 'fre.srt')
    writeFileSync(engSrtPath, buildSrt(['Hello', 'World', 'Line three', 'Line four', 'Line five', 'Line six']))
    writeFileSync(freSrtPath, buildSrt(['Bonjour', 'Monde', 'Ligne trois', 'Ligne quatre', 'Ligne cinq', 'Ligne six']))
    const inputPath = join(fixtureDir, 'synthetic-multi-subtitle-input.mkv')
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegStaticPath as string, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=12:size=320x240:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=12',
        '-i',
        engSrtPath,
        '-i',
        freSrtPath,
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-map',
        '2:s',
        '-map',
        '3:s',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '10',
        '-keyint_min',
        '10',
        '-c:a',
        'ac3',
        '-c:s',
        'srt',
        '-metadata:s:s:0',
        'language=eng',
        '-metadata:s:s:1',
        'language=fre',
        inputPath
      ])
      proc.on('error', reject)
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture build exited ${code}`))))
    })

    const { url: originUrl, server } = await startSyntheticOrigin(inputPath)
    try {
      const service = track(
        createTranscodeService({
          resolveFfmpegPath: resolverFor(ffmpegStaticPath as string),
          vodDeadlineMs: 30000,
          pollIntervalMs: 200,
          subtitleGraceMs: 15000
        })
      )

      // Index 1 == the second subtitle stream == French, in source order.
      const result = await service.startTranscode(originUrl, true, 'real-3', 1)

      expect(result.subtitleTracks).toEqual([
        { index: 0, language: 'eng', supported: true },
        { index: 1, language: 'fre', supported: true }
      ])
      expect(result.playlistPath.endsWith('master.m3u8')).toBe(true)
      const dir = join(result.playlistPath, '..')
      const cueFiles = readdirSync(dir).filter((f) => f.endsWith('.vtt') && f !== 'playlist_vtt.m3u8')
      const cueText = cueFiles.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
      expect(cueText).toContain('Bonjour')
      expect(cueText).not.toContain('Hello')

      await service.stopTranscode('real-3')
    } finally {
      server.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 30000)

  // Runs a real ffmpeg pass over one already-produced HLS segment and reports its mean volume
  // (via libavfilter's own volumedetect, not a custom analysis) — the simplest reliable way to
  // tell "which of two audio tracks actually made it into the output" apart without needing real
  // frequency-domain analysis: one track is genuine digital silence, the other a full-scale
  // tone, so the two read as unmistakably different (silence: ~-91dB/"-inf"; tone: well above
  // -20dB) regardless of any resampling/AAC-encoding artifacts from the transcode itself.
  async function measureMeanVolumeDb(segmentPath: string): Promise<number> {
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static did not resolve a binary for this platform')
    return new Promise((resolve, reject) => {
      let stderr = ''
      const proc = spawn(ffmpegStaticPath as string, ['-i', segmentPath, '-af', 'volumedetect', '-f', 'null', '-'])
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      proc.on('error', reject)
      // 'close', not 'exit' — a real CI failure (Linux, a different ffmpeg-static build than
      // this was developed against on macOS) showed stderr truncated to just the startup
      // banner at the moment this fired, missing the volumedetect summary entirely: 'exit'
      // only means the process terminated, not that stdio has finished draining. 'close' is
      // the event Node guarantees fires only once every stdio stream has actually ended.
      proc.on('close', () => {
        const match = /mean_volume:\s*(-inf|-?[\d.]+)\s*dB/.exec(stderr)
        if (!match) {
          reject(new Error(`volumedetect produced no mean_volume line:\n${stderr}`))
          return
        }
        resolve(match[1] === '-inf' ? -Infinity : Number(match[1]))
      })
    })
  }

  // Confirms audioStreamIndex genuinely selects a *specific* audio track from a source with more
  // than one — the real gap this exists for (see AUDIO_STREAM_PATTERN's own comment): a live
  // channel's raw multiplex can carry extra audio tracks its HLS playlist never advertises, so
  // hls.js can never switch to one on its own. Uses the live (isVod: false) code path, since
  // that's this feature's actual target — Live TV, not VOD/series.
  it('selects the requested audio track, not just the first one, from a real multi-audio-track input', async () => {
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static did not resolve a binary for this platform')

    const fixtureDir = mkdtempSync(join(tmpdir(), 'allisoniptv-test-fixture-'))
    const inputPath = join(fixtureDir, 'synthetic-multi-audio-input.mkv')
    // Track 0: genuine digital silence. Track 1: a full-scale 440Hz tone. Distinguishing by
    // silence-vs-tone (rather than two different tone frequencies) sidesteps any need for real
    // frequency-domain analysis of the transcoded output — silence and a loud tone read as
    // unmistakably different mean volume regardless of resampling/AAC re-encoding.
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegStaticPath as string, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=6:size=320x240:rate=10',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=stereo:d=6',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=6',
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-map',
        '2:a',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '10',
        '-keyint_min',
        '10',
        '-c:a',
        'aac',
        inputPath
      ])
      proc.on('error', reject)
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture build exited ${code}`))))
    })

    const { url: originUrl, server } = await startSyntheticOrigin(inputPath)
    try {
      const service = track(
        createTranscodeService({
          resolveFfmpegPath: resolverFor(ffmpegStaticPath as string),
          liveDeadlineMs: 30000,
          pollIntervalMs: 200
        })
      )

      // Default audioStreamIndex (0) — should carry through the silent track.
      const defaultResult = await service.startTranscode(originUrl, false, 'real-audio-default')
      const defaultDir = join(defaultResult.playlistPath, '..')
      const defaultSegment = readdirSync(defaultDir).find((f) => f.endsWith('.ts'))
      if (!defaultSegment) throw new Error('no .ts segment was produced')
      const defaultVolume = await measureMeanVolumeDb(join(defaultDir, defaultSegment))
      await service.stopTranscode('real-audio-default')

      // audioStreamIndex: 1 — the second audio stream — should carry through the audible tone.
      const chosenResult = await service.startTranscode(originUrl, false, 'real-audio-1', 0, 1)
      const chosenDir = join(chosenResult.playlistPath, '..')
      const chosenSegment = readdirSync(chosenDir).find((f) => f.endsWith('.ts'))
      if (!chosenSegment) throw new Error('no .ts segment was produced')
      const chosenVolume = await measureMeanVolumeDb(join(chosenDir, chosenSegment))
      await service.stopTranscode('real-audio-1')

      expect(defaultVolume).toBeLessThan(-70)
      expect(chosenVolume).toBeGreaterThan(-45)
    } finally {
      server.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 30000)
})
