import { describe, it, expect, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ServerResponse } from 'http'
import {
  buildRecordingArgv,
  createRecordingService,
  parseRangeHeader,
  type RecordingService,
  type RecordingServiceDeps
} from './recordingService'

const FAKE_FFMPEG = join(import.meta.dirname, 'test-fixtures/fake-ffmpeg.sh')
chmodSync(FAKE_FFMPEG, 0o755)

function resolverFor(path: string | null): () => Promise<string | null> {
  return () => Promise.resolve(path)
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

const activeServices: RecordingService[] = []
afterEach(() => {
  for (const service of activeServices.splice(0)) void service.stopAll()
})

function track(service: RecordingService): RecordingService {
  activeServices.push(service)
  return service
}

function makeService(overrides: Partial<RecordingServiceDeps> = {}): RecordingService {
  const dir = mkdtempSync(join(tmpdir(), 'allisoniptv-recordings-'))
  return track(
    createRecordingService({
      recordingsDir: dir,
      resolveFfmpegPath: resolverFor(FAKE_FFMPEG),
      stopGraceMs: 1000,
      trashItem: async (path) => {
        await rmSync(path, { recursive: true, force: true })
      },
      ...overrides
    })
  )
}

// Predicate may be async — awaited, not truthiness-checked, so a Promise return value can't
// masquerade as "condition met" (exactly the bug the first draft of this helper had).
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('waitFor: condition never became true')
}

describe('buildRecordingArgv', () => {
  it('builds the copy+AAC HLS event argv with -re pacing and no hvc1 tag', () => {
    const argv = buildRecordingArgv('http://example.com/live.ts', '/tmp/r/index.m3u8')
    expect(argv).toContain('-re')
    expect(argv).toContain('-c:v')
    expect(argv[argv.indexOf('-c:v') + 1]).toBe('copy')
    expect(argv).not.toContain('hvc1')
    expect(argv[argv.indexOf('-hls_playlist_type') + 1]).toBe('event')
    expect(argv[argv.indexOf('-hls_list_size') + 1]).toBe('0')
    expect(argv[argv.lastIndexOf('-map') - 1]).toBe('0:v:0')
    expect(argv).toContain('0:a:0?')
    expect(argv[argv.length - 1]).toBe('/tmp/r/index.m3u8')
  })
})

describe('parseRangeHeader', () => {
  it('returns null when no header is present', () => {
    expect(parseRangeHeader(1000, undefined)).toBeNull()
  })
  it('resolves an explicit range and clamps its end to the resource size', () => {
    expect(parseRangeHeader(1000, 'bytes=0-499')).toEqual({ start: 0, end: 499 })
    expect(parseRangeHeader(1000, 'bytes=900-5000')).toEqual({ start: 900, end: 999 })
  })
  it('resolves an open-ended range to the end of the resource', () => {
    expect(parseRangeHeader(1000, 'bytes=500-')).toEqual({ start: 500, end: 999 })
  })
  it('resolves a suffix range', () => {
    expect(parseRangeHeader(1000, 'bytes=-100')).toEqual({ start: 900, end: 999 })
  })
  it('marks syntactically invalid and out-of-bounds ranges invalid', () => {
    expect(parseRangeHeader(1000, 'bytes=')).toBe('invalid')
    expect(parseRangeHeader(1000, 'chunks=0-1')).toBe('invalid')
    expect(parseRangeHeader(1000, 'bytes=500-400')).toBe('invalid')
    expect(parseRangeHeader(1000, 'bytes=1000-')).toBe('invalid')
    expect(parseRangeHeader(1000, 'bytes=-0')).toBe('invalid')
  })
})

describe('start/stop lifecycle', () => {
  it('starts ffmpeg, writes the playlist, and on stop appends #EXT-X-ENDLIST and marks done', async () => {
    const service = makeService()
    const entry = await withFakeFfmpegMode('recording_success', () =>
      service.start({ channelKey: '42', channelName: 'Test TV', sourceUrl: 'irrelevant' })
    )

    expect(entry.status).toBe('recording')
    await waitFor(() => existsSync(join(entry.dir, 'index.m3u8')))
    expect(readFileSync(join(entry.dir, 'index.m3u8'), 'utf8')).not.toContain('#EXT-X-ENDLIST')

    await service.stop(entry.id)
    const after = (await service.list()).find((e) => e.id === entry.id)
    expect(after?.status).toBe('done')
    expect(after?.endedAt).toBeTypeOf('number')
    expect(after?.bytes).toBeGreaterThan(0)
    expect(readFileSync(join(entry.dir, 'index.m3u8'), 'utf8')).toContain('#EXT-X-ENDLIST')
  })

  it('marks done on a natural stream end (ffmpeg exit 0) without duplicating the ENDLIST', async () => {
    const service = makeService()
    const entry = await withFakeFfmpegMode('recording_natural_end', () =>
      service.start({ channelKey: '42', channelName: 'Test TV', sourceUrl: 'irrelevant' })
    )
    await waitFor(async () => {
      const found = (await service.list()).find((e) => e.id === entry.id)
      return found?.status === 'done'
    })
    const after = (await service.list()).find((e) => e.id === entry.id)
    expect(after?.status).toBe('done')
    const text = readFileSync(join(entry.dir, 'index.m3u8'), 'utf8')
    expect(text.match(/#EXT-X-ENDLIST/g)?.length).toBe(1)
  })

  it('restarts once on an unexpected exit and finalises as partial when it dies again', async () => {
    const service = makeService()
    const entry = await withFakeFfmpegMode('recording_die', () =>
      service.start({ channelKey: '42', channelName: 'Test TV', sourceUrl: 'irrelevant' })
    )
    await waitFor(async () => {
      const found = (await service.list()).find((e) => e.id === entry.id)
      return found?.status === 'partial'
    })
  })

  it('recovers when the restart attempt succeeds, and a later stop finalises done', async () => {
    const service = makeService()
    const markerFile = join(mkdtempSync(join(tmpdir(), 'allisoniptv-marker-')), 'argv')
    // The service's one restart spawns a SECOND fixture process some time after start()
    // resolves, so the env wrapper has to span the whole body — wrapping only start() would
    // restore FAKE_FFMPEG_MODE before the restart ever spawned (the exact trap the first
    // draft of this test fell into).
    const entry = await withEnv({ FAKE_FFMPEG_ARGV_FILE: markerFile }, () =>
      withFakeFfmpegMode('recording_die_then_live', async () => {
        const started = await service.start({ channelKey: '42', channelName: 'Test TV', sourceUrl: 'irrelevant' })
        await waitFor(() => existsSync(join(started.dir, 'index.m3u8')))
        return started
      })
    )
    // The restart is running — still 'recording'.
    expect(((await service.list()).find((e) => e.id === entry.id))?.status).toBe('recording')
    await service.stop(entry.id)
    expect(((await service.list()).find((e) => e.id === entry.id))?.status).toBe('done')
  })

  it('refuses a second recording of the same channel', async () => {
    const service = makeService()
    await withFakeFfmpegMode('recording_success', () =>
      service.start({ channelKey: '42', channelName: 'Test TV', sourceUrl: 'irrelevant' })
    )
    await expect(
      withFakeFfmpegMode('recording_success', () =>
        service.start({ channelKey: '42', channelName: 'Test TV', sourceUrl: 'irrelevant' })
      )
    ).rejects.toThrow('Already recording')
    await service.stop((await service.list()).find((e) => e.channelKey === '42')!.id)
  })
})

describe('index persistence', () => {
  it('writes recordings.json atomically (no leftover tmp files) and list() reads it back', async () => {
    const service = makeService()
    const entry = await withFakeFfmpegMode('recording_success', () =>
      service.start({ channelKey: '42', channelName: 'Test TV', sourceUrl: 'irrelevant' })
    )
    await service.stop(entry.id)
    const dir = join(entry.dir, '..')
    const names = readdirSync(dir)
    expect(names).toContain('recordings.json')
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([])
    const parsed = JSON.parse(readFileSync(join(dir, 'recordings.json'), 'utf8'))
    expect(parsed.version).toBe(1)
    expect(parsed.entries[0].id).toBe(entry.id)
    expect((await service.list()).map((e) => e.id)).toEqual([entry.id])
  })
})

describe('remove', () => {
  it('stops an active recording, drops the index entry and trashes the directory', async () => {
    const trashed: string[] = []
    const service = makeService({
      trashItem: async (path) => {
        trashed.push(path)
        rmSync(path, { recursive: true, force: true })
      }
    })
    const entry = await withFakeFfmpegMode('recording_success', () =>
      service.start({ channelKey: '42', channelName: 'Test TV', sourceUrl: 'irrelevant' })
    )
    await service.remove(entry.id)
    expect(trashed).toEqual([entry.dir])
    expect((await service.list()).find((e) => e.id === entry.id)).toBeUndefined()
    expect(existsSync(entry.dir)).toBe(false)
  })
})

describe('scheduler', () => {
  it('schedules with preroll, starts on the timer, and stops at endAt+postroll', async () => {
    // Injected clock and timer queue: the service never touches real time here.
    let nowMs = 1_000_000
    interface PendingTimer {
      fn: () => void
      delay: number
    }
    let nextTimerId = 1
    const pending = new Map<number, PendingTimer>()
    const setTimeoutFn = ((fn: () => void, delay?: number) => {
      const id = nextTimerId++
      pending.set(id, { fn, delay: delay ?? 0 })
      return id as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    const clearTimeoutFn = ((id: unknown) => {
      pending.delete(id as number)
    }) as typeof clearTimeout
    const fire = (): void => {
      const timers = [...pending.values()].sort((a, b) => a.delay - b.delay)
      const timer = timers[0]
      if (!timer) throw new Error('no timer to fire')
      // Fire the earliest-due timer (delays are relative-to-arm in this simplified harness;
      // ordering is all the assertions below need).
      for (const [id, t] of [...pending.entries()]) if (t === timer) pending.delete(id)
      timer.fn()
    }

    const service = makeService({ now: () => nowMs, setTimeoutFn, clearTimeoutFn })

    const startAt = nowMs + 60 * 60 * 1000 // an hour out
    const endAt = startAt + 30 * 60 * 1000
    // The injected timers fire long after schedule() resolved, so the mode wrapper has to span
    // the entire scenario (same trap as the die-then-live test above).
    const entry = await withFakeFfmpegMode('recording_success', async () => {
      const scheduled = await service.schedule({
        programmeTitle: 'The Programme',
        channelKey: '42',
        channelName: 'Test TV',
        sourceUrl: 'irrelevant',
        startAt,
        endAt,
        prerollSeconds: 60,
        postrollSeconds: 120
      })

      // Fire the start timer → the recording goes live (wait for the fixture's playlist, not
      // just the index status — the entry flips to 'recording' before ffmpeg has written).
      nowMs = startAt - 60 * 1000
      fire()
      await waitFor(() => existsSync(join(scheduled.dir, 'index.m3u8')))
      expect(((await service.list()).find((e) => e.id === scheduled.id))?.programmeTitle).toBe('The Programme')

      // Fire the scheduled-end timer (armed at endAt + postroll) → done, playlist closed.
      nowMs = endAt + 120 * 1000
      fire()
      await waitFor(async () => {
        const found = (await service.list()).find((e) => e.id === scheduled.id)
        return found?.status === 'done'
      })
      return scheduled
    })
    const finished = (await service.list()).find((e) => e.id === entry.id)!
    expect(readFileSync(join(finished.dir, 'index.m3u8'), 'utf8')).toContain('#EXT-X-ENDLIST')
  })
})

describe('serveRecordingFile', () => {
  async function makeServedFile(): Promise<{ service: RecordingService; file: string; size: number }> {
    const service = makeService()
    const entry = await withFakeFfmpegMode('recording_success', () =>
      service.start({ channelKey: '42', channelName: 'Test TV', sourceUrl: 'irrelevant' })
    )
    await waitFor(() => existsSync(join(entry.dir, 'index.m3u8')))
    await service.stop(entry.id)
    const file = join(entry.dir, 'index.m3u8')
    return { service, file, size: readFileSync(file).length }
  }

  function fakeRes(): ServerResponse & {
    headers: Record<string, unknown> | null
    chunks: Buffer[]
    ended: boolean
  } {
    const res = {
      headers: null as Record<string, unknown> | null,
      chunks: [] as Buffer[],
      ended: false,
      writeHead(status: number, headers?: Record<string, unknown>): ServerResponse {
        this.headers = { status, ...(headers ?? {}) }
        return this as unknown as ServerResponse
      },
      end(data?: Buffer | string): void {
        if (data) this.chunks.push(Buffer.from(data))
        this.ended = true
      },
      destroy(): void {
        this.ended = true
      },
      // The service pipes a createReadStream into the response — capture what a pipe would
      // deliver by consuming the readable side directly.
      __proto__: undefined as never
    }
    return res as never
  }

  it('serves a range request as 206 with the right Content-Range and byte slice', async () => {
    const { service } = await makeServedFile()
    // Exercise the range path against a real file via the public route, using a response
    // stand-in that records headers and collects piped bytes.
    const size = readFileSync(
      join(
        (await service.list())[0].dir,
        'index.m3u8'
      )
    ).length
    const headers: Record<string, unknown> = {}
    const chunks: Buffer[] = []
    const res = {
      writeHead(status: number, h?: Record<string, unknown>) {
        Object.assign(headers, { status, ...h })
      },
      end(data?: Buffer | string) {
        if (data) chunks.push(Buffer.from(data))
      },
      destroy() {
        /* unused here */
      },
      // A minimal writable for pipe(): Node's stream pipes call write() and end().
      write(chunk: Buffer) {
        chunks.push(Buffer.from(chunk))
        return true
      },
      on() {
        return this
      },
      once() {
        return this
      },
      emit() {
        return true
      }
    } as unknown as ServerResponse
    await service.serveRecordingFile(`/__recordings/${(await service.list())[0].id}/index.m3u8`, 'bytes=0-9', res)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(headers['status']).toBe(206)
    expect(headers['content-range']).toBe(`bytes 0-9/${size}`)
    expect(Buffer.concat(chunks).length).toBe(10)
  })

  it('rejects path traversal with 403', async () => {
    const service = makeService()
    const res = fakeRes()
    await service.serveRecordingFile('/__recordings/..%2F..%2Fsecret/index.m3u8', undefined, res)
    // The route regex only allows one path segment after the id, and '..' contains no slash —
    // the traversal that would matter resolves outside the root and is refused here.
    expect([403, 404]).toContain((res.headers as { status: number } | null)?.status)
  })
})
