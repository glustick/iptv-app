import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { useAppStore } from '../store/useAppStore'
import { PlayerChannelBar } from './PlayerChannelBar'
import { PlayerStatsOverlay } from './PlayerStatsOverlay'
import { PlayerSeekBar } from './PlayerSeekBar'
import { useTranscodeFallback } from '../lib/useTranscodeFallback'

const MAX_NETWORK_RETRIES = 4
const MAX_MEDIA_ERROR_RECOVERIES = 3
const MEDIA_ERROR_RESET_AFTER_MS = 15000
const PROGRESS_SAVE_INTERVAL_MS = 5000
const CHANNEL_BAR_AUTO_HIDE_MS = 6000
const SKIP_SECONDS = 10
const SKIP_SECONDS_LONG = 60
// How often (and for how long) to poll for the "video decoding, audio never has" symptom — see
// the detection code in the main playback effect for why this is a poll rather than one check.
// The attempt budget has to cover how long a title takes to even START decoding, not just how
// long detection itself needs — confirmed with a real ~10GB movie file that took ~20s of
// initial buffering before video decoding began at all (a smaller live-TV segment starts in a
// couple of seconds), which alone would exhaust a 20-attempt/20s budget before the 2-consecutive-
// silent-tick check ever got a chance to run.
const SILENT_AUDIO_CHECK_INTERVAL_MS = 1000
const SILENT_AUDIO_MAX_CHECK_ATTEMPTS = 90
// Some Xtream accounts cap concurrent connections at exactly 1 (confirmed against the real test
// account via get_server_info — max_connections: "1") — pausing/detaching the original <video>
// stops the browser from requesting more of it, but doesn't guarantee the origin server has
// actually recognized that connection as closed by the time ffmpeg tries to open a new one.
// Racing that gap produced a real net::ERR_HTTP2_PROTOCOL_ERROR and, worse, a transcode request
// that hung indefinitely with zero output on this exact account. This delay gives the origin a
// moment to actually release the slot first.
const CONNECTION_RELEASE_DELAY_MS = 2000

// webkitVideoDecodedByteCount/webkitAudioDecodedByteCount are real, long-standing Chromium
// extensions, not in the standard DOM lib types — same ones PlayerStatsOverlay.tsx already
// relies on to display live decode stats, reused here to detect the failure automatically
// instead of just reporting it after the fact.
interface ChromiumVideoElement extends HTMLVideoElement {
  webkitVideoDecodedByteCount?: number
  webkitAudioDecodedByteCount?: number
}
// Click-zone thresholds for fullscreen mode, in pixels from the respective screen edge —
// roughly matched to the header's own height and the channel bar's (see CHANNEL_BAR height in
// global.css) so each zone lines up with the chrome it reveals rather than an arbitrary split.
// Deliberately independent from SEEKBAR_REVEAL_ZONE_FRACTION just below, even though both sit
// near the bottom edge: this one is click-triggered and fullscreen-only (opens the EPG channel
// bar), while the seek bar's is hover-triggered and applies in windowed mode too — a fixed
// pixel count wouldn't scale sensibly there. They don't currently conflict (a click still
// reaches the video first; the seek bar only intercepts a much thinner strip right at its own
// edge), but if either threshold changes, sanity-check the other still makes sense next to it.
const FULLSCREEN_BOTTOM_ZONE_PX = 220
const FULLSCREEN_TOP_ZONE_PX = 80
// The seek bar itself reveals on hover/cursor position (not click, unlike the header/channel
// bar above) — a fraction of the player's own height rather than a fixed pixel count so it
// scales sensibly whether the player is windowed or truly fullscreen.
const SEEKBAR_REVEAL_ZONE_FRACTION = 0.2

export function Player(): JSX.Element | null {
  const nowPlaying = useAppStore((s) => s.nowPlaying)
  const stop = useAppStore((s) => s.stop)
  const bufferProfile = useAppStore((s) => s.settings.bufferProfile)
  const persistedVolume = useAppStore((s) => s.settings.playerVolume)
  const persistedMuted = useAppStore((s) => s.settings.playerMuted)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const episodeProgress = useAppStore((s) => s.episodeProgress)
  const updateEpisodeProgress = useAppStore((s) => s.updateEpisodeProgress)
  const isOnline = useAppStore((s) => s.isOnline)
  const showChannelBar = useAppStore((s) => s.channelBarOpen)
  const setShowChannelBar = useAppStore((s) => s.setChannelBarOpen)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  const playerRef = useRef<HTMLDivElement | null>(null)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [buffering, setBuffering] = useState(false)
  const [pipActive, setPipActive] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [fullscreenHeaderVisible, setFullscreenHeaderVisible] = useState(false)
  const [statsVisible, setStatsVisible] = useState(false)
  const [cursorNearBottom, setCursorNearBottom] = useState(false)
  const wasOffline = useRef(false)
  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastStreamKeyRef = useRef<string | null>(null)

  const {
    transcoding,
    getSourceUrl,
    tryFallback,
    tryFallbackForSilentAudio,
    reset: resetTranscodeFallback,
    beginRun: beginTranscodeRun
  } = useTranscodeFallback()

  // Channel identity changing (including to nothing, i.e. the player closing) is the only
  // thing that should reset the transcode-fallback state or tear down a session — a fresh
  // hls reload of the SAME channel (network reconnect, the fallback's own reload) must not.
  // Deliberately its own effect, decoupled from the main playback effect's other triggers
  // (bufferProfile, reloadTick), so those don't also reset this.
  useEffect(() => {
    const streamKey = nowPlaying ? `${nowPlaying.kind}:${nowPlaying.streamId}` : null
    if (streamKey === lastStreamKeyRef.current) return
    lastStreamKeyRef.current = streamKey
    resetTranscodeFallback()
  }, [nowPlaying, resetTranscodeFallback])

  // Auto-reconnect: if the whole network dropped (not just this fragment), hls.js's own
  // retry budget may already be exhausted by the time connectivity returns. Force a fresh
  // attach once we're back online rather than leaving a dead player up.
  useEffect(() => {
    if (!isOnline) {
      wasOffline.current = true
    } else if (wasOffline.current) {
      wasOffline.current = false
      if (nowPlaying) setReloadTick((t) => t + 1)
    }
  }, [isOnline, nowPlaying])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !nowPlaying) return

    // A fresh <video> element (the player was just opened, or reopened after being fully
    // closed) always starts at the browser's own defaults (volume 1, unmuted) — reapplying the
    // last-used values here on every run of this effect is safe even for an internal reload of
    // the same channel (network reconnect, transcode fallback) or a channel switch, since
    // persistedVolume/persistedMuted already reflect whatever the user last set in real time
    // (see the volumechange-driven updateSettings call below).
    video.volume = persistedVolume
    video.muted = persistedMuted

    setPlaybackError(null)
    setBuffering(true)
    beginTranscodeRun()
    let networkRetryCount = 0
    let mediaErrorRecoveryCount = 0
    let mediaErrorResetTimer: ReturnType<typeof setTimeout> | null = null
    let progressInterval: ReturnType<typeof setInterval> | null = null
    let silentAudioCheckTimer: ReturnType<typeof setInterval> | null = null

    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    const handleWaiting = (): void => {
      setBuffering(true)
      // Still recovering — don't let a stretch of genuinely uninterrupted playback earlier
      // in the session forgive a media error that's actively recurring right now.
      if (mediaErrorResetTimer) {
        clearTimeout(mediaErrorResetTimer)
        mediaErrorResetTimer = null
      }
    }
    const handlePlaying = (): void => {
      setBuffering(false)
      // A stretch of real, uninterrupted playback means whatever caused an earlier media
      // error is very likely no longer happening — reset the recovery count so a later,
      // unrelated blip gets its own full set of attempts instead of inheriting exhausted
      // ones from a problem that already resolved itself.
      if (mediaErrorResetTimer) clearTimeout(mediaErrorResetTimer)
      mediaErrorResetTimer = setTimeout(() => {
        mediaErrorRecoveryCount = 0
      }, MEDIA_ERROR_RESET_AFTER_MS)
    }
    const handleCanPlay = (): void => setBuffering(false)
    video.addEventListener('waiting', handleWaiting)
    video.addEventListener('playing', handlePlaying)
    video.addEventListener('canplay', handleCanPlay)

    // Resume series episodes where you left off.
    if (nowPlaying.kind === 'series') {
      const saved = episodeProgress[nowPlaying.streamId]
      if (saved && saved.durationSeconds > 0 && saved.positionSeconds < saved.durationSeconds * 0.95) {
        const resumeAt = saved.positionSeconds
        const onLoadedMetadata = (): void => {
          video.currentTime = resumeAt
        }
        video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true })
      }
      progressInterval = setInterval(() => {
        if (video.duration > 0 && !Number.isNaN(video.duration)) {
          updateEpisodeProgress(String(nowPlaying.streamId), video.currentTime, video.duration)
        }
      }, PROGRESS_SAVE_INTERVAL_MS)
    }

    // Falls back to the ffmpeg-transcoded output for this exact channel once one exists —
    // set by the ERROR handler below the first time it detects an unsupported audio codec.
    const sourceUrl = getSourceUrl(nowPlaying.url)
    const isM3u8 = sourceUrl.endsWith('.m3u8')

    if (isM3u8 && Hls.isSupported()) {
      const smooth = bufferProfile === 'smooth'
      const hls = new Hls({
        enableWorker: true,
        // "Smooth" favors stutter-free playback over sitting right on the live edge: a
        // generous buffer absorbs brief network hiccups at the cost of a few seconds of
        // extra latency. "Low latency" trades that back for staying closer to real-time.
        maxBufferLength: smooth ? 60 : 20,
        maxMaxBufferLength: smooth ? 120 : 40,
        backBufferLength: smooth ? 90 : 30,
        liveSyncDurationCount: smooth ? 5 : 3,
        liveMaxLatencyDurationCount: smooth ? 10 : 6,
        fragLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        manifestLoadingMaxRetry: 6
      })
      hlsRef.current = hls
      hls.loadSource(sourceUrl)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_event, data) => {
        // Try transcoding once for the EC-3/AC-3-shaped failure (see useTranscodeFallback)
        // before falling through to either path's normal (terminal) error handling — and
        // ignore repeats of it while a fix is already in flight, since ffmpeg takes a few
        // real seconds to spin up and this same still-broken hls instance keeps hitting the
        // identical error meanwhile.
        if (
          tryFallback(
            data,
            nowPlaying.url,
            () => setReloadTick((t) => t + 1),
            (message) => setPlaybackError(`Audio codec not supported by this player, and automatic transcoding failed: ${message}`)
          )
        ) {
          setPlaybackError(null)
          return
        }

        if (!data.fatal) {
          // A codec/append error scoped to a single SourceBuffer (very often the audio
          // track — e.g. an AC-3/E-AC-3 feed, which Chromium has no decoder for) can
          // silently kill just that track while video keeps playing fine, with nothing
          // else ever surfacing the problem. Call it out explicitly instead.
          if (data.details === 'bufferAddCodecError' || data.details === 'bufferAppendError') {
            const isAudio = typeof data.mimeType === 'string' && data.mimeType.toLowerCase().includes('audio')
            setPlaybackError(
              `${isAudio ? 'Audio' : 'Video'} codec not supported by this player. This channel's ${isAudio ? 'audio' : 'video'} stream isn't compatible with this app's playback engine${isAudio ? ' (commonly AC-3/E-AC-3 audio, which this app cannot decode)' : ''}.`
            )
          }
          return
        }
        console.error(
          '[player] fatal hls error',
          JSON.stringify({
            type: data.type,
            details: data.details,
            reason: data.reason,
            err: data.error?.message,
            levelIndex: data.level,
            frag: data.frag ? { sn: data.frag.sn, url: data.frag.url, level: data.frag.level } : undefined
          })
        )
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            networkRetryCount += 1
            if (networkRetryCount <= MAX_NETWORK_RETRIES) {
              hls.startLoad()
            } else {
              setPlaybackError(`Playback error: ${data.details} (gave up after ${MAX_NETWORK_RETRIES} retries)`)
              hls.destroy()
            }
            break
          case Hls.ErrorTypes.MEDIA_ERROR:
            // recoverMediaError() alone has no retry cap, so a persistent (non-transient)
            // media error — some channels hit one consistently, not just as a rare blip —
            // recovers, immediately re-fails, and recovers again in a tight loop: every
            // cycle briefly resets and re-seeks the video, which is what actually produces
            // the visible flicker, not the buffering itself. Escalate instead of looping
            // forever, matching hls.js's own recommended recovery pattern.
            mediaErrorRecoveryCount += 1
            if (mediaErrorRecoveryCount > MAX_MEDIA_ERROR_RECOVERIES) {
              setPlaybackError(
                `Playback error: ${data.details} (gave up after ${MAX_MEDIA_ERROR_RECOVERIES} recovery attempts)`
              )
              hls.destroy()
            } else if (mediaErrorRecoveryCount === 2) {
              hls.swapAudioCodec()
              hls.recoverMediaError()
            } else {
              hls.recoverMediaError()
            }
            break
          default:
            setPlaybackError(`Playback error: ${data.details}`)
            hls.destroy()
        }
      })
      video.play().catch(() => {})
    } else {
      video.src = nowPlaying.url
      video.play().catch(() => {})

      // VOD/series have no hls.js instance and therefore no ERROR event — an unsupported
      // (typically AC-3/E-AC-3) audio track doesn't fail visibly here the way it does for live
      // TV: Chromium just decodes the video track fine and silently produces no sound at all,
      // with nothing on video.error or in the console to say so. Polling is the only way to
      // catch it. A single fixed-delay check turned out to be fragile in practice — how long a
      // title takes to actually start decoding varies (network conditions, file size), and a
      // check that lands before video decoding has even begun looks identical to a genuinely
      // silent title and never gets a second chance. Polling instead: wait for video to
      // definitely be decoding, then require two consecutive ticks of "video yes, audio no"
      // before concluding it's the codec failure rather than a brief startup race, and give up
      // after a while if video decoding never gets going at all (a different problem).
      let consecutiveSilentAudioTicks = 0
      let silentAudioCheckAttempts = 0
      silentAudioCheckTimer = setInterval(() => {
        silentAudioCheckAttempts += 1
        const chromiumVideo = video as ChromiumVideoElement
        const videoBytes = chromiumVideo.webkitVideoDecodedByteCount ?? 0
        const audioBytes = chromiumVideo.webkitAudioDecodedByteCount ?? 0
        consecutiveSilentAudioTicks = videoBytes > 0 && audioBytes === 0 ? consecutiveSilentAudioTicks + 1 : 0

        if (consecutiveSilentAudioTicks < 2 && silentAudioCheckAttempts < SILENT_AUDIO_MAX_CHECK_ATTEMPTS) return
        if (silentAudioCheckTimer) clearInterval(silentAudioCheckTimer)
        silentAudioCheckTimer = null
        if (consecutiveSilentAudioTicks < 2) return

        // Unlike live TV (where the hls.js source triggering tryFallback is already broken and
        // has mostly stopped pulling data by the time it fires), this video is playing fine —
        // it just has no sound — so left alone it keeps aggressively buffering ahead from the
        // original URL for the entire time ffmpeg is also reading that same URL through the
        // same local proxy. Two concurrent requests for the same resource that way was enough
        // to trip a real net::ERR_HTTP2_PROTOCOL_ERROR against this provider — pausing and
        // detaching the source first, before asking for the transcode, avoids the contention
        // instead of hoping the origin tolerates it. See CONNECTION_RELEASE_DELAY_MS for why
        // starting the transcode itself is also delayed, not just the detach.
        video.pause()
        video.removeAttribute('src')
        video.load()

        silentAudioCheckTimer = setTimeout(() => {
          silentAudioCheckTimer = null
          tryFallbackForSilentAudio(
            nowPlaying.url,
            () => setReloadTick((t) => t + 1),
            (message) => setPlaybackError(`Audio codec not supported by this player, and automatic transcoding failed: ${message}`)
          )
        }, CONNECTION_RELEASE_DELAY_MS)
      }, SILENT_AUDIO_CHECK_INTERVAL_MS)
    }

    return () => {
      video.removeEventListener('waiting', handleWaiting)
      video.removeEventListener('playing', handlePlaying)
      video.removeEventListener('canplay', handleCanPlay)
      if (mediaErrorResetTimer) clearTimeout(mediaErrorResetTimer)
      if (progressInterval) clearInterval(progressInterval)
      if (silentAudioCheckTimer) clearInterval(silentAudioCheckTimer)
      if (nowPlaying.kind === 'series' && video.duration > 0 && !Number.isNaN(video.duration)) {
        updateEpisodeProgress(String(nowPlaying.streamId), video.currentTime, video.duration)
      }
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowPlaying, bufferProfile, reloadTick])

  // The channel bar auto-hides after a few seconds of inactivity, like a real set-top
  // box's channel banner. Re-armed whenever it's shown or a channel is picked from it.
  useEffect(() => {
    if (autoHideTimer.current) clearTimeout(autoHideTimer.current)
    if (!showChannelBar) return
    autoHideTimer.current = setTimeout(() => setShowChannelBar(false), CHANNEL_BAR_AUTO_HIDE_MS)
    return () => {
      if (autoHideTimer.current) clearTimeout(autoHideTimer.current)
    }
  }, [showChannelBar, nowPlaying])

  // The channel bar only makes sense for live TV — hide it if playback switches to
  // something else (e.g. a series episode played from elsewhere while it was open).
  useEffect(() => {
    if (nowPlaying?.kind !== 'live') setShowChannelBar(false)
  }, [nowPlaying])

  // Keyboard shortcuts while the player is open: M to mute, arrows for volume, and (live only,
  // matching the header's transport buttons — VOD/series already get Space/arrow-seek for free
  // from the native <video controls>) Space for play/pause, left/right arrows to skip (shift
  // for the 60s jump — the common "small step / big step" convention), and End to jump to live.
  // Escape is deliberately not handled here — see App.tsx's single centralized Escape handler,
  // which already covers closing the channel bar and the player itself in the right order.
  useEffect(() => {
    if (!nowPlaying) return
    const kind = nowPlaying.kind
    function onKeyDown(e: KeyboardEvent): void {
      const video = videoRef.current
      if (!video) return
      if (e.key === 'm' || e.key === 'M') {
        video.muted = !video.muted
      } else if (e.key === 'ArrowUp') {
        video.volume = Math.min(1, video.volume + 0.05)
        e.preventDefault()
      } else if (e.key === 'ArrowDown') {
        video.volume = Math.max(0, video.volume - 0.05)
        e.preventDefault()
      } else if (kind === 'live' && e.key === ' ') {
        e.preventDefault()
        togglePlayPause()
      } else if (kind === 'live' && e.key === 'ArrowLeft') {
        e.preventDefault()
        skip(e.shiftKey ? -SKIP_SECONDS_LONG : -SKIP_SECONDS)
      } else if (kind === 'live' && e.key === 'ArrowRight') {
        e.preventDefault()
        skip(e.shiftKey ? SKIP_SECONDS_LONG : SKIP_SECONDS)
      } else if (kind === 'live' && e.key === 'End') {
        e.preventDefault()
        goToLive()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [nowPlaying])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onEnterPip = (): void => setPipActive(true)
    const onLeavePip = (): void => setPipActive(false)
    video.addEventListener('enterpictureinpicture', onEnterPip)
    video.addEventListener('leavepictureinpicture', onLeavePip)
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnterPip)
      video.removeEventListener('leavepictureinpicture', onLeavePip)
    }
  }, [nowPlaying])

  // Keeps the header's play/pause and volume controls in sync regardless of what actually
  // changed them — the video element's own state (a native-control click for VOD/series, the
  // M/arrow-key shortcuts, or these new buttons) rather than assuming this UI is the only
  // mutator of paused/muted/volume.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const syncPlayState = (): void => setPaused(video.paused)
    const syncVolumeState = (): void => {
      setMuted(video.muted)
      setVolume(video.volume)
      // Persisted regardless of what changed it (slider, mute button, M key, or a native VOD
      // control) so the next time the player opens — this channel, a different one, or after a
      // full app restart — it picks up wherever the user last left the volume.
      updateSettings({ playerVolume: video.volume, playerMuted: video.muted })
    }
    syncPlayState()
    syncVolumeState()
    video.addEventListener('play', syncPlayState)
    video.addEventListener('pause', syncPlayState)
    video.addEventListener('volumechange', syncVolumeState)
    return () => {
      video.removeEventListener('play', syncPlayState)
      video.removeEventListener('pause', syncPlayState)
      video.removeEventListener('volumechange', syncVolumeState)
    }
  }, [nowPlaying, updateSettings])

  // document.fullscreenElement (not a per-window Electron API) is what actually toggles here —
  // requestFullscreen() targets this player's own container, not the OS window, so the app's
  // title bar/other windows are untouched; only this element grows to fill the screen.
  useEffect(() => {
    const onFullscreenChange = (): void => setIsFullscreen(document.fullscreenElement === playerRef.current)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  // The header starts hidden every time fullscreen is entered (revealed only by clicking the
  // top edge — see handlePlayAreaClick) and is simply always visible again once fullscreen
  // ends, matching its normal in-flow, always-on windowed-mode appearance.
  useEffect(() => {
    setFullscreenHeaderVisible(!isFullscreen)
  }, [isFullscreen])

  // The seek bar (unlike the header/channel bar, which are click-toggled) reveals purely on
  // cursor position — it's meant to be glanceable without an extra click, but shouldn't sit
  // permanently over the picture either. Booleans bail out of re-rendering when the new value
  // matches the current one, so this is cheap even at native mousemove frequency.
  useEffect(() => {
    const container = playerRef.current
    if (!container || nowPlaying?.kind !== 'live') return
    function onMouseMove(e: MouseEvent): void {
      const rect = container!.getBoundingClientRect()
      setCursorNearBottom(e.clientY > rect.top + rect.height * (1 - SEEKBAR_REVEAL_ZONE_FRACTION))
    }
    container.addEventListener('mousemove', onMouseMove)
    return () => container.removeEventListener('mousemove', onMouseMove)
  }, [nowPlaying])

  // Picture-in-Picture opens a genuine floating OS window (confirmed: it renders on top of
  // other apps, not just inside this one) tied to this video element — closing the player or
  // switching channels while it's open would otherwise leave that window floating on the
  // desktop indefinitely, frozen on the last decoded frame, since nothing else ever tells the
  // OS to close it once the underlying video is torn down. Deliberately scoped to [nowPlaying]
  // only (not bufferProfile/reloadTick) so an internal same-channel reload — a network
  // reconnect, the audio-transcode fallback — doesn't unexpectedly kick the user out of PiP.
  useEffect(() => {
    const video = videoRef.current
    return () => {
      if (video && document.pictureInPictureElement === video) {
        document.exitPictureInPicture().catch(() => {})
      }
    }
  }, [nowPlaying])

  // Same reasoning as the PiP cleanup above: closing the player or switching channels while
  // fullscreen would otherwise leave the OS in fullscreen mode with nothing meaningful behind
  // it (the player itself is what's fullscreened, not the whole app window).
  useEffect(() => {
    return () => {
      if (document.fullscreenElement === playerRef.current) {
        document.exitFullscreen().catch(() => {})
      }
    }
  }, [nowPlaying])

  if (!nowPlaying) return null

  async function togglePip(): Promise<void> {
    const video = videoRef.current
    if (!video) return
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture()
      } else {
        await video.requestPictureInPicture()
      }
    } catch {
      // PiP can reject if the video isn't ready yet or the platform doesn't support it —
      // not worth surfacing as an error, the button just won't visibly do anything.
    }
  }

  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await playerRef.current?.requestFullscreen()
      }
    } catch {
      // Same rationale as PiP above — not worth surfacing as a user-facing error.
    }
  }

  function togglePlayPause(): void {
    const video = videoRef.current
    if (!video) return
    if (video.paused) video.play().catch(() => {})
    else video.pause()
  }

  // Clamped to the video's own seekable range rather than an arbitrary bound — for a live HLS
  // stream that's the DVR buffer hls.js maintains (so this doubles as an "instant replay"/
  // catch-up-within-the-buffer control), and for VOD/series it's just [0, duration].
  function skip(deltaSeconds: number): void {
    const video = videoRef.current
    if (!video || video.seekable.length === 0) return
    const target = video.currentTime + deltaSeconds
    const min = video.seekable.start(0)
    const max = video.seekable.end(video.seekable.length - 1)
    video.currentTime = Math.min(max, Math.max(min, target))
  }

  // The end of the seekable range IS the live edge for a live HLS stream — hls.js keeps
  // extending it as new segments arrive, so jumping here after skip()ping backward (or just
  // falling behind from buffering) genuinely returns to the current transmission, not a fixed
  // point that drifts stale.
  function goToLive(): void {
    const video = videoRef.current
    if (!video || video.seekable.length === 0) return
    video.currentTime = video.seekable.end(video.seekable.length - 1)
    if (video.paused) video.play().catch(() => {})
  }

  function toggleMute(): void {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
  }

  function handleVolumeChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const video = videoRef.current
    if (!video) return
    video.volume = Number(e.target.value)
    if (video.volume > 0 && video.muted) video.muted = false
  }

  // Windowed mode keeps the old behavior (click anywhere on a live channel toggles the channel
  // bar) unchanged — the header is always visible there, so there's no "reveal the chrome"
  // concern to split zones for. Fullscreen replaces that with a top/bottom split: the header
  // (translucent, hidden by default) is normally out of reach once it's hidden, so a click has
  // to land somewhere to bring it back, and the bottom zone doubles as the in-video EPG toggle
  // so it's reachable without a mouse ever leaving the video.
  function handlePlayAreaClick(e: React.MouseEvent<HTMLVideoElement>): void {
    if (isFullscreen) {
      if (e.clientY < FULLSCREEN_TOP_ZONE_PX) {
        setFullscreenHeaderVisible((v) => !v)
        return
      }
      if (e.clientY > window.innerHeight - FULLSCREEN_BOTTOM_ZONE_PX) {
        if (nowPlaying?.kind === 'live') setShowChannelBar(!showChannelBar)
        return
      }
      return
    }
    if (nowPlaying?.kind === 'live') setShowChannelBar(!showChannelBar)
  }

  return (
    <div className="player-overlay" ref={playerRef}>
      <div
        className={`player-header${isFullscreen ? ' player-header--overlay' : ''}${isFullscreen && !fullscreenHeaderVisible ? ' player-header--hidden' : ''}`}
        // Once revealed, the header itself covers the same top zone that opened it — a second
        // click there lands on the header, not the video underneath, so closing it again has to
        // be handled here too. Ignores clicks on an actual control (button/input) so pressing
        // e.g. Pause doesn't also immediately hide the header out from under the next click.
        onClick={(e) => {
          if (!isFullscreen) return
          if ((e.target as HTMLElement).closest('button, input')) return
          setFullscreenHeaderVisible(false)
        }}
      >
        <span className="player-title">{nowPlaying.name}</span>
        <div className="player-header-actions">
          {// Play/pause and skip are only added here for live TV — VOD/series already have full
          // scrubbing via the native <video controls> bar below, and duplicating a second set
          // of transport controls there would be redundant, not additive.
          nowPlaying.kind === 'live' && (
            <>
              <button className="player-control-btn" onClick={() => skip(-SKIP_SECONDS_LONG)} title={`Back ${SKIP_SECONDS_LONG}s`}>
                ⏪ 1m
              </button>
              <button className="player-control-btn" onClick={() => skip(-SKIP_SECONDS)} title={`Back ${SKIP_SECONDS}s`}>
                ⏪ {SKIP_SECONDS}s
              </button>
              <button className="player-control-btn" onClick={togglePlayPause} title={paused ? 'Play' : 'Pause'}>
                {paused ? '▶' : '⏸'}
              </button>
              <button className="player-control-btn" onClick={() => skip(SKIP_SECONDS)} title={`Forward ${SKIP_SECONDS}s`}>
                {SKIP_SECONDS}s ⏩
              </button>
              <button className="player-control-btn" onClick={() => skip(SKIP_SECONDS_LONG)} title={`Forward ${SKIP_SECONDS_LONG}s`}>
                1m ⏩
              </button>
              <button className="player-control-btn" onClick={goToLive} title="Jump to the current live transmission">
                🔴 Live
              </button>
            </>
          )}
          <div className="player-volume">
            <button className="player-control-btn" onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
              {muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
            </button>
            <input
              type="range"
              className="player-volume-slider"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={handleVolumeChange}
              title="Volume"
            />
          </div>
          <button
            className="player-control-btn"
            onClick={() => setStatsVisible((v) => !v)}
            title={statsVisible ? 'Hide stream stats' : 'Show stream stats'}
          >
            📊 Stats
          </button>
          <button className="player-control-btn" onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
            {isFullscreen ? '⛶ Exit Fullscreen' : '⛶ Fullscreen'}
          </button>
          <button className="player-pip" onClick={togglePip} title="Picture in picture">
            {pipActive ? '⧉ Exit PiP' : '⧉ PiP'}
          </button>
          <button className="player-close" onClick={stop}>
            ✕ Close
          </button>
        </div>
      </div>
      <div className="player-body">
        {!isOnline && (
          <div className="player-error">No network connection — will resume automatically once you're back online.</div>
        )}
        {playbackError && isOnline && <div className="player-error">{playbackError}</div>}
        {transcoding && !playbackError && (
          <div className="player-buffering">
            <div className="spinner" />
            <span>Fixing audio for this channel…</span>
          </div>
        )}
        {buffering && !playbackError && !transcoding && (
          <div className="player-buffering">
            <div className="spinner" />
            <span>Buffering…</span>
          </div>
        )}
        <video
          ref={videoRef}
          className="player-video"
          // Native controls fight the channel bar on live: clicking the bottom strip (where
          // native controls render) gets consumed by their shadow DOM and never reaches this
          // onClick, and clicking anywhere else still double-fires the browser's own
          // click-to-pause behavior alongside our toggle, freezing the stream. Seeking/pausing
          // isn't meaningful on a live feed anyway, so controls stay off for live and on for
          // VOD/series, which still need them to scrub.
          controls={nowPlaying.kind !== 'live'}
          autoPlay
          onClick={handlePlayAreaClick}
          // Live-only: VOD/series keep the browser's own native double-click-to-fullscreen
          // behavior on their <video controls>, and "back to the EPG" isn't a meaningful
          // concept for something that was never browsed from the EPG grid to begin with.
          onDoubleClick={() => {
            if (nowPlaying?.kind === 'live') stop()
          }}
        />
        {// Hidden while the channel bar/EPG is open (both anchor to the bottom edge, and the
        // channel bar already shows its own sense of "when" via the EPG grid's now-line) and
        // unless the cursor is actually near the bottom edge — see the mousemove effect above.
        nowPlaying.kind === 'live' && !showChannelBar && cursorNearBottom && <PlayerSeekBar videoRef={videoRef} />}
        {showChannelBar && <PlayerChannelBar />}
        {statsVisible && <PlayerStatsOverlay videoRef={videoRef} hlsRef={hlsRef} />}
      </div>
    </div>
  )
}
