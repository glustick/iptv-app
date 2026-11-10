import { spawn, type ChildProcess } from 'child_process'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { createReadStream } from 'fs'
import { randomUUID } from 'crypto'
import { join, resolve as resolvePath, extname } from 'path'
import type { ServerResponse } from 'http'

/**
 * Records live TV to disk (0.29.0). One ffmpeg process per recording reads the channel's own
 * stream URL and writes an HLS "event" playlist (segments retained, never evicted) under
 * <recordingsDir>/<id>/index.m3u8, so a recording can be watched while it is still being made
 * and played back afterwards from the same files. Modelled on transcodeService.ts — no Electron
 * import, every OS-touching dependency injectable — so it is unit-testable against the same
 * fake-ffmpeg fixture pattern (see recordingService.test.ts).
 *
 * Video is a plain stream copy (`-c:v copy`) with NO hvc1 tagging: unlike the live remux, whose
 * fragmented-MP4 output needs the tag for Chromium's MSE to accept HEVC, this writes ordinary
 * MPEG-TS HLS segments, and which tag is right depends on the source codec in a way that would
 * need transcodeService's whole kill-and-respawn probing loop to answer. H.264-in-TS (this
 * provider's common case) is universally playable; an HEVC recording is playable wherever
 * HEVC-in-TS works (native <video>, VLC, ffmpeg) even where Chromium's MSE refuses it. Noted as
 * a caveat in ROADMAP 0.29.0.
 */

export type RecordingStatus = 'scheduled' | 'recording' | 'done' | 'partial' | 'failed'

export interface RecordingEntry {
  id: string
  channelKey: string
  channelName: string
  programmeTitle?: string
  startedAt: number
  endedAt?: number
  status: RecordingStatus
  bytes?: number
  dir: string
}

export interface RecordingsIndex {
  version: 1
  entries: RecordingEntry[]
}

export interface RecordingStartOptions {
  id?: string
  channelKey: string
  channelName: string
  programmeTitle?: string
  sourceUrl: string
  // Epoch ms — when set (a scheduled recording), ffmpeg is stopped automatically at this time.
  scheduledEnd?: number
}

export interface RecordingScheduleOptions {
  programmeTitle: string
  channelKey: string
  channelName: string
  sourceUrl: string
  startAt: number
  endAt: number
  prerollSeconds?: number
  postrollSeconds?: number
}

// ffmpeg's HLS "event" playlist type keeps appending segments (and never evicts them with
// hls_list_size 0) but does NOT write #EXT-X-ENDLIST on a SIGTERM death — the playlist just
// stops growing, and hls.js keeps polling it forever thinking the live edge has merely stalled.
// Appending the tag ourselves once the process is fully dead is what turns the frozen playlist
// into a finished, honestly-terminated one.
const RECORDING_MIME_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t'
}

/**
 * Parses a single-range `Range: bytes=...` header against a resource of `size` bytes.
 * Returns null when the header is absent (serve the whole file), 'invalid' for a syntactically
 * unusable or fully out-of-bounds range (416), or the resolved inclusive byte bounds. Pure, so
 * the one piece of HTTP math this feature does is unit-testable directly.
 */
export function parseRangeHeader(
  size: number,
  rangeHeader: string | undefined
): { start: number; end: number } | null | 'invalid' {
  if (rangeHeader === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (match[1] === '') {
    // Suffix range: last N bytes
    const suffix = Number(match[2])
    if (suffix === 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Number(match[2])
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return 'invalid'
  }
  return { start, end: Math.min(end, size - 1) }
}

interface ActiveRecording {
  entry: RecordingEntry
  proc: ChildProcess
  exited: boolean
  stoppedByUs: boolean
  // True while the unexpected-exit handler is on its one allowed restart attempt — the second
  // exit through that path finalises as 'partial' instead of looping forever.
  restartedOnce: boolean
  endTimer?: ReturnType<typeof setTimeout>
  // Resolves when the process has genuinely terminated (the exit event), for stop()'s grace wait.
  exitWaiters: Array<() => void>
}

export interface RecordingServiceDeps {
  recordingsDir: string
  resolveFfmpegPath: () => Promise<string | null>
  spawnFn?: typeof spawn
  mkdir?: typeof mkdir
  readFile?: typeof readFile
  writeFile?: typeof writeFile
  rename?: typeof rename
  stat?: typeof stat
  readdir?: typeof readdir
  trashItem?: (path: string) => Promise<void>
  showItemInFolder?: (path: string) => void
  createReadStream?: typeof createReadStream
  now?: () => number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  newId?: () => string
  log?: (message: string) => void
  // Overridable purely so tests don't have to wait out real graces.
  stopGraceMs?: number
}

export interface RecordingService {
  start(options: RecordingStartOptions): Promise<RecordingEntry>
  stop(id: string): Promise<void>
  schedule(options: RecordingScheduleOptions): Promise<RecordingEntry>
  cancelScheduled(id: string): Promise<void>
  list(): Promise<RecordingEntry[]>
  remove(id: string): Promise<void>
  reveal(id: string): Promise<void>
  serveRecordingFile(url: string, rangeHeader: string | undefined, res: ServerResponse): Promise<void>
  onChange(cb: (entries: RecordingEntry[]) => void): () => void
  // The recordings root is a renderer-side setting (null = default userData/recordings); this
  // swaps it at runtime. Refuses while anything is recording — moving an in-flight ffmpeg's
  // output directory underneath it is not a thing — and reloads the index from the new root.
  setRecordingsDir(dir: string): Promise<void>
  isRecording(): boolean
  stopAll(): Promise<void>
}

export function createRecordingService(deps: RecordingServiceDeps): RecordingService {
  const spawnFn = deps.spawnFn ?? spawn
  const doMkdir = deps.mkdir ?? mkdir
  const doReadFile = deps.readFile ?? readFile
  const doWriteFile = deps.writeFile ?? writeFile
  const doRename = deps.rename ?? rename
  const doStat = deps.stat ?? stat
  const doReaddir = deps.readdir ?? readdir
  const trash = deps.trashItem ?? (async () => {})
  const showItemInFolder = deps.showItemInFolder ?? (() => {})
  const openStream = deps.createReadStream ?? createReadStream
  const now = deps.now ?? (() => Date.now())
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout
  const newId = deps.newId ?? (() => randomUUID())
  const log = deps.log ?? (() => {})
  const stopGraceMs = deps.stopGraceMs ?? 3000

  // Mutable recordings root (see setRecordingsDir): every path derived below reads these, so
  // a settings change takes effect for future recordings without recreating the service.
  let recordingsRoot = deps.recordingsDir
  let indexFilePath = join(recordingsRoot, 'recordings.json')
  const active = new Map<string, ActiveRecording>()
  // Scheduled-not-yet-started entries: id → start timer (also the cancel handle).
  const scheduledTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const changeListeners = new Set<(entries: RecordingEntry[]) => void>()

  let indexCache: RecordingsIndex | null = null

  async function loadIndex(): Promise<RecordingsIndex> {
    if (indexCache) return indexCache
    try {
      const raw = await doReadFile(indexFilePath, 'utf8')
      const parsed = JSON.parse(raw) as RecordingsIndex
      if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
        indexCache = parsed
        return parsed
      }
    } catch {
      // Missing or corrupt — a fresh index it is.
    }
    indexCache = { version: 1, entries: [] }
    return indexCache
  }

  // Atomic (guideCache's pattern): write a sibling temp file, then rename over the real path, so
  // a quit or crash mid-write can never leave a half-written index behind.
  async function saveIndex(index: RecordingsIndex): Promise<void> {
    indexCache = index
    const tmpPath = `${indexFilePath}.${newId()}.tmp`
    try {
      await doWriteFile(tmpPath, JSON.stringify(index, null, 2), 'utf8')
      await doRename(tmpPath, indexFilePath)
    } catch (err) {
      log(`[recording] failed to write index: ${err instanceof Error ? err.message : String(err)}`)
    }
    for (const cb of changeListeners) cb(index.entries)
  }

  async function updateEntry(id: string, patch: Partial<RecordingEntry>): Promise<void> {
    const index = await loadIndex()
    const entry = index.entries.find((e) => e.id === id)
    if (!entry) return
    Object.assign(entry, patch)
    await saveIndex(index)
  }

  async function dirSize(dir: string): Promise<number | undefined> {
    try {
      const names = await doReaddir(dir)
      let total = 0
      for (const name of names) {
        const s = await doStat(join(dir, name)).catch(() => null)
        if (s?.isFile()) total += s.size
      }
      return total
    } catch {
      return undefined
    }
  }

  // ffmpeg's event playlist does not get #EXT-X-ENDLIST on SIGTERM (see RECORDING_MIME_TYPES'
  // block comment) — this closes the playlist honestly once the process is fully dead and all
  // its writes have flushed, so both hls.js and any external player see a finished file.
  async function appendEndlist(dir: string): Promise<void> {
    const playlist = join(dir, 'index.m3u8')
    try {
      const text = await doReadFile(playlist, 'utf8')
      if (text.includes('#EXT-X-ENDLIST')) return
      await doWriteFile(playlist, `${text.trimEnd()}\n#EXT-X-ENDLIST\n`, 'utf8')
    } catch {
      // No playlist at all (ffmpeg died before writing anything) — nothing to finalise.
    }
  }

  function armScheduledEnd(rec: ActiveRecording, scheduledEnd?: number): void {
    if (scheduledEnd === undefined) return
    const delay = Math.max(0, scheduledEnd - now())
    rec.endTimer = setTimeoutFn(() => {
      log(`[recording] ${rec.entry.id}: reached scheduled end — stopping`)
      void stop(rec.entry.id)
    }, delay)
  }

  async function finalize(rec: ActiveRecording, status: RecordingStatus): Promise<void> {
    if (rec.endTimer) clearTimeoutFn(rec.endTimer)
    await appendEndlist(rec.entry.dir)
    await updateEntry(rec.entry.id, {
      status,
      endedAt: now(),
      bytes: await dirSize(rec.entry.dir)
    })
  }

  async function start(options: RecordingStartOptions): Promise<RecordingEntry> {
    const ffmpegPath = await deps.resolveFfmpegPath()
    if (!ffmpegPath) throw new Error('ffmpeg binary not available on this platform')

    // One recording per channel at a time — the account is single-connection, and a second
    // recorder for the same channel would just fight the first for it.
    const existing = [...active.values()].find((r) => r.entry.channelKey === options.channelKey)
    if (existing && !existing.exited) {
      throw new Error(`Already recording ${options.channelName}`)
    }

    const id = options.id ?? newId()
    const dir = join(recordingsRoot, id)
    await doMkdir(dir, { recursive: true })

    const entry: RecordingEntry = {
      id,
      channelKey: options.channelKey,
      channelName: options.channelName,
      ...(options.programmeTitle ? { programmeTitle: options.programmeTitle } : {}),
      startedAt: now(),
      status: 'recording',
      dir
    }
    const scheduledEnd = options.scheduledEnd

    const index = await loadIndex()
    index.entries.unshift(entry)
    await saveIndex(index)

    const proc = spawnFfmpegWith(entry, options.sourceUrl, ffmpegPath)
    const rec: ActiveRecording = {
      entry,
      proc,
      exited: false,
      stoppedByUs: false,
      restartedOnce: false,
      exitWaiters: []
    }
    active.set(id, rec)
    log(`[recording] ${id} started (${options.channelName})`)
    attachExit(proc, rec, options.sourceUrl, ffmpegPath)

    armScheduledEnd(rec, scheduledEnd)
    return entry
  }

  // The single exit handler, shared by a recording's first process and its one restart. The
  // natural end of the stream (provider closed it, programme over) lands here too — ffmpeg
  // exits 0 having written the whole playlist, and the event muxer already wrote
  // #EXT-X-ENDLIST itself on a natural EOF, so appendEndlist is the no-op it looks like and the
  // status is honestly 'done'. An unexpected death gets one restart attempt (a transient
  // provider hiccup shouldn't lose the rest of the programme — same single-retry philosophy as
  // transcodeService); a second unexpected exit finalises as 'partial' with the playlist closed
  // where it stands.
  function attachExit(proc: ChildProcess, rec: ActiveRecording, sourceUrl: string, ffmpegPath: string): void {
    proc.on('exit', (code, signal) => {
      rec.exited = true
      for (const w of rec.exitWaiters.splice(0)) w()
      if (rec.stoppedByUs || code === 0) {
        active.delete(rec.entry.id)
        void finalize(rec, 'done')
        return
      }
      if (!rec.restartedOnce) {
        rec.restartedOnce = true
        log(`[recording] ${rec.entry.id}: ffmpeg exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'none'}) — restarting once`)
        const retry = spawnFfmpegWith(rec.entry, sourceUrl, ffmpegPath)
        rec.proc = retry
        rec.exited = false
        rec.stoppedByUs = false
        attachExit(retry, rec, sourceUrl, ffmpegPath)
        return
      }
      active.delete(rec.entry.id)
      log(`[recording] ${rec.entry.id}: ffmpeg died again after restart — finalising as partial`)
      void finalize(rec, 'partial')
    })
  }

  function spawnFfmpegWith(entry: RecordingEntry, sourceUrl: string, ffmpegPath: string): ChildProcess {
    return spawnFn(ffmpegPath, buildRecordingArgv(sourceUrl, join(entry.dir, 'index.m3u8')))
  }

  async function stop(id: string): Promise<void> {
    const rec = active.get(id) ?? [...active.values()].find((r) => r.entry.id === id)
    if (!rec) return
    rec.stoppedByUs = true
    if (rec.endTimer) clearTimeoutFn(rec.endTimer)
    if (!rec.exited) {
      rec.proc.kill('SIGTERM')
      await Promise.race([
        new Promise<void>((resolve) => {
          if (rec.exited) resolve()
          else rec.exitWaiters.push(resolve)
        }),
        new Promise<void>((resolve) => setTimeoutFn(resolve, stopGraceMs))
      ])
      if (!rec.exited) rec.proc.kill('SIGKILL')
    }
    active.delete(rec.entry.id)
    await finalize(rec, 'done')
    log(`[recording] ${rec.entry.id}: stopped by user — done`)
  }

  async function schedule(options: RecordingScheduleOptions): Promise<RecordingEntry> {
    const prerollMs = Math.max(0, (options.prerollSeconds ?? 60) * 1000)
    const postrollMs = Math.max(0, (options.postrollSeconds ?? 120) * 1000)
    const id = newId()
    const entry: RecordingEntry = {
      id,
      channelKey: options.channelKey,
      channelName: options.channelName,
      programmeTitle: options.programmeTitle,
      startedAt: options.startAt,
      status: 'scheduled',
      dir: join(recordingsRoot, id)
    }
    const index = await loadIndex()
    index.entries.unshift(entry)
    await saveIndex(index)

    // Main-process timer, so a scheduled recording fires with the window closed (the app itself
    // must be running — a quit app records nothing, noted in ROADMAP).
    const delay = Math.max(0, options.startAt - prerollMs - now())
    const timer = setTimeoutFn(() => {
      scheduledTimers.delete(id)
      void (async () => {
        try {
          await start({
            id,
            channelKey: options.channelKey,
            channelName: options.channelName,
            programmeTitle: options.programmeTitle,
            sourceUrl: options.sourceUrl,
            // postroll: keep rolling past the guide's own end time — live programmes routinely
            // overrun, and a recording cut at the exact listed end is the failure users notice.
            scheduledEnd: options.endAt + postrollMs
          })
        } catch (err) {
          log(`[recording] scheduled ${id} failed to start: ${err instanceof Error ? err.message : String(err)}`)
          await updateEntry(id, { status: 'failed', endedAt: now() })
        }
      })()
    }, delay)
    scheduledTimers.set(id, timer)
    log(`[recording] scheduled ${id} (${options.programmeTitle} on ${options.channelName})`)
    return entry
  }

  async function cancelScheduled(id: string): Promise<void> {
    const timer = scheduledTimers.get(id)
    if (timer) {
      clearTimeoutFn(timer)
      scheduledTimers.delete(id)
      await updateEntry(id, { status: 'failed', endedAt: now() })
    }
  }

  async function list(): Promise<RecordingEntry[]> {
    return (await loadIndex()).entries
  }

  async function remove(id: string): Promise<void> {
    const timer = scheduledTimers.get(id)
    if (timer) {
      clearTimeoutFn(timer)
      scheduledTimers.delete(id)
    }
    const rec = [...active.values()].find((r) => r.entry.id === id)
    if (rec) await stop(id)
    const index = await loadIndex()
    const entry = index.entries.find((e) => e.id === id)
    if (!entry) return
    index.entries = index.entries.filter((e) => e.id !== id)
    await saveIndex(index)
    await trash(entry.dir).catch((err) => {
      log(`[recording] failed to trash ${entry.dir}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  async function reveal(id: string): Promise<void> {
    const entry = (await loadIndex()).entries.find((e) => e.id === id)
    if (entry) showItemInFolder(join(entry.dir, 'index.m3u8'))
  }

  async function serveRecordingFile(
    url: string,
    rangeHeader: string | undefined,
    res: ServerResponse
  ): Promise<void> {
    const match = /^\/__recordings\/([^/]+)\/([^/]+)$/.exec(url)
    const id = match?.[1]
    const filename = match?.[2]
    const mime = filename ? RECORDING_MIME_TYPES[extname(filename)] : undefined
    if (!id || !filename || !mime) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    // Path-traversal guard: the requested file must resolve to inside recordingsDir itself —
    // a crafted id/file like "..%2F..%2Fsettings" must never read anything outside it.
    const root = resolvePath(recordingsRoot)
    const filePath = resolvePath(root, id, filename)
    if (filePath !== root && !filePath.startsWith(`${root}/`)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }
    let size: number
    try {
      size = (await doStat(filePath)).size
    } catch {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    const baseHeaders: Record<string, string> = {
      'content-type': mime,
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
      'accept-ranges': 'bytes'
    }
    const range = parseRangeHeader(size, rangeHeader)
    if (range === 'invalid') {
      res.writeHead(416, { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' })
      res.end()
      return
    }
    if (range) {
      res.writeHead(206, {
        ...baseHeaders,
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
        'content-length': String(range.end - range.start + 1)
      })
    } else {
      res.writeHead(200, { ...baseHeaders, 'content-length': String(size) })
    }
    // Streamed, never buffered whole: a finished recording is routinely gigabytes, unlike the
    // transcode route's in-flight segments (serveTranscodeFile), which are seconds of media.
    const rs = openStream(filePath, range ? { start: range.start, end: range.end } : undefined)
    rs.on('error', () => res.destroy())
    rs.pipe(res)
  }

  async function setRecordingsDir(dir: string): Promise<void> {
    if (active.size > 0) throw new Error('Cannot change the recordings folder while a recording is in progress')
    recordingsRoot = dir
    indexFilePath = join(dir, 'recordings.json')
    indexCache = null
    await loadIndex()
    log(`[recording] recordings dir set to ${dir}`)
  }

  function onChange(cb: (entries: RecordingEntry[]) => void): () => void {
    changeListeners.add(cb)
    return () => changeListeners.delete(cb)
  }

  function isRecording(): boolean {
    return [...active.values()].some((r) => !r.exited)
  }

  async function stopAll(): Promise<void> {
    for (const timer of scheduledTimers.values()) clearTimeoutFn(timer)
    scheduledTimers.clear()
    const stops: Promise<void>[] = []
    for (const rec of [...active.values()]) {
      rec.stoppedByUs = true
      if (rec.endTimer) clearTimeoutFn(rec.endTimer)
      if (!rec.exited) {
        rec.proc.kill('SIGTERM')
        // Brief wait only — this is the quit path; the app will not sit around for a slow death.
        await Promise.race([
          new Promise<void>((resolve) => {
            if (rec.exited) resolve()
            else rec.exitWaiters.push(resolve)
          }),
          new Promise<void>((resolve) => setTimeoutFn(resolve, stopGraceMs))
        ])
        if (!rec.exited) rec.proc.kill('SIGKILL')
      }
      active.delete(rec.entry.id)
      // 'partial' honestly: the app quit and took the recorder with it, whatever programme
      // state the recording was in.
      stops.push(finalize(rec, 'partial'))
    }
    await Promise.all(stops)
  }

  return { start, stop, schedule, cancelScheduled, list, remove, reveal, serveRecordingFile, onChange, setRecordingsDir, isRecording, stopAll }
}

// Exported pure so the exact argv the service builds is assertable in tests without spawning.
// -re (same reasoning as transcodeService's live path): this provider's raw live connections
// deliver far faster than realtime, and an unpaced recorder would race through hours of stream
// in minutes and then die on "unexpected" EOF long before the programme ends. No -tag:v — see
// the module comment for why HEVC tagging is deliberately skipped for recordings.
export function buildRecordingArgv(sourceUrl: string, playlistPath: string): string[] {
  return [
    '-y',
    '-re',
    '-i',
    sourceUrl,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-f',
    'hls',
    '-hls_time',
    '6',
    '-hls_playlist_type',
    'event',
    '-hls_list_size',
    '0',
    '-hls_flags',
    'independent_segments',
    playlistPath
  ]
}
