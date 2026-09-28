// @vitest-environment jsdom
//
// Split tests: the detector/decision helpers above are pure and env-agnostic; the memory tests
// at the bottom render the hook itself, so this file runs in jsdom (the default node
// environment has no DOM for React to render into).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import {
  isUnsupportedAudioCodecError,
  isRawStreamManifestError,
  shouldRestartRemuxChain,
  MAX_REMUX_CHAIN_RESTARTS,
  useTranscodeFallback
} from './useTranscodeFallback'
import { useAppStore } from '../store/useAppStore'
import { DEFAULT_SETTINGS } from './types'
import { TRANSCODE_MEMORY_MAX_ENTRIES } from './transcodeMemory'
import type { TranscodeMemoryEntry } from './types'
import type { ErrorData } from 'hls.js'

// Only the fields these detectors actually read — a real ErrorData carries a lot more, but
// this is what the detection logic keys off.
function errorData(overrides: Partial<ErrorData>): ErrorData {
  return { type: 'mediaError', fatal: true, ...overrides } as ErrorData
}

describe('isUnsupportedAudioCodecError', () => {
  it('detects a fragParsingError whose reason mentions EC-3', () => {
    expect(
      isUnsupportedAudioCodecError(errorData({ details: 'fragParsingError' as never, reason: 'Unsupported EC-3 in M2TS found' }))
    ).toBe(true)
  })

  it('detects a fragParsingError whose reason mentions AC-3 (no hyphen)', () => {
    expect(isUnsupportedAudioCodecError(errorData({ details: 'fragParsingError' as never, reason: 'unsupported ac3 track' }))).toBe(
      true
    )
  })

  it('ignores a fragParsingError for an unrelated reason', () => {
    expect(
      isUnsupportedAudioCodecError(errorData({ details: 'fragParsingError' as never, reason: 'invalid NAL unit' }))
    ).toBe(false)
  })

  it('detects a bufferAddCodecError on an audio mimeType', () => {
    expect(
      isUnsupportedAudioCodecError(errorData({ details: 'bufferAddCodecError' as never, mimeType: 'audio/mp4; codecs="ec-3"' }))
    ).toBe(true)
  })

  it('detects a bufferAppendError on an audio mimeType', () => {
    expect(isUnsupportedAudioCodecError(errorData({ details: 'bufferAppendError' as never, mimeType: 'audio/mp4' }))).toBe(true)
  })

  it('ignores a bufferAddCodecError on a video mimeType', () => {
    expect(
      isUnsupportedAudioCodecError(errorData({ details: 'bufferAddCodecError' as never, mimeType: 'video/mp4; codecs="hvc1"' }))
    ).toBe(false)
  })

  it('ignores unrelated error details entirely', () => {
    expect(isUnsupportedAudioCodecError(errorData({ details: 'manifestLoadError' as never }))).toBe(false)
  })
})

// See isRawStreamManifestError's own doc comment: the provider's panel answers every live
// stream URL with raw MPEG-TS bytes (confirmed live 2026-09-26), which hls.js — a text-playlist
// parser — can only ever report as a manifest parsing failure.
describe('isRawStreamManifestError', () => {
  it('detects a manifestParsingError', () => {
    expect(isRawStreamManifestError(errorData({ details: 'manifestParsingError' as never, type: 'networkError' as never }))).toBe(
      true
    )
  })

  it('ignores the audio-codec failures the other detector owns', () => {
    expect(
      isRawStreamManifestError(errorData({ details: 'fragParsingError' as never, reason: 'Unsupported EC-3 in M2TS found' }))
    ).toBe(false)
    expect(isRawStreamManifestError(errorData({ details: 'bufferAppendError' as never, mimeType: 'audio/mp4' }))).toBe(false)
  })

  it('accepts the whole "that was not a usable playlist" family', () => {
    // Widened 2026-09-27 after reproducing both shapes in a real Chromium: a raw-TS body the
    // panel *ends* surfaces as manifestParsingError, but a genuinely live one never reaches the
    // parser at all and surfaces as manifestLoadTimeOut once the manifest load policy is spent —
    // which is the shape the original single-detail check could never match.
    expect(isRawStreamManifestError(errorData({ details: 'manifestLoadTimeOut' as never }))).toBe(true)
    expect(isRawStreamManifestError(errorData({ details: 'manifestLoadError' as never }))).toBe(true)
    expect(isRawStreamManifestError(errorData({ details: 'levelEmptyError' as never }))).toBe(true)
  })

  it('ignores failures that are not about the playlist at all', () => {
    // These are the ones that must NOT spend the channel's single remux attempt — a failed
    // *fragment* (or a codec append) is not a missing playlist, and treating it as one is what
    // left the player with no recovery and a terminal "gave up after N retries" message.
    expect(isRawStreamManifestError(errorData({ details: 'fragLoadError' as never }))).toBe(false)
    expect(isRawStreamManifestError(errorData({ details: 'bufferAddCodecError' as never }))).toBe(false)
  })
})

// The bounded-restart decision behind attemptRemuxRecovery: the provider kills paced live
// reader connections at unpredictable intervals (measured live 2026-09-27, one remux dead at
// 11s while the identical invocation ran 75s+ minutes later), so a dead remux must be
// restartable — but never unboundedly, or a genuinely dead channel would spin forever.
describe('shouldRestartRemuxChain', () => {
  it('restarts while the budget lasts', () => {
    expect(shouldRestartRemuxChain(false, 0)).toBe(true)
    expect(shouldRestartRemuxChain(false, MAX_REMUX_CHAIN_RESTARTS - 1)).toBe(true)
  })

  it('refuses once the budget is spent', () => {
    expect(shouldRestartRemuxChain(false, MAX_REMUX_CHAIN_RESTARTS)).toBe(false)
    expect(shouldRestartRemuxChain(false, MAX_REMUX_CHAIN_RESTARTS + 5)).toBe(false)
  })

  it('never double-starts while a recovery is already in flight', () => {
    // The still-attached hls instance keeps raising fatal errors while the replacement remux
    // spins up; absorbing those without spending budget is what makes the restart survive
    // its own startup window.
    expect(shouldRestartRemuxChain(true, 0)).toBe(false)
  })
})

// --- the remembered-outcome memory, at the hook boundary ------------------------------------
//
// Rendered in jsdom because the hook is real React state; the store is driven directly (same
// pattern as components.test.tsx) and window.api is a minimal transcode stub. What these pin
// down: a remembered 'audio' entry — even with a rotated provider token — starts the remux
// immediately (true here means the caller skips its silent-audio poll, so the transcode must
// already be going); a 'direct' record starts nothing, so detection keeps running; and both
// conclusions write their outcome through the store's settings, pruned to the cap on the way.
describe('transcode memory (VOD/series)', () => {
  const PLAY_URL = 'http://provider.example:8080/movie/user/pass/1234.mkv?token=current'
  const CONFIRMED_URL = 'http://provider.example:8080/movie/user/pass/1234.mkv?token=rotated-away'

  let startMock: ReturnType<typeof vi.fn>

  function movie(streamId = 1234): void {
    useAppStore.setState({
      nowPlaying: {
        kind: 'movie',
        streamId,
        name: 'A Movie',
        url: PLAY_URL,
        extension: 'mkv',
        tvArchive: 0,
        icon: ''
      }
    })
  }

  beforeEach(() => {
    startMock = vi.fn(() => Promise.resolve({ url: 'http://127.0.0.1:9/transcode/session/playlist.m3u8' }))
    ;(window as unknown as { api: unknown }).api = {
      transcode: {
        setHevcSupport: vi.fn(() => Promise.resolve()),
        start: startMock,
        stop: vi.fn(() => Promise.resolve())
      },
      store: { get: vi.fn(() => Promise.resolve(undefined)), set: vi.fn(() => Promise.resolve()) }
    }
    useAppStore.setState({ nowPlaying: null, settings: DEFAULT_SETTINGS })
    movie()
  })

  afterEach(() => {
    cleanup()
  })

  it('starts the remux straight from a remembered audio entry with a rotated token — no detection wait', async () => {
    useAppStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        transcodeMemory: {
          'movie:1234': { kind: 'audio', audioIndex: 2, url: CONFIRMED_URL, confirmedAt: 1000 }
        }
      }
    })
    const { result } = renderHook(() => useTranscodeFallback())
    const onReload = vi.fn()
    let started = false
    await act(async () => {
      started = result.current.tryFallbackForRememberedAudio(PLAY_URL, onReload)
    })
    // true = the caller skips registering its silent-audio poll; the transcode is already going.
    expect(started).toBe(true)
    expect(startMock).toHaveBeenCalledWith(PLAY_URL, true, expect.any(String), 0, 2)
    expect(onReload).toHaveBeenCalled()
    // Success re-confirms the entry (fresh confirmedAt) rather than dropping or duplicating it.
    const entry = useAppStore.getState().settings.transcodeMemory['movie:1234']
    expect(entry).toMatchObject({ kind: 'audio', audioIndex: 2 })
    expect(entry.confirmedAt).toBeGreaterThan(1000)
  })

  it('does not act on a direct record — detection keeps running in case the file changed', async () => {
    useAppStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        transcodeMemory: { 'movie:1234': { kind: 'direct', url: CONFIRMED_URL, confirmedAt: 1000 } }
      }
    })
    const { result } = renderHook(() => useTranscodeFallback())
    let started = true
    await act(async () => {
      started = result.current.tryFallbackForRememberedAudio(PLAY_URL, vi.fn())
    })
    expect(started).toBe(false)
    expect(startMock).not.toHaveBeenCalled()
  })

  it('ignores a fix confirmed against a different file, and leaves live content alone', async () => {
    useAppStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        transcodeMemory: {
          'movie:1234': { kind: 'audio', audioIndex: 2, url: 'http://provider.example/other/9999.mkv', confirmedAt: 1 },
          '42': { kind: 'audio', audioIndex: 1, url: 'http://provider.example/live/u/p/42.ts', confirmedAt: 2 }
        }
      }
    })
    const { result } = renderHook(() => useTranscodeFallback())
    let started = true
    await act(async () => {
      started = result.current.tryFallbackForRememberedAudio(PLAY_URL, vi.fn())
    })
    expect(started).toBe(false)

    // A live channel with a matching-looking entry still gets nothing from this memory path —
    // live keeps liveAudioFixes.
    useAppStore.setState({
      nowPlaying: {
        kind: 'live',
        streamId: 42,
        name: 'News',
        url: 'http://provider.example/live/u/p/42.ts',
        extension: 'ts',
        tvArchive: 0,
        icon: ''
      }
    })
    let liveStarted = true
    await act(async () => {
      liveStarted = result.current.tryFallbackForRememberedAudio('http://provider.example/live/u/p/42.ts', vi.fn())
    })
    expect(liveStarted).toBe(false)
    expect(startMock).not.toHaveBeenCalled()
  })

  it('writes the audio outcome when the silent-audio conclusion starts the remux', async () => {
    const { result } = renderHook(() => useTranscodeFallback())
    const onReload = vi.fn()
    await act(async () => {
      result.current.tryFallbackForSilentAudio(PLAY_URL, onReload)
    })
    expect(startMock).toHaveBeenCalledWith(PLAY_URL, true, expect.any(String), 0, 0)
    expect(useAppStore.getState().settings.transcodeMemory['movie:1234']).toMatchObject({
      kind: 'audio',
      audioIndex: 0,
      url: PLAY_URL
    })
  })

  it('records a direct outcome, and refuses to write one for live content', () => {
    const { result } = renderHook(() => useTranscodeFallback())
    act(() => {
      result.current.rememberDirectOutcome(PLAY_URL)
    })
    expect(useAppStore.getState().settings.transcodeMemory['movie:1234']).toMatchObject({
      kind: 'direct',
      url: PLAY_URL
    })

    useAppStore.setState({
      nowPlaying: {
        kind: 'live',
        streamId: 42,
        name: 'News',
        url: 'http://provider.example/live/u/p/42.ts',
        extension: 'ts',
        tvArchive: 0,
        icon: ''
      }
    })
    act(() => {
      result.current.rememberDirectOutcome('http://provider.example/live/u/p/42.ts')
    })
    expect(useAppStore.getState().settings.transcodeMemory['42']).toBeUndefined()
  })

  it('prunes to the cap on every write, oldest dropped first', () => {
    const memory: Record<string, TranscodeMemoryEntry> = {}
    for (let i = 0; i < TRANSCODE_MEMORY_MAX_ENTRIES; i++) {
      memory[`movie:${i}`] = { kind: 'direct', url: `http://provider.example/movie/${i}.mkv`, confirmedAt: i }
    }
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, transcodeMemory: memory } })
    movie(77777)
    const { result } = renderHook(() => useTranscodeFallback())
    act(() => {
      result.current.rememberDirectOutcome(PLAY_URL)
    })
    const next = useAppStore.getState().settings.transcodeMemory
    expect(Object.keys(next)).toHaveLength(TRANSCODE_MEMORY_MAX_ENTRIES)
    expect(next['movie:0']).toBeUndefined()
    expect(next['movie:1']).toBeDefined()
    expect(next['movie:77777']).toBeDefined()
  })
})
