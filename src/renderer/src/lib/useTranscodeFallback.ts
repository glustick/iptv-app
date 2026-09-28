import { useCallback, useEffect, useRef, useState } from 'react'
import type { ErrorData } from 'hls.js'
import { clientCanDecodeHevc } from './hevcSupport'
import { rememberedAudioIndex, pruneTranscodeMemory, transcodeMemoryKey } from './transcodeMemory'
import { useAppStore } from '../store/useAppStore'
import type { TranscodeMemoryEntry } from './types'

/**
 * Detects a class of hls.js failures that share one real cause — a Dolby Digital
 * (AC-3/E-AC-3) audio track this app's playback engine can't handle: hls.js's own demuxer
 * refusing to parse EC-3 inside MPEG-TS at all (fatal fragParsingError), or Chromium's
 * SourceBuffer rejecting the codec once handed valid AAC-shaped data (non-fatal
 * bufferAddCodecError/bufferAppendError). No amount of retrying fixes either.
 */
export function isUnsupportedAudioCodecError(data: ErrorData): boolean {
  return (
    (data.details === 'fragParsingError' && typeof data.reason === 'string' && /ec-?3|ac-?3/i.test(data.reason)) ||
    ((data.details === 'bufferAddCodecError' || data.details === 'bufferAppendError') &&
      typeof data.mimeType === 'string' &&
      data.mimeType.toLowerCase().includes('audio'))
  )
}

/**
 * Detects the second real class of hls.js failures: the "playlist" the provider served isn't a
 * playlist at all. Confirmed live 2026-09-26 — the provider's panel answers every live stream
 * URL with a raw MPEG-TS byte stream (video/mp2t, no HLS playlist anywhere), which hls.js can
 * only ever report as a manifest parsing failure (its loaders parse text; TS sync bytes are
 * garbage to them). Unlike the audio-codec case above, nothing about hls.js's own recovery
 * applies here: there is no playlist to reconcile or retry, so the only remediation is the
 * same local ffmpeg remux the audio fallback uses — ffmpeg sniffs and demuxes the raw TS fine
 * (see transcodeService.ts, whose live output is fragmented MP4 precisely so HEVC channels
 * survive this path too).
 *
 * Deliberately not gated on anything content-shaped (there's no reliable signal beyond the
 * parse failure itself — hls.js doesn't expose the response's content-type on ErrorData): a
 * genuinely corrupt playlist gets the same treatment, and ffmpeg remuxing it is a legitimate
 * recovery there too. Callers scope it to live channels, where this failure mode lives.
 *
 * Widened 2026-09-27 after reproducing both shapes against hls.js 1.7.1 in a real Chromium: a
 * raw-TS body the panel *ends* surfaces as `manifestParsingError` ("no EXTM3U delimiter"), but
 * a genuinely live one — which by definition never ends — never reaches the parser at all and
 * surfaces as `manifestLoadTimeOut` once the manifest load policy's budget is spent. The
 * original single-detail check therefore never matched the real live case. `manifestLoadError`
 * and `levelEmptyError` are the same family: "what came back was not a usable playlist, and
 * hls.js's own retry ladder has nothing to reconcile or retry."
 */
export function isRawStreamManifestError(data: ErrorData): boolean {
  return (
    data.details === 'manifestParsingError' ||
    data.details === 'manifestLoadTimeOut' ||
    data.details === 'manifestLoadError' ||
    data.details === 'levelEmptyError'
  )
}

// How many times a channel open may restart the whole remux chain (stop the dead session,
// forget the spent one-shot, remux again from the original URL). The provider this app uses
// kills paced reader connections at random intervals (measured live: one remux died 11s in,
// the identical CLI invocation ran fine for 75s+, minutes apart) — so a live remux dying
// mid-playback is a WHEN, not an IF, and without a restart the channel just freezes forever
// on a frozen playlist (the renderer's reload re-attaches the same dead session URL in a loop
// that never escalates — reproduced live in the packaged 0.7.112). Three is enough to ride out
// an unlucky minute without letting a genuinely dead channel spin forever.
export const MAX_REMUX_CHAIN_RESTARTS = 3

/**
 * The decision core of attemptRemuxRecovery (pure so it's unit-testable, matching the rest of
 * this module's split between decide and act): whether a fatal live failure should restart the
 * remux chain, given one isn't already in flight and the restart budget isn't spent.
 */
export function shouldRestartRemuxChain(awaitingTranscode: boolean, restartsUsed: number): boolean {
  return !awaitingTranscode && restartsUsed < MAX_REMUX_CHAIN_RESTARTS
}

/**
 * The transcode-memory key for whatever movie or episode is playing right now, or null for
 * live content (this memory is deliberately VOD/series-only — live keeps its own
 * liveAudioFixes) and for nothing playing at all. Read from the store rather than passed in by
 * callers, because every call point here is the playback of the title the player just opened:
 * the store's nowPlaying is that identity, and taking it from one place keeps the read and the
 * writes from ever disagreeing about a key. The series form uses String(streamId): an episode
 * is played with exactly Number(episode.id) (see SeriesModal's play call), so this round-trips
 * the same id the episode-progress store already round-trips the same way.
 */
function nowPlayingVodMemoryKey(): string | null {
  const { nowPlaying } = useAppStore.getState()
  if (!nowPlaying || (nowPlaying.kind !== 'movie' && nowPlaying.kind !== 'series')) return null
  return nowPlaying.kind === 'movie'
    ? transcodeMemoryKey({ kind: 'movie', streamId: nowPlaying.streamId })
    : transcodeMemoryKey({ kind: 'series', episodeId: String(nowPlaying.streamId) })
}

/**
 * Shared remediation for the failure isUnsupportedAudioCodecError detects: spins up a local
 * ffmpeg process (see src/main/index.ts's transcode: IPC handlers) that remuxes just the
 * affected channel's audio to AAC, and falls back to that output. Used by both Player.tsx
 * (the fullscreen player) and useHlsAttach.ts (the small preview) so this detection and
 * remediation logic isn't duplicated between them — only the video actually froze/glitched
 * in each place, the fix is identical.
 *
 * VOD/series never go through hls.js at all (see Player.tsx: only .m3u8 — always live —
 * attaches hls.js; everything else is a plain `video.src` assignment), so this exact failure
 * mode shows up completely differently there: no error event ever fires, video decodes and
 * plays normally, and the audio track just silently produces nothing. There's no ErrorData to
 * check in that case — Player.tsx detects it itself by polling webkitAudioDecodedByteCount —
 * so tryFallbackForSilentAudio skips the isUnsupportedAudioCodecError check entirely and is
 * only ever called once that polling has already confirmed the symptom.
 */
export interface SubtitleTrackInfo {
  index: number
  language: string | null
  // False for a bitmap/image subtitle codec (PGS, VobSub, ...) ffmpeg's webvtt encoder can't
  // convert at all — confirmed live against a real Blu-ray-sourced movie whose second English
  // track was exactly this, which crashes the entire transcode (video and audio included) if
  // mapped, not just that track. A caller should never offer switching to a track where this is
  // false, even though it's still reported here rather than silently dropped, so the UI can at
  // least explain why a track isn't selectable.
  supported: boolean
}

export interface AudioTrackInfo {
  index: number
  language: string | null
  codec: string
  // e.g. "stereo", "mono", "5.1(side)" — most real-world extra tracks like this carry no
  // language tag at all (see probeLiveAudioTracks' own comment), so this is often the only
  // thing that actually distinguishes one track from another in a picker.
  channelLayout: string
}

export function useTranscodeFallback(): {
  transcoding: boolean
  getSourceUrl: (originalUrl: string) => string
  tryFallback: (data: ErrorData, originalUrl: string, onReload: () => void, onError?: (message: string) => void) => boolean
  // The raw-TS counterpart of tryFallback above (see isRawStreamManifestError) — same remux,
  // different reason, so the UI can say what's actually happening ("this channel is streaming
  // raw MPEG-TS…") instead of claiming an audio fix. Takes the ErrorData for the same reason
  // tryFallback does: only the failure it actually owns may spend the channel's single attempt.
  tryFallbackForRawStream: (
    data: ErrorData,
    originalUrl: string,
    onReload: () => void,
    onError?: (message: string) => void
  ) => boolean
  // Last-resort recovery for a live channel whose remux ALREADY ran and died mid-playlist (see
  // MAX_REMUX_CHAIN_RESTARTS): stop the dead session, un-spend the one-shot, remux again.
  // Returns false when nothing may restart (one in flight, or budget spent) and the caller
  // should fall through to its terminal error handling.
  attemptRemuxRecovery: (originalUrl: string, onReload: () => void, onError?: (message: string) => void) => boolean
  // Why the current/last fallback run started — drives the status wording in Player.tsx. null
  // while nothing has run (or after reset()).
  transcodeReason: 'audio' | 'raw-stream' | null
  tryFallbackForSilentAudio: (
    originalUrl: string,
    onReload: () => void,
    onError?: (message: string) => void,
    // Live TV's own silent-audio detection (see Player.tsx's hls branch) passes false so the
    // fallback gets Live's short-segment-window HLS output rather than VOD's event playlist —
    // defaults to true since the original, VOD-only caller never says otherwise.
    isVod?: boolean
  ) => boolean
  // The remembered-outcome read for movies/series (settings.transcodeMemory — see
  // lib/transcodeMemory.ts for the key and source-matching rules): the audio track this
  // title's last confirmed outcome says to remux with, or null when there is nothing
  // actionable (no entry from this title, one confirmed against a different source, or a
  // 'direct' record — see the implementation for why 'direct' is deliberately not acted
  // on). A caller that gets an index must skip registering its silent-audio detection poll
  // and start the remux via startRememberedVodFallback below instead; skipping that wait is
  // the whole point of the memory.
  rememberedVodAudioIndex: (originalUrl: string) => number | null
  // Starts the remembered remux for this title at `audioIndex` — the value
  // rememberedVodAudioIndex just resolved — and keeps the memory truthful around it: a
  // confirmed-working session re-confirms the entry (a fresh confirmedAt, so an entry in
  // active use cannot age out of the oldest-first prune), and a failed one forgets it — the
  // same self-heal live's remembered fix has (the next open re-detects instead of replaying
  // a fix that just failed). Call this only after the caller has paused and detached its
  // video element and waited out the connection-release delay; the session starts ffmpeg
  // immediately, and the detach is what keeps it from racing the account's own connection.
  startRememberedVodFallback: (
    originalUrl: string,
    audioIndex: number,
    onReload: () => void,
    onError?: (message: string) => void
  ) => void
  // The write half for the detection poll's other conclusion: the caller's poll ran its course
  // without confirming the silent-audio symptom, so record { kind: 'direct' } for the current
  // title (a no-op for anything that isn't a movie/series). Records only — nothing reads it
  // back as a reason to skip detection.
  rememberDirectOutcome: (originalUrl: string) => void
  reset: () => void
  beginRun: () => void
  // True once any fallback session — the automatic codec fix above, or a user-chosen
  // switchLiveAudioTrack/switchVodAudioTrack/switchVodSubtitleTrack below — is actually the
  // thing driving playback (i.e. getSourceUrl no longer returns the original URL).
  hasFallbackActive: boolean
  // Live TV's raw stream can carry audio tracks its HLS playlist never advertises at all (see
  // probeLiveAudioTracks' own comment) — hls.js has no way to see, let alone switch to, one of
  // these on its own. null until a probe has actually run.
  liveAudioTracks: AudioTrackInfo[] | null
  probingLiveAudio: boolean
  // Index into liveAudioTracks currently playing via the fallback, or null while still on the
  // original, unprobed/unswitched source.
  activeLiveAudioTrackIndex: number | null
  // How many subtitle streams the same probe found in the raw source — reported for visibility
  // even though there's currently no consumption path for a live subtitle rendition: every real
  // channel sampled on this app's test account had zero, but a caller can at least tell a user
  // "checked, found none" rather than staying silent.
  probedLiveSubtitleTrackCount: number | null
  probeLiveAudioTracks: (originalUrl: string, onError?: (message: string) => void) => Promise<void>
  switchLiveAudioTrack: (
    originalUrl: string,
    trackIndex: number,
    onReload: () => void,
    onError?: (message: string) => void
  ) => void
  // VOD/series equivalent of the live probe above — every audio and subtitle track the file
  // itself actually carries, probed once automatically on load (see probeVodTracks' own
  // comment for why this is proactive/automatic here but manual for Live TV). null until the
  // probe completes.
  vodAudioTracks: AudioTrackInfo[] | null
  vodSubtitleTracks: SubtitleTrackInfo[] | null
  probingVodTracks: boolean
  // 0 by default (whatever plays natively before any explicit choice); -1 means "no subtitle."
  activeVodAudioIndex: number
  activeVodSubtitleIndex: number
  probeVodTracks: (originalUrl: string, onError?: (message: string) => void) => Promise<void>
  switchVodAudioTrack: (
    originalUrl: string,
    audioIndex: number,
    onReload: () => void,
    onError?: (message: string) => void
  ) => void
  switchVodSubtitleTrack: (
    originalUrl: string,
    subtitleIndex: number,
    onReload: () => void,
    onError?: (message: string) => void
  ) => void
} {
  const transcodedUrlRef = useRef<string | null>(null)
  const triedTranscodeRef = useRef(false)
  const awaitingTranscodeRef = useRef(false)
  const transcodeSessionIdRef = useRef<string | null>(null)
  // See MAX_REMUX_CHAIN_RESTARTS — spent restarts for the current channel open, zeroed by reset().
  const chainRestartsUsedRef = useRef(0)
  const [transcoding, setTranscoding] = useState(false)
  const [hasFallbackActive, setHasFallbackActive] = useState(false)
  const [transcodeReason, setTranscodeReason] = useState<'audio' | 'raw-stream' | null>(null)
  const [liveAudioTracks, setLiveAudioTracks] = useState<AudioTrackInfo[] | null>(null)
  const [probingLiveAudio, setProbingLiveAudio] = useState(false)
  const [activeLiveAudioTrackIndex, setActiveLiveAudioTrackIndex] = useState<number | null>(null)
  const [probedLiveSubtitleTrackCount, setProbedLiveSubtitleTrackCount] = useState<number | null>(null)
  const [vodAudioTracks, setVodAudioTracks] = useState<AudioTrackInfo[] | null>(null)
  const [vodSubtitleTracks, setVodSubtitleTracks] = useState<SubtitleTrackInfo[] | null>(null)
  const [probingVodTracks, setProbingVodTracks] = useState(false)
  const [activeVodAudioIndex, setActiveVodAudioIndex] = useState(0)
  const [activeVodSubtitleIndex, setActiveVodSubtitleIndex] = useState(-1)

  // Tell the main process once whether this machine can decode HEVC, so its live remux knows
  // whether an HEVC source may be copied (hvc1-tagged) or has to be re-encoded (see
  // transcodeService's canDecodeHevc). Idempotent, so the several instances of this hook the app
  // runs at once — the player plus every preview and Multi-View tile — can all send it without
  // coordinating.
  useEffect(() => {
    void window.api.transcode.setHevcSupport(clientCanDecodeHevc())
  }, [])

  // Call when the underlying channel/stream identity changes (a genuinely different source,
  // not just a reload of the same one) — resets fallback state and stops any prior session.
  const reset = useCallback(() => {
    triedTranscodeRef.current = false
    awaitingTranscodeRef.current = false
    transcodedUrlRef.current = null
    chainRestartsUsedRef.current = 0
    setHasFallbackActive(false)
    setTranscodeReason(null)
    setLiveAudioTracks(null)
    setProbingLiveAudio(false)
    setActiveLiveAudioTrackIndex(null)
    setProbedLiveSubtitleTrackCount(null)
    setVodAudioTracks(null)
    setVodSubtitleTracks(null)
    setProbingVodTracks(false)
    setActiveVodAudioIndex(0)
    setActiveVodSubtitleIndex(-1)
    const staleSessionId = transcodeSessionIdRef.current
    transcodeSessionIdRef.current = null
    if (staleSessionId) {
      window.api.transcode
        .stop(staleSessionId)
        .catch((err) => console.error('[transcode] failed to stop abandoned session:', err))
    }
  }, [])

  // Call at the top of every hls-(re)attach run — a fresh attempt (first try, or the reload
  // after a successful fallback) always starts with nothing already in flight; it only
  // becomes true again if this run's own error handler kicks one off.
  const beginRun = useCallback(() => {
    awaitingTranscodeRef.current = false
  }, [])

  const getSourceUrl = useCallback((originalUrl: string) => transcodedUrlRef.current ?? originalUrl, [])

  // Writes one remembered outcome into settings, pruning on the way through: every write is a
  // chance for the shared record to have outgrown its cap, and this is its only writer — there
  // is no later sweep, so the bound has to hold here. Goes through the store action like every
  // other setting, so the write rides the normal save/backup paths unchanged.
  const rememberTranscodeOutcome = useCallback((key: string, entry: TranscodeMemoryEntry) => {
    const { settings, updateSettings } = useAppStore.getState()
    updateSettings({ transcodeMemory: pruneTranscodeMemory({ ...settings.transcodeMemory, [key]: entry }) })
  }, [])

  // The removal side (used by the remembered fallback's own self-heal): drop the key if it is
  // present, and skip the settings write entirely when it is not. No prune needed — removing
  // never grows the record.
  const forgetTranscodeOutcome = useCallback((key: string) => {
    const { settings, updateSettings } = useAppStore.getState()
    if (!(key in settings.transcodeMemory)) return
    const transcodeMemory = { ...settings.transcodeMemory }
    delete transcodeMemory[key]
    updateSettings({ transcodeMemory })
  }, [])

  const startFallback = useCallback(
    (
      originalUrl: string,
      isVod: boolean,
      subtitleStreamIndex: number,
      onReload: () => void,
      onError?: (message: string) => void,
      audioStreamIndex = 0,
      reason: 'audio' | 'raw-stream' = 'audio',
      // Runs once the session's output actually exists — the same moment onReload fires. The
      // remembered-outcome writes need success, not intent: recording a fix whose remux then
      // failed would make every later open skip detection and fail the same way with no
      // self-heal. Optional so the live/raw-TS callers, whose own memory lives elsewhere,
      // don't change.
      onStarted?: () => void
    ): void => {
      triedTranscodeRef.current = true
      awaitingTranscodeRef.current = true
      setTranscoding(true)
      setTranscodeReason(reason)
      // Generated here rather than taken from transcode:start's resolved value — spawning
      // ffmpeg and waiting for it to produce output can take up to several minutes for VOD (see
      // startTranscode's deadline in src/main/index.ts), and reset() needs a sessionId to cancel
      // *during* that wait (e.g. the user switches titles before it resolves), not just after.
      // Registering it into the ref
      // immediately, before the IPC call is even made, is what makes that possible — otherwise
      // the old ffmpeg process is orphaned, left running and competing for the account's
      // connection slot with whatever plays next.
      const sessionId = crypto.randomUUID()
      transcodeSessionIdRef.current = sessionId
      window.api.transcode
        .start(originalUrl, isVod, sessionId, subtitleStreamIndex, audioStreamIndex)
        .then(({ url }) => {
          transcodedUrlRef.current = url
          setHasFallbackActive(true)
          setActiveLiveAudioTrackIndex(audioStreamIndex)
          if (isVod) {
            setActiveVodAudioIndex(audioStreamIndex)
            setActiveVodSubtitleIndex(subtitleStreamIndex)
          }
          onStarted?.()
          onReload()
        })
        .catch((err) => {
          awaitingTranscodeRef.current = false
          onError?.(err instanceof Error ? err.message : String(err))
        })
        .finally(() => setTranscoding(false))
    },
    []
  )

  // A full restart of the remux chain for a channel whose fallback ALREADY ran: stops the
  // (dead) session, un-spends the one-shot, and remuxes again from the original URL. The
  // recovery of last resort for the failure shape measured live against this provider: ffmpeg
  // reading a paced live connection dies mid-playlist at unpredictable intervals, the session's
  // playlist freezes, and every existing recovery (hls.js retries, the stall watchdog's reload)
  // just re-attaches the same dead URL — this is the only thing that ever starts a NEW session.
  // Returns false when nothing may be restarted (a recovery is already in flight, or the budget
  // is spent) and the caller should fall through to its terminal error handling.
  const attemptRemuxRecovery = useCallback(
    (originalUrl: string, onReload: () => void, onError?: (message: string) => void): boolean => {
      // A recovery already in flight owns the outcome — true here as well as after an actual
      // restart, so callers treat repeats the same way (clear the error, wait) instead of
      // racing a second restart or declaring failure while the replacement is still spinning
      // up. The stall watchdog can reach its give-up rung during that window.
      if (awaitingTranscodeRef.current) return true
      if (!shouldRestartRemuxChain(false, chainRestartsUsedRef.current)) return false
      chainRestartsUsedRef.current += 1
      const staleSessionId = transcodeSessionIdRef.current
      if (staleSessionId) {
        window.api.transcode
          .stop(staleSessionId)
          .catch((err) => console.error('[transcode] failed to stop dead session before restart:', err))
      }
      triedTranscodeRef.current = false
      transcodedUrlRef.current = null
      setHasFallbackActive(false)
      startFallback(originalUrl, false, 0, onReload, onError, 0, 'raw-stream')
      return true
    },
    [startFallback]
  )

  const tryFallback = useCallback(
    (data: ErrorData, originalUrl: string, onReload: () => void, onError?: (message: string) => void): boolean => {
      // Spinning up ffmpeg takes a few real seconds, during which the still-attached, still-
      // broken hls instance keeps hitting the identical error repeatedly. Once a fix is
      // already in flight there's nothing new to react to.
      if (awaitingTranscodeRef.current) return true
      if (!isUnsupportedAudioCodecError(data) || triedTranscodeRef.current) return false
      startFallback(originalUrl, false, 0, onReload, onError)
      return true
    },
    [startFallback]
  )

  const tryFallbackForRawStream = useCallback(
    (data: ErrorData, originalUrl: string, onReload: () => void, onError?: (message: string) => void): boolean => {
      // Same guard shape as tryFallback above: a fix already in flight owns the outcome, and
      // one attempt per source is all a broken playlist ever gets (repeating a doomed remux on
      // every parse error of the still-broken instance would just stack ffmpeg processes).
      if (awaitingTranscodeRef.current) return true
      // Only a "that was not a playlist" failure may spend that one attempt. Without this check
      // the remux was started for *any* fatal live error — including the remux's own playback
      // failing later (fragLoadError, a codec append error), which then had nothing left to
      // recover with and surfaced as a terminal "Playback error: … (gave up after N retries)".
      // The detector existed and was unit-tested, but was never actually consulted by this call
      // site; this is what makes it real.
      if (!isRawStreamManifestError(data)) return false
      if (triedTranscodeRef.current) return false
      startFallback(originalUrl, false, 0, onReload, onError, 0, 'raw-stream')
      return true
    },
    [startFallback]
  )

  const tryFallbackForSilentAudio = useCallback(
    (originalUrl: string, onReload: () => void, onError?: (message: string) => void, isVod = true): boolean => {
      if (awaitingTranscodeRef.current || triedTranscodeRef.current) return false
      // VOD/series only (live keeps its own liveAudioFixes memory, deliberately untouched by
      // this): the detection just concluded this title needs the remux, so remember the
      // outcome — the next open starts here directly (see rememberedVodAudioIndex).
      // Written on success, not on intent — see startFallback's onStarted.
      const vodKey = isVod ? nowPlayingVodMemoryKey() : null
      startFallback(
        originalUrl,
        isVod,
        0,
        onReload,
        onError,
        0,
        'audio',
        vodKey === null
          ? undefined
          : () =>
              rememberTranscodeOutcome(vodKey, {
                kind: 'audio',
                audioIndex: 0,
                url: originalUrl,
                confirmedAt: Date.now()
              })
      )
      return true
    },
    [startFallback, rememberTranscodeOutcome]
  )

  // The read half of the remembered-outcome memory for movies/series: the audio track the
  // last confirmed outcome says to remux with, when the source about to play still matches
  // the one it was confirmed against (rotated provider token and all — see
  // rememberedAudioIndex). Deliberately does not start anything itself: between this
  // decision and the start, the caller has real work to do — pausing and detaching its video
  // element so the original source stops pulling from the same URL before ffmpeg opens its
  // own connection (the exact contention the silent-audio path's detach exists for), then
  // the connection-release delay. A combined read-and-start had nothing left to pause before
  // its first byte, which is why the two are separable steps.
  //
  // Only an 'audio' entry is acted on, deliberately: a 'direct' entry records a source that
  // played as-is, but the file behind a URL can change — acting on that record would leave a
  // title that has since turned AC-3 silently mute with nothing on screen to explain it.
  // Detection keeps running for 'direct' (this returns null); the record is kept.
  const rememberedVodAudioIndex = useCallback((originalUrl: string): number | null => {
    const key = nowPlayingVodMemoryKey()
    if (key === null) return null
    return rememberedAudioIndex(useAppStore.getState().settings.transcodeMemory, key, originalUrl)
  }, [])

  // The start half: begins the remembered remux at `audioIndex`, re-confirming the entry on
  // success and forgetting it on failure (self-heal — a failed remembered fix must not replay
  // itself on every later open; the next open re-detects and re-records only on success, the
  // same shape as live's own remembered fix). This wrapper only owns the memory bookkeeping
  // around the session; the guard mirrors tryFallbackForSilentAudio's, because a reload of
  // this same title can re-enter before the session resolves, and none of that may stack a
  // second session on top of one already starting (or restart one that already ran).
  const startRememberedVodFallback = useCallback(
    (originalUrl: string, audioIndex: number, onReload: () => void, onError?: (message: string) => void): void => {
      if (awaitingTranscodeRef.current || triedTranscodeRef.current) return
      const key = nowPlayingVodMemoryKey()
      if (key === null) return
      startFallback(
        originalUrl,
        true,
        0,
        onReload,
        (message) => {
          // A failed remembered fix invalidates itself: the next open re-runs detection
          // instead of replaying a fix that just failed identically.
          forgetTranscodeOutcome(key)
          onError?.(message)
        },
        audioIndex,
        'audio',
        () =>
          // Re-confirm on success, refreshing confirmedAt: the prune drops the oldest
          // entries, and an entry being used right now must not age into that group while
          // unused ones sit behind it.
          rememberTranscodeOutcome(key, { kind: 'audio', audioIndex, url: originalUrl, confirmedAt: Date.now() })
      )
    },
    [startFallback, rememberTranscodeOutcome, forgetTranscodeOutcome]
  )

  // The write half for the detection poll's other conclusion: the poll ran its full course
  // without ever confirming the silent-audio symptom, so this title played as-is. Recorded for
  // the memory's own sake (and any later use); nothing reads 'direct' back as a reason to skip
  // detection — see rememberedVodAudioIndex above — and it is a no-op for live content.
  const rememberDirectOutcome = useCallback(
    (originalUrl: string): void => {
      const key = nowPlayingVodMemoryKey()
      if (key === null) return
      rememberTranscodeOutcome(key, { kind: 'direct', url: originalUrl, confirmedAt: Date.now() })
    },
    [rememberTranscodeOutcome]
  )

  // A live channel's actual MPEG-TS multiplex can carry more than one audio elementary stream
  // (a different language, or just a different codec/channel-layout mix like stereo vs. 5.1)
  // with zero #EXT-X-MEDIA entries in its HLS playlist to advertise any of it — HLS's alternate-
  // rendition model only ever exposes what the playlist explicitly declares, so hls.js (see
  // hlsAudioTracks in Player.tsx) has no way to see, let alone switch to, a track the provider's
  // playlist just doesn't mention. Confirmed live against a real account: a provider-labeled
  // "5.1 + Stereo" sports channel's playlist advertised exactly one rendition, while probing the
  // raw stream directly (main process's transcodeService.probeTracks — the same ffmpeg-opens-
  // and-logs-the-source mechanism startTranscode already uses, just without ever writing any
  // output) found three. This is manual (a button, not automatic-on-every-channel) rather than
  // probing every live channel on open: it's a second connection to the origin, and on a large
  // account (this app's own test account runs ~24k live channels) or a single-connection-capped
  // provider, doing that unprompted for every channel switch isn't worth it for what's usually a
  // "no" answer — most channels genuinely do only carry the one track their playlist claims.
  const probeLiveAudioTracks = useCallback(
    async (originalUrl: string, onError?: (message: string) => void): Promise<void> => {
      setProbingLiveAudio(true)
      try {
        const { audioTracks, subtitleTracks: probedSubtitles } = await window.api.transcode.probeTracks(originalUrl)
        setLiveAudioTracks(audioTracks)
        setProbedLiveSubtitleTrackCount(probedSubtitles.length)
      } catch (err) {
        onError?.(err instanceof Error ? err.message : String(err))
      } finally {
        setProbingLiveAudio(false)
      }
    },
    []
  )

  // Unlike switchVodAudioTrack below, this never has an "off"/native state to cycle back to
  // once engaged — once a specific raw audio track is chosen, playback keeps coming from the
  // ffmpeg remux (there's no free way back to the original hls.js source without a full player
  // reload onto nowPlaying.url, which Player.tsx already offers via a channel switch/reopen).
  const switchLiveAudioTrack = useCallback(
    (originalUrl: string, trackIndex: number, onReload: () => void, onError?: (message: string) => void): void => {
      const staleSessionId = transcodeSessionIdRef.current
      if (staleSessionId) {
        window.api.transcode
          .stop(staleSessionId)
          .catch((err) => console.error('[transcode] failed to stop session before switching audio track:', err))
      }
      // subtitleStreamIndex 0 here doesn't map a subtitle — Live TV's argv only ever requests
      // one when isVod is true (see transcodeService.ts's startTranscode), which this call
      // deliberately never is.
      startFallback(originalUrl, false, 0, onReload, onError, trackIndex)
    },
    [startFallback]
  )

  // VOD/series gets this proactively, on load, unlike Live TV's manual button — the cost/benefit
  // is genuinely different here: a user watches one movie for an hour-plus (the probe's one-off
  // connection cost is trivially amortized), versus Live TV's own 24k-channel catalog where
  // probing every channel on every switch unprompted would add up fast for what's usually a "no"
  // answer. Uses the exact same main-process probeTracks Live TV's own manual check does — a
  // lightweight, output-less ffmpeg pass, not a real transcode — so this never touches playback
  // on its own; only actually picking a non-default option from either dropdown does that (see
  // switchVodAudioTrack/switchVodSubtitleTrack below).
  const probeVodTracks = useCallback(async (originalUrl: string, onError?: (message: string) => void): Promise<void> => {
    setProbingVodTracks(true)
    try {
      const { audioTracks, subtitleTracks: subs } = await window.api.transcode.probeTracks(originalUrl)
      setVodAudioTracks(audioTracks)
      setVodSubtitleTracks(subs)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err))
    } finally {
      setProbingVodTracks(false)
    }
  }, [])

  // Restarts the whole transcode fallback to remux a specific raw audio track (same underlying
  // mechanism as switchLiveAudioTrack, just isVod: true) — carries the currently-selected
  // subtitle track (if any) along unchanged, rather than resetting it back to "off" every time
  // only the audio pick changes.
  const switchVodAudioTrack = useCallback(
    (originalUrl: string, audioIndex: number, onReload: () => void, onError?: (message: string) => void): void => {
      const staleSessionId = transcodeSessionIdRef.current
      if (staleSessionId) {
        window.api.transcode
          .stop(staleSessionId)
          .catch((err) => console.error('[transcode] failed to stop session before switching VOD audio track:', err))
      }
      startFallback(originalUrl, true, activeVodSubtitleIndex, onReload, onError, audioIndex)
    },
    [startFallback, activeVodSubtitleIndex]
  )

  // Same idea, the other direction — carries the currently-selected audio track along
  // unchanged. subtitleIndex of -1 means "off," matching startTranscode's own convention for
  // "no subtitle at all" (see transcodeService.ts).
  const switchVodSubtitleTrack = useCallback(
    (originalUrl: string, subtitleIndex: number, onReload: () => void, onError?: (message: string) => void): void => {
      const staleSessionId = transcodeSessionIdRef.current
      if (staleSessionId) {
        window.api.transcode
          .stop(staleSessionId)
          .catch((err) => console.error('[transcode] failed to stop session before switching VOD subtitle track:', err))
      }
      startFallback(originalUrl, true, subtitleIndex, onReload, onError, activeVodAudioIndex)
    },
    [startFallback, activeVodAudioIndex]
  )

  return {
    transcoding,
    getSourceUrl,
    tryFallback,
    tryFallbackForRawStream,
    transcodeReason,
    attemptRemuxRecovery,
    tryFallbackForSilentAudio,
    rememberedVodAudioIndex,
    startRememberedVodFallback,
    rememberDirectOutcome,
    reset,
    beginRun,
    hasFallbackActive,
    liveAudioTracks,
    probingLiveAudio,
    activeLiveAudioTrackIndex,
    probedLiveSubtitleTrackCount,
    probeLiveAudioTracks,
    switchLiveAudioTrack,
    vodAudioTracks,
    vodSubtitleTracks,
    probingVodTracks,
    activeVodAudioIndex,
    activeVodSubtitleIndex,
    probeVodTracks,
    switchVodAudioTrack,
    switchVodSubtitleTrack
  }
}
