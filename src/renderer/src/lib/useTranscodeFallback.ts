import { useCallback, useRef, useState } from 'react'
import type { ErrorData } from 'hls.js'

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
  // mapped, not just that track. switchSubtitleTrack only ever cycles through supported tracks;
  // this still reports the unsupported ones too so the UI could explain why one isn't offered.
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
  tryFallbackForSilentAudio: (originalUrl: string, onReload: () => void, onError?: (message: string) => void) => boolean
  reset: () => void
  beginRun: () => void
  // Every subtitle track this fallback's ffmpeg process found in the source — not necessarily
  // the one currently active (see activeSubtitleTrackIndex) or even mappable simultaneously: see
  // switchSubtitleTrack's own comment for why this app's ffmpeg build can only ever carry one at
  // a time. Empty for Live TV and for any VOD/series title with no embedded subtitles at all.
  subtitleTracks: SubtitleTrackInfo[]
  activeSubtitleTrackIndex: number
  switchSubtitleTrack: (originalUrl: string, onReload: () => void, onError?: (message: string) => void) => void
  // True once any fallback session — the automatic codec fix above, or a user-chosen
  // switchLiveAudioTrack below — is actually the thing driving playback (i.e. getSourceUrl no
  // longer returns the original URL). Lets a caller avoid offering to probe/switch audio tracks
  // while already playing a remuxed source.
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
  // even though there's currently no consumption path for a live subtitle rendition (see this
  // hook's own module comment): every real channel sampled on this app's test account had zero,
  // but a caller can at least tell a user "checked, found none" rather than staying silent.
  probedLiveSubtitleTrackCount: number | null
  probeLiveAudioTracks: (originalUrl: string, onError?: (message: string) => void) => Promise<void>
  switchLiveAudioTrack: (
    originalUrl: string,
    trackIndex: number,
    onReload: () => void,
    onError?: (message: string) => void
  ) => void
} {
  const transcodedUrlRef = useRef<string | null>(null)
  const triedTranscodeRef = useRef(false)
  const awaitingTranscodeRef = useRef(false)
  const transcodeSessionIdRef = useRef<string | null>(null)
  const [transcoding, setTranscoding] = useState(false)
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrackInfo[]>([])
  const [activeSubtitleTrackIndex, setActiveSubtitleTrackIndex] = useState(0)
  const [hasFallbackActive, setHasFallbackActive] = useState(false)
  const [liveAudioTracks, setLiveAudioTracks] = useState<AudioTrackInfo[] | null>(null)
  const [probingLiveAudio, setProbingLiveAudio] = useState(false)
  const [activeLiveAudioTrackIndex, setActiveLiveAudioTrackIndex] = useState<number | null>(null)
  const [probedLiveSubtitleTrackCount, setProbedLiveSubtitleTrackCount] = useState<number | null>(null)

  // Call when the underlying channel/stream identity changes (a genuinely different source,
  // not just a reload of the same one) — resets fallback state and stops any prior session.
  const reset = useCallback(() => {
    triedTranscodeRef.current = false
    awaitingTranscodeRef.current = false
    transcodedUrlRef.current = null
    setSubtitleTracks([])
    setActiveSubtitleTrackIndex(0)
    setHasFallbackActive(false)
    setLiveAudioTracks(null)
    setProbingLiveAudio(false)
    setActiveLiveAudioTrackIndex(null)
    setProbedLiveSubtitleTrackCount(null)
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

  const startFallback = useCallback(
    (
      originalUrl: string,
      isVod: boolean,
      subtitleStreamIndex: number,
      onReload: () => void,
      onError?: (message: string) => void,
      audioStreamIndex = 0
    ): void => {
      triedTranscodeRef.current = true
      awaitingTranscodeRef.current = true
      setTranscoding(true)
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
        .then(({ url, subtitleTracks: tracks }) => {
          transcodedUrlRef.current = url
          setSubtitleTracks(tracks)
          setActiveSubtitleTrackIndex(subtitleStreamIndex)
          setHasFallbackActive(true)
          setActiveLiveAudioTrackIndex(audioStreamIndex)
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

  const tryFallbackForSilentAudio = useCallback(
    (originalUrl: string, onReload: () => void, onError?: (message: string) => void): boolean => {
      if (awaitingTranscodeRef.current || triedTranscodeRef.current) return false
      startFallback(originalUrl, true, 0, onReload, onError)
      return true
    },
    [startFallback]
  )

  // A real, live-confirmed limitation of this app's bundled ffmpeg build (14 isolated synthetic
  // test variations, all failing identically with "No streams to mux were specified"): it
  // cannot produce more than one independent subtitle rendition per invocation, whether via
  // -var_stream_map's sgroup feature or separate -f hls outputs. Switching languages therefore
  // means stopping the current transcode session and starting an entirely new one mapping a
  // different subtitle stream index — genuinely re-paying startTranscode's own 25-90s-observed
  // reopen cost, not a free client-side switch the way the CC on/off toggle in Player.tsx is.
  const switchSubtitleTrack = useCallback(
    (originalUrl: string, onReload: () => void, onError?: (message: string) => void): void => {
      // Only ever cycles through tracks ffmpeg's webvtt encoder can actually convert — a bitmap
      // codec (PGS, VobSub, ...) crashes the entire transcode if mapped (confirmed live against
      // a real file), not just that track, so it must never be something this can switch to.
      const supportedTracks = subtitleTracks.filter((t) => t.supported)
      if (supportedTracks.length < 2) return
      const currentPosition = supportedTracks.findIndex((t) => t.index === activeSubtitleTrackIndex)
      const next = supportedTracks[(currentPosition + 1) % supportedTracks.length]
      const staleSessionId = transcodeSessionIdRef.current
      if (staleSessionId) {
        window.api.transcode
          .stop(staleSessionId)
          .catch((err) => console.error('[transcode] failed to stop session before switching subtitle track:', err))
      }
      // Always isVod: subtitleTracks is only ever populated by a VOD/series fallback session in
      // the first place (see transcodeService.ts — Live's argv never requests a subtitle track,
      // so it never has more than one to switch between).
      startFallback(originalUrl, true, next.index, onReload, onError)
    },
    [startFallback, subtitleTracks, activeSubtitleTrackIndex]
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

  // Unlike switchSubtitleTrack above, this never has an "off"/native state to cycle back to
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

  return {
    transcoding,
    getSourceUrl,
    tryFallback,
    tryFallbackForSilentAudio,
    reset,
    beginRun,
    subtitleTracks,
    activeSubtitleTrackIndex,
    switchSubtitleTrack,
    hasFallbackActive,
    liveAudioTracks,
    probingLiveAudio,
    activeLiveAudioTrackIndex,
    probedLiveSubtitleTrackCount,
    probeLiveAudioTracks,
    switchLiveAudioTrack
  }
}
