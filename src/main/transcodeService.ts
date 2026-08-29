import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, extname } from 'path'
import type { ServerResponse } from 'http'

// Matches ffmpeg's own "Input #0 ... Stream #0:N: Subtitle: ..." line, printed once it's opened
// and probed the source container — the same point that already costs 25-90s on this app's
// single-connection test account (see startTranscode's deadline comment below). Detecting
// subtitle presence from output ffmpeg produces anyway, instead of a separate up-front probe,
// is what makes this free: no second connection, no risk of doubling that wait for the (likely
// more common) case of a title with no subtitle track at all.
const SUBTITLE_STREAM_PATTERN = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([a-zA-Z-]+\))?: Subtitle:/

/**
 * Some providers' live channels carry EC-3/E-AC-3 (Dolby Digital Plus) audio inside their
 * MPEG-TS segments, which hls.js's built-in demuxer cannot parse at all — every fragment
 * fails identically, forever (see Player.tsx's MEDIA_ERROR handling). The only real fix is
 * remuxing the audio to AAC before hls.js ever sees it. This spawns ffmpeg per affected
 * channel on demand (not for every stream — most don't need it) reading from this app's own
 * local proxy (already TLS-solved and CORS-free) and writes a fresh local HLS output that the
 * player falls back to.
 *
 * No Electron dependency here (only child_process/fs/path, all real — see the deps interface
 * for the one thing that IS injected) so this can be unit- and integration-tested directly
 * rather than folded untestably into index.ts, the way proxyServer.ts and ffmpegResolver.ts
 * already were.
 */
export interface TranscodeSession {
  proc: ChildProcessWithoutNullStreams
  dir: string
  stderrTail: string[]
  subtitleDetected: boolean
}

export interface TranscodeServiceDeps {
  resolveFfmpegPath: () => Promise<string | null>
  // All five below have real production defaults (see createTranscodeService) — overridable
  // purely so tests don't have to wait out a real 20s/240s/2s/5s deadline to exercise them.
  liveDeadlineMs?: number
  vodDeadlineMs?: number
  pollIntervalMs?: number
  stopGraceMs?: number
  subtitleGraceMs?: number
}

export interface TranscodeService {
  startTranscode(
    sourceUrl: string,
    isVod: boolean,
    sessionId: string
  ): Promise<{ sessionId: string; playlistPath: string }>
  stopTranscode(sessionId: string): Promise<void>
  serveTranscodeFile(url: string, res: ServerResponse): Promise<void>
  // Fire-and-forget by design, matching the one real caller (app 'before-quit'): every active
  // session gets a stopTranscode() kicked off, but quitting doesn't wait on any of them.
  stopAll(): void
}

const TRANSCODE_MIME_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  // ffmpeg's webvtt HLS muxer writes per-segment subtitle cue files (playlistN.vtt) referenced
  // from playlist_vtt.m3u8 — missing this entry 404s every one of them, which a live test
  // against a real subtitle-carrying title showed cascades into hls.js abandoning the whole
  // session (fragLoadError, gave up after retries) rather than just playing without captions.
  '.vtt': 'text/vtt'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createTranscodeService(deps: TranscodeServiceDeps): TranscodeService {
  const liveDeadlineMs = deps.liveDeadlineMs ?? 20000
  const vodDeadlineMs = deps.vodDeadlineMs ?? 240000
  const pollIntervalMs = deps.pollIntervalMs ?? 300
  const stopGraceMs = deps.stopGraceMs ?? 2000
  const subtitleGraceMs = deps.subtitleGraceMs ?? 5000

  const transcodeSessions = new Map<string, TranscodeSession>()

  // The renderer picks a sessionId up front and can call stop() on it well before startTranscode
  // below has actually spawned ffmpeg and registered it in transcodeSessions — e.g. switching to a
  // different title while the previous one's transcode attempt is still in flight, before it has
  // ever produced output. Without tracking that, stopTranscode would find nothing to do, and the
  // spawn already in progress would carry on regardless — leaving an orphaned ffmpeg process
  // competing for this account's single connection slot with whatever plays next. Recording the
  // cancellation here lets startTranscode notice it and kill the process it just spawned instead.
  const cancelledSessions = new Set<string>()

  async function stopTranscode(sessionId: string): Promise<void> {
    cancelledSessions.add(sessionId)
    const session = transcodeSessions.get(sessionId)
    if (!session) return
    transcodeSessions.delete(sessionId)

    if (session.proc.exitCode === null) {
      session.proc.kill('SIGTERM')
      // Give ffmpeg a moment to actually stop writing before removing its directory — its own
      // 'exit' handler also cleans up, but only once the process has genuinely terminated;
      // this covers the case where something else (e.g. app quit) needs the directory gone now.
      await Promise.race([new Promise<void>((resolve) => session.proc.once('exit', () => resolve())), sleep(stopGraceMs)])
      if (session.proc.exitCode === null) session.proc.kill('SIGKILL')
    }
    await rm(session.dir, { recursive: true, force: true }).catch(() => {})
  }

  async function startTranscode(
    sourceUrl: string,
    isVod: boolean,
    sessionId: string
  ): Promise<{ sessionId: string; playlistPath: string }> {
    const ffmpegPath = await deps.resolveFfmpegPath()
    if (!ffmpegPath) {
      throw new Error('ffmpeg binary not available on this platform')
    }
    // A stop() for this exact sessionId could already have arrived (the renderer switched away
    // before this call even started) — nothing to spawn in that case.
    if (cancelledSessions.has(sessionId)) {
      cancelledSessions.delete(sessionId)
      throw new Error('Transcode cancelled')
    }
    const dir = await mkdtemp(join(tmpdir(), 'allisoniptv-transcode-'))
    const playlistFile = join(dir, 'playlist.m3u8')

    const proc = spawn(ffmpegPath, [
      '-y',
      '-i',
      sourceUrl,
      // Movies/series routinely carry an embedded subtitle track alongside the audio this fix
      // targets. An early version of this fallback left it unmapped, on the theory that ffmpeg
      // auto-selecting it made the HLS muxer treat it as a second WebVTT rendition, which
      // deferred writing the main playlist.m3u8 until the *entire* input had been processed
      // (confirmed live: a 76-minute movie fully transcoded at 19x realtime, writing hundreds of
      // segments the whole time, yet playlist.m3u8 itself never appeared until the process was
      // killed at the very end). Investigated further (see ROADMAP.md): that deferred-write
      // behavior turns out to be specific to `-var_stream_map`-driven master-playlist generation,
      // not to mapping a subtitle stream at all — a flat output (this one) with `0:s:0?`'s
      // optional-map syntax writes both the video/audio playlist AND the subtitle rendition
      // incrementally, and is a no-op (nothing mapped, no extra rendition, no behavior change
      // from before) when the source has no subtitle track. VOD/series opt in below; Live TV
      // still excludes subtitles entirely — its segment window constantly evicts old segments,
      // a shape this hasn't been tested against, and the timing/latency concerns that already
      // motivate keeping Live TV's fallback minimal apply here too.
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      ...(isVod ? ['-map', '0:s:0?'] : []),
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ac',
      '2',
      ...(isVod ? ['-c:s', 'webvtt'] : []),
      '-f',
      'hls',
      '-hls_time',
      '4',
      // Live's list is deliberately a short, ever-deleting window (there's no fixed end to keep
      // segments for). VOD is the opposite: a movie/episode has a real duration, and the whole
      // point is being able to scrub anywhere in it, so every segment has to stick around. This
      // is *not* `-hls_playlist_type vod`, despite the name fitting — confirmed directly (an
      // isolated, network-free ffmpeg run, checked mid-encode): `vod` writes nothing to disk at
      // all until the source hits EOF, per the HLS spec's own definition of a VOD playlist as
      // "published complete and unchanging." That's exactly backwards for a still-in-progress
      // remux — every earlier "timeout waiting for ffmpeg" in this feature's development was
      // actually this, not a network or subtitle problem, and would recur for any file whose
      // full runtime exceeds startTranscode's deadline. `event` is the type actually meant for
      // this shape (segments keep appending until the source ends), and does write the playlist
      // incrementally, confirmed by ffmpeg's own log showing repeated
      // "Opening playlist.m3u8.tmp for writing" during encode rather than only at exit — hls.js
      // (which is what actually plays this, once transcoded — see getSourceUrl/isM3u8 in
      // Player.tsx) already knows to keep reloading an EVENT playlist until it sees
      // #EXT-X-ENDLIST, so this is a drop-in behavior change, not a player-side one.
      ...(isVod
        ? ['-hls_list_size', '0', '-hls_playlist_type', 'event']
        : ['-hls_list_size', '6', '-hls_flags', 'delete_segments+omit_endlist']),
      '-hls_segment_filename',
      join(dir, 'seg_%05d.ts'),
      playlistFile
    ])

    // mkdtemp and spawn() both involve a real async/OS gap after the check above — a stop() can
    // still have landed in between. Checking again right before registering the session (rather
    // than relying on the polling loop alone) keeps a cancelled request from ever occupying the
    // account's connection slot at all, instead of just getting killed a beat later.
    if (cancelledSessions.has(sessionId)) {
      cancelledSessions.delete(sessionId)
      proc.kill('SIGKILL')
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw new Error('Transcode cancelled')
    }
    const session: TranscodeSession = { proc, dir, stderrTail: [], subtitleDetected: false }
    transcodeSessions.set(sessionId, session)

    // A stall-detection scheme keyed on "time since ffmpeg last wrote to stderr" was tried here
    // and had to be abandoned: ffmpeg's stderr is a pipe, not a tty, and glibc/libSystem's stdio
    // buffers pipes fully rather than line-by-line — so long, apparently silent stretches
    // (confirmed live, repeatedly, against a real account: 60-120+ seconds with zero stderr
    // output) don't reliably mean ffmpeg is stuck. Several of those "stalls" turned out to have
    // already opened the input and started encoding; the silence was just unflushed buffer, and
    // killing on it destroyed transcodes that were actually about to succeed. A single generous
    // deadline (below) doesn't have that false-positive problem.
    proc.stderr.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean)
      // Keep only a rolling tail — ffmpeg is chatty, but the last few lines are what actually
      // explain a failure to start (bad input, unsupported option, etc).
      session.stderrTail.push(...lines)
      if (session.stderrTail.length > 40) session.stderrTail.splice(0, session.stderrTail.length - 40)
      // ffmpeg prints the source's full stream list right after opening/probing it — the same
      // point that already costs 25-90s on this account (see the deadline comment below) — well
      // before it writes a single output segment. Catching it here means startTranscode knows
      // whether a subtitle rendition is coming before playlist.m3u8 even exists, with no separate
      // probe and no second connection.
      if (!session.subtitleDetected && lines.some((line) => SUBTITLE_STREAM_PATTERN.test(line))) {
        session.subtitleDetected = true
      }
    })
    proc.on('error', (err) => {
      console.error('[transcode] failed to spawn ffmpeg:', err.message)
    })
    proc.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`[transcode] ffmpeg exited with code ${code}:`, session.stderrTail.join('\n'))
      }
      transcodeSessions.delete(sessionId)
      rm(dir, { recursive: true, force: true }).catch(() => {})
      void signal
    })

    // ffmpeg only writes the playlist once it's produced enough of the first segment, so poll for
    // it rather than assuming it exists immediately — and give up if the process has already
    // died, rather than polling for the full timeout on a lost cause. VOD gets a much longer
    // budget than live: confirmed live against a real account, just opening the input (probing
    // the container, before ffmpeg writes a single frame) took anywhere from ~25s to ~90s across
    // otherwise-identical attempts against the same file, and actual encode throughput — once it
    // does get going — was fast (19x realtime, -c:v copy isn't CPU-bound). The bottleneck is
    // entirely how long this account's connection takes to start delivering data, which varies
    // enough attempt-to-attempt that the deadline needs real headroom rather than being tuned to
    // the common case.
    const subtitlePlaylistFile = join(dir, 'playlist_vtt.m3u8')
    const masterPlaylistFile = join(dir, 'master.m3u8')
    // Set the moment the video/audio playlist exists — from then on, if a subtitle rendition
    // was also detected, this bounds how much *extra* time to give just that before giving up
    // on it and serving video alone. Never lets a broken/slow subtitle rendition hold up or
    // fail a video that's otherwise already playable.
    let videoReadyAt: number | null = null
    const deadline = Date.now() + (isVod ? vodDeadlineMs : liveDeadlineMs)
    while (Date.now() < deadline) {
      if (cancelledSessions.has(sessionId)) {
        cancelledSessions.delete(sessionId)
        await stopTranscode(sessionId)
        throw new Error('Transcode cancelled')
      }
      if (videoReadyAt === null && existsSync(playlistFile)) {
        // subtitleDetected reflects the *source's* stream list (ffmpeg logs it regardless of
        // what's actually mapped) — Live's argv never requests a subtitle stream at all, so it
        // must be checked here too, not just isVod's effect on argv above, or a Live source that
        // happens to carry embedded subtitles would wait out subtitleGraceMs for a rendition
        // that was never going to be produced.
        if (!isVod || !session.subtitleDetected) return { sessionId, playlistPath: playlistFile }
        videoReadyAt = Date.now()
      }
      if (videoReadyAt !== null) {
        if (existsSync(subtitlePlaylistFile)) {
          // No `-var_stream_map` involved (see the argv comment above for why: it hard-fails
          // outright when the source turns out to have no subtitle stream, even with `?`'s
          // optional-map syntax), so ffmpeg itself never writes a master playlist tying the two
          // renditions together — nothing in the flat playlist.m3u8 it does write references the
          // sidecar file at all. This one, written directly rather than by ffmpeg, is what makes
          // the subtitle rendition discoverable.
          await writeFile(
            masterPlaylistFile,
            [
              '#EXTM3U',
              '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Subtitles",DEFAULT=YES,AUTOSELECT=YES,URI="playlist_vtt.m3u8"',
              '#EXT-X-STREAM-INF:BANDWIDTH=5000000,SUBTITLES="subs"',
              'playlist.m3u8',
              ''
            ].join('\n'),
            'utf8'
          )
          return { sessionId, playlistPath: masterPlaylistFile }
        }
        if (Date.now() - videoReadyAt > subtitleGraceMs) return { sessionId, playlistPath: playlistFile }
      }
      if (proc.exitCode !== null) {
        // ffmpeg can legitimately exit clean (code 0, e.g. a very short clip) after writing the
        // video/audio playlist but before the subtitle rendition catches up — that's still a
        // successful transcode, just one that isn't getting subtitles, not a failure.
        if (videoReadyAt !== null) return { sessionId, playlistPath: playlistFile }
        throw new Error(`ffmpeg exited before producing output: ${session.stderrTail.slice(-10).join('\n')}`)
      }
      await sleep(pollIntervalMs)
    }
    if (videoReadyAt !== null) return { sessionId, playlistPath: playlistFile }
    await stopTranscode(sessionId)
    throw new Error('Timed out waiting for ffmpeg to produce transcoded output')
  }

  async function serveTranscodeFile(url: string, res: ServerResponse): Promise<void> {
    const match = /^\/__transcode\/([^/]+)\/([^/]+)$/.exec(url)
    const session = match ? transcodeSessions.get(match[1]) : undefined
    const filename = match?.[2]
    const mime = filename ? TRANSCODE_MIME_TYPES[extname(filename)] : undefined
    if (!session || !filename || !mime) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    try {
      const data = await readFile(join(session.dir, filename))
      res.writeHead(200, {
        'content-type': mime,
        'access-control-allow-origin': '*',
        'cache-control': 'no-cache'
      })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('Segment not available')
    }
  }

  function stopAll(): void {
    for (const sessionId of transcodeSessions.keys()) {
      void stopTranscode(sessionId)
    }
  }

  return { startTranscode, stopTranscode, serveTranscodeFile, stopAll }
}
