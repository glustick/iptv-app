import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { useAppStore } from '../store/useAppStore'
import { PlayerChannelBar } from './PlayerChannelBar'
import { useTranscodeFallback } from '../lib/useTranscodeFallback'

const MAX_NETWORK_RETRIES = 4
const MAX_MEDIA_ERROR_RECOVERIES = 3
const MEDIA_ERROR_RESET_AFTER_MS = 15000
const PROGRESS_SAVE_INTERVAL_MS = 5000
const CHANNEL_BAR_AUTO_HIDE_MS = 6000

export function Player(): JSX.Element | null {
  const nowPlaying = useAppStore((s) => s.nowPlaying)
  const stop = useAppStore((s) => s.stop)
  const bufferProfile = useAppStore((s) => s.settings.bufferProfile)
  const episodeProgress = useAppStore((s) => s.episodeProgress)
  const updateEpisodeProgress = useAppStore((s) => s.updateEpisodeProgress)
  const isOnline = useAppStore((s) => s.isOnline)
  const showChannelBar = useAppStore((s) => s.channelBarOpen)
  const setShowChannelBar = useAppStore((s) => s.setChannelBarOpen)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [buffering, setBuffering] = useState(false)
  const [pipActive, setPipActive] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const wasOffline = useRef(false)
  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastStreamKeyRef = useRef<string | null>(null)

  const { transcoding, getSourceUrl, tryFallback, reset: resetTranscodeFallback, beginRun: beginTranscodeRun } =
    useTranscodeFallback()

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

    setPlaybackError(null)
    setBuffering(true)
    beginTranscodeRun()
    let networkRetryCount = 0
    let mediaErrorRecoveryCount = 0
    let mediaErrorResetTimer: ReturnType<typeof setTimeout> | null = null
    let progressInterval: ReturnType<typeof setInterval> | null = null

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
    }

    return () => {
      video.removeEventListener('waiting', handleWaiting)
      video.removeEventListener('playing', handlePlaying)
      video.removeEventListener('canplay', handleCanPlay)
      if (mediaErrorResetTimer) clearTimeout(mediaErrorResetTimer)
      if (progressInterval) clearInterval(progressInterval)
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

  // Keyboard shortcuts while the player is open: M to mute, arrows for volume. Escape is
  // deliberately not handled here — see App.tsx's single centralized Escape handler, which
  // already covers closing the channel bar and the player itself in the right priority order.
  useEffect(() => {
    if (!nowPlaying) return
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

  return (
    <div className="player-overlay">
      <div className="player-header">
        <span className="player-title">{nowPlaying.name}</span>
        <div className="player-header-actions">
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
          onClick={() => {
            if (nowPlaying.kind === 'live') setShowChannelBar(!showChannelBar)
          }}
        />
        {showChannelBar && <PlayerChannelBar />}
      </div>
    </div>
  )
}
